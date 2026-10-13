"""SQLite's own parser/authorizer, not a regex table-name extractor.

Compile all named queries and trigger/view/FK paths with EXPLAIN (no mutations).
Build each owner in isolation, then also compile against the combined schema so
foreign references cannot hide behind missing fixture data or an empty table.
"""
import json
import re
import sqlite3
import sys


def fail(rule, message):
    raise ValueError(f"{rule}: {message}")


def statements(sql):
    parts, pending = [], ""
    for char in sql:
        pending += char
        if char == ";" and sqlite3.complete_statement(pending):
            parts.append(pending.strip())
            pending = ""
    if pending.strip():
        if not sqlite3.complete_statement(pending + ";"):
            fail("sql-static", "incomplete SQL")
        parts.append(pending.strip())
    return parts


DDL = {sqlite3.SQLITE_CREATE_INDEX, sqlite3.SQLITE_CREATE_TABLE,
       sqlite3.SQLITE_CREATE_TRIGGER, sqlite3.SQLITE_CREATE_VIEW,
       sqlite3.SQLITE_DROP_INDEX, sqlite3.SQLITE_DROP_TABLE,
       sqlite3.SQLITE_DROP_TRIGGER, sqlite3.SQLITE_DROP_VIEW,
       sqlite3.SQLITE_ALTER_TABLE, sqlite3.SQLITE_CREATE_VTABLE,
       sqlite3.SQLITE_DROP_VTABLE, sqlite3.SQLITE_REINDEX}
TEMP = {sqlite3.SQLITE_CREATE_TEMP_INDEX, sqlite3.SQLITE_CREATE_TEMP_TABLE,
        sqlite3.SQLITE_CREATE_TEMP_TRIGGER, sqlite3.SQLITE_CREATE_TEMP_VIEW,
        sqlite3.SQLITE_DROP_TEMP_INDEX, sqlite3.SQLITE_DROP_TEMP_TABLE,
        sqlite3.SQLITE_DROP_TEMP_TRIGGER, sqlite3.SQLITE_DROP_TEMP_VIEW}
ACCESS = {sqlite3.SQLITE_READ, sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE}
SYSTEM = {"sqlite_master", "sqlite_schema", "sqlite_temp_master", "sqlite_temp_schema"}


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def guard(owner, storage, migration=False):
    allowed = set(storage["tables"]) | set(storage["objects"])
    violations = []

    def auth(action, first, second, database, source):
        reason = None
        if action in TEMP or action in {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_PRAGMA, sqlite3.SQLITE_TRANSACTION, sqlite3.SQLITE_SAVEPOINT}:
            reason = "prohibited SQL operation"
        elif action == sqlite3.SQLITE_FUNCTION and second in {"load_extension", "readfile", "writefile"}:
            reason = "prohibited SQL function"
        elif action in DDL:
            if not migration:
                reason = "DDL outside migration"
            else:
                names = [second] if action == sqlite3.SQLITE_ALTER_TABLE else [first]
                if action in {sqlite3.SQLITE_CREATE_INDEX, sqlite3.SQLITE_CREATE_TRIGGER, sqlite3.SQLITE_DROP_INDEX, sqlite3.SQLITE_DROP_TRIGGER}:
                    names.append(second)
                for name in names:
                    if name and name not in allowed and not name.startswith("sqlite_autoindex_"):
                        reason = f"schema object {name} is not owned by {owner}"
                if action == sqlite3.SQLITE_CREATE_VTABLE and second != "fts5":
                    reason = "unapproved virtual table module"
        elif action in ACCESS:
            if first not in allowed:
                if not (migration and first in SYSTEM):
                    reason = f"table {first} is not owned by {owner} (via {source or 'statement'})"
        if reason:
            violations.append(reason)
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    return auth, violations


def execute_checked(db, owner, storage, sql, migration=False):
    auth, violations = guard(owner, storage, migration)
    db.set_authorizer(auth)
    try:
        if migration:
            db.execute(sql)
        else:
            try:
                db.execute("EXPLAIN " + sql)
            except sqlite3.ProgrammingError as error:
                match = re.search(r"uses (\d+)", str(error))
                if not match:
                    raise
                count = int(match[1])
                if count > 100:
                    fail("bind-limit", f"{owner}: {count} parameters")
                db.execute("EXPLAIN " + sql, [None] * count)
    except sqlite3.Error as error:
        fail("sql-ownership", f"{owner}: {'; '.join(violations) or str(error)}")
    finally:
        db.set_authorizer(None)


def schema_rows(db):
    return db.execute("SELECT type, name, tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").fetchall()


def probe(db, owner, storage):
    for kind, name, _ in schema_rows(db):
        if name not in storage["tables"] + storage["objects"]:
            continue
        if kind in {"table", "view"}:
            execute_checked(db, owner, storage, f"SELECT * FROM {quote(name)}")
        if kind == "table":
            # Compile triggers on INSERT/UPDATE/DELETE even with no rows and WHEN false.
            columns = [row[1] for row in db.execute(f"PRAGMA table_xinfo({quote(name)})") if row[6] == 0]
            names = ', '.join(map(quote, columns))
            nulls = ', '.join(['NULL'] * len(columns))
            execute_checked(db, owner, storage, f"INSERT INTO {quote(name)} ({names}) VALUES ({nulls})")
            execute_checked(db, owner, storage, f"UPDATE {quote(name)} SET " + ', '.join(f"{quote(c)} = {quote(c)}" for c in columns))
            execute_checked(db, owner, storage, f"DELETE FROM {quote(name)}")


def validate(data):
    ownership = {}
    for owner, storage in data.items():
        for name in storage["tables"] + storage["objects"]:
            if name in ownership:
                fail("schema", f"duplicate owner for {name}")
            if not name.startswith(storage["prefix"]):
                fail("schema", f"{owner}: object {name} outside prefix")
            ownership[name] = owner
        if not set(storage["globalTables"]).issubset(storage["tables"]):
            fail("schema", f"{owner}: unknown global table")
    combined = sqlite3.connect(":memory:")
    combined.execute("PRAGMA foreign_keys=ON")
    isolated_dbs = {}
    for owner, storage in data.items():
        isolated = sqlite3.connect(":memory:")
        isolated.execute("PRAGMA foreign_keys=ON")
        for migration in storage["migrations"]:
            migration["statements"] = statements(migration.pop("sql"))
            for sql in migration["statements"]:
                execute_checked(isolated, owner, storage, sql, True)
                execute_checked(combined, owner, storage, sql, True)
        rows = schema_rows(isolated)
        actual = {name for _, name, _ in rows}
        declared = set(storage["tables"] + storage["objects"])
        if actual != declared:
            fail("schema", f"{owner}: manifest/schema drift: {sorted(actual ^ declared)}")
        for kind, name, table in rows:
            if ownership.get(table) != owner:
                fail("schema", f"{owner}: {name} targets foreign {table}")
            if kind != "table":
                continue
            if name not in storage["tables"]:
                fail("schema", f"{owner}: table {name} must be registered as table")
            for fk in isolated.execute(f"PRAGMA foreign_key_list({quote(name)})"):
                if ownership.get(fk[2]) != owner:
                    fail("schema", f"cross-owner FK: {name} -> {fk[2]}")
            if name in storage["globalTables"]:
                continue
            info = isolated.execute(f"PRAGMA table_info({quote(name)})").fetchall()
            if not any(c[1] == 'workspace_id' and c[3] for c in info):
                fail("schema", f"{name}: missing NOT NULL workspace_id")
            uniques = [r for r in isolated.execute(f"PRAGMA index_list({quote(name)})") if r[2]]
            if not uniques:
                fail("schema", f"{name}: missing tenant-local unique key")
            for index in uniques:
                cols = [r[2] for r in isolated.execute(f"PRAGMA index_info({quote(index[1])})")]
                if 'workspace_id' not in cols:
                    fail("schema", f"{name}: unique key {index[1]} omits workspace_id")
        isolated_dbs[owner] = isolated
    for owner, storage in data.items():
        probe(combined, owner, storage)
        for name, sql in storage["queries"].items():
            if len(statements(sql)) != 1:
                fail("sql-static", f"{owner}/{name}: multi-statement query")
            execute_checked(combined, owner, storage, sql)
        isolated = isolated_dbs[owner]
        probe(isolated, owner, storage)
        for sql in storage["queries"].values():
            execute_checked(isolated, owner, storage, sql)
        isolated.close()
    combined.close()
    return data


if __name__ == '__main__':
    try:
        print(json.dumps(validate(json.load(sys.stdin))))
    except (ValueError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
