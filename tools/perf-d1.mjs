// Probe-only binding wrapper. A wave is a set of overlapping D1 calls; the
// wave count estimates the longest sequential dependency chain.
export function countD1(db, clock = () => performance.now(), names = new Map()) {
  const raw = new WeakMap();
  const labels = new WeakMap();
  const intervals = [];
  const stats = { roundTrips: 0, statements: 0, rowsRead: 0, sequentialWaves: 0 };
  const statementCounts = new Map();
  let active = 0;
  async function measure(statements, run, labels = []) {
    const start = clock();
    if (active === 0) stats.sequentialWaves++;
    active++;
    stats.roundTrips++;
    stats.statements += statements;
    for (const label of labels) statementCounts.set(label, (statementCounts.get(label) ?? 0) + 1);
    try {
      const result = await run();
      for (const item of Array.isArray(result) ? result : [result])
        stats.rowsRead += Number(item?.meta?.rows_read ?? 0);
      return result;
    } finally {
      intervals.push([start, clock()]);
      active--;
    }
  }
  const binding = {
    prepare(sql) {
      const statement = db.prepare(sql);
      const label = names.get(sql) ?? "uncataloged";
      const wrapped = {
        bind(...values) {
          const bound = statement.bind(...values);
          return wrapStatement(bound, label);
        },
        all() {
          return measure(1, () => statement.all(), [label]);
        },
        first(column) {
          return measure(1, () => statement.first(column), [label]);
        },
        run() {
          return measure(1, () => statement.run(), [label]);
        },
        raw(options) {
          return measure(1, () => statement.raw(options), [label]);
        },
      };
      raw.set(wrapped, statement);
      labels.set(wrapped, label);
      return wrapped;
    },
    batch(statements) {
      return measure(
        statements.length,
        () => db.batch(statements.map((s) => raw.get(s))),
        statements.map((s) => labels.get(s) ?? "uncataloged"),
      );
    },
    exec(sql) {
      return measure(1, () => db.exec(sql));
    },
    dump() {
      return db.dump();
    },
  };
  function wrapStatement(statement, label) {
    const wrapped = {
      bind(...values) {
        return wrapStatement(statement.bind(...values), label);
      },
      all() {
        return measure(1, () => statement.all(), [label]);
      },
      first(column) {
        return measure(1, () => statement.first(column), [label]);
      },
      run() {
        return measure(1, () => statement.run(), [label]);
      },
      raw(options) {
        return measure(1, () => statement.raw(options), [label]);
      },
    };
    raw.set(wrapped, statement);
    labels.set(wrapped, label);
    return wrapped;
  }
  return {
    binding,
    reset() {
      stats.roundTrips = 0;
      stats.statements = 0;
      stats.rowsRead = 0;
      stats.sequentialWaves = 0;
      intervals.length = 0;
      active = 0;
      statementCounts.clear();
    },
    snapshot() {
      const sorted = intervals.toSorted((a, b) => a[0] - b[0]);
      let busyMs = 0,
        end = -Infinity;
      for (const [start, stop] of sorted) {
        busyMs += Math.max(0, stop - Math.max(start, end));
        end = Math.max(end, stop);
      }
      return {
        ...stats,
        d1BusyMs: busyMs,
        statementsByName: Object.fromEntries([...statementCounts].sort((a, b) => b[1] - a[1])),
      };
    },
  };
}
