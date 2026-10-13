-- New Wiki and comments use the existing operation_results / checked mutation batch.
CREATE TABLE content_documents (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('wiki','comment')),
  project_id TEXT NOT NULL,
  parent_kind TEXT CHECK(parent_kind IN ('issue','wiki')),
  parent_id TEXT,
  body TEXT NOT NULL CHECK(length(trim(body))>0 AND length(CAST(body AS BLOB))<=8192),
  revision INTEGER NOT NULL CHECK(revision>=1),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL AND updated_at>=created_at),
  before_body TEXT,
  UNIQUE(kind,id),
  CHECK((kind='wiki' AND parent_kind IS NULL AND parent_id IS NULL)
    OR (kind='comment' AND parent_kind IS NOT NULL AND parent_id IS NOT NULL))
);
CREATE INDEX content_project ON content_documents(project_id,kind,parent_kind,parent_id,created_at,id);
CREATE TRIGGER content_fixed_identity BEFORE UPDATE ON content_documents
WHEN NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.project_id<>OLD.project_id
 OR NEW.created_at<>OLD.created_at OR NEW.parent_kind IS NOT OLD.parent_kind OR NEW.parent_id IS NOT OLD.parent_id
BEGIN SELECT RAISE(ABORT,'content identity is immutable'); END;
CREATE TRIGGER comment_parent_insert BEFORE INSERT ON content_documents WHEN NEW.kind='comment' AND
 ((NEW.parent_kind='issue' AND NOT EXISTS(SELECT 1 FROM issues WHERE id=NEW.parent_id AND project_id=NEW.project_id))
 OR (NEW.parent_kind='wiki' AND NOT EXISTS(SELECT 1 FROM content_documents WHERE id=NEW.parent_id AND kind='wiki' AND project_id=NEW.project_id)))
BEGIN SELECT RAISE(ABORT,'comment parent unavailable'); END;
CREATE TABLE content_history (
  content_kind TEXT NOT NULL,
  content_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  operation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES principals(id),
  actor_name TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK(change_kind IN ('wiki.create','wiki.edit','comment.create','comment.edit')),
  before_body TEXT,
  after_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(content_kind,content_id,revision),
  UNIQUE(actor_id,operation_id),
  FOREIGN KEY(content_kind,content_id) REFERENCES content_documents(kind,id),
  FOREIGN KEY(actor_id,operation_id) REFERENCES operation_results(principal_id,operation_id),
  CHECK((revision=1 AND before_body IS NULL AND change_kind=content_kind||'.create')
    OR (revision>1 AND before_body IS NOT NULL AND change_kind=content_kind||'.edit'))
);
CREATE TRIGGER content_history_no_update BEFORE UPDATE ON content_history
BEGIN SELECT RAISE(ABORT,'content history is immutable'); END;
CREATE TRIGGER content_history_no_delete BEFORE DELETE ON content_history
BEGIN SELECT RAISE(ABORT,'content history is immutable'); END;
