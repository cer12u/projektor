CREATE TABLE workspace(id TEXT PRIMARY KEY, epoch TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), change_seq INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX workspace_singleton ON workspace((1));
CREATE TABLE membership(principal_id TEXT PRIMARY KEY, kind TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, read_own INTEGER NOT NULL DEFAULT 1);
CREATE TABLE credential(id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES membership(principal_id), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, can_read INTEGER NOT NULL, can_write INTEGER NOT NULL);
CREATE TABLE project_grant(principal_id TEXT NOT NULL REFERENCES membership(principal_id), project_id TEXT NOT NULL, can_read INTEGER NOT NULL, can_write INTEGER NOT NULL, PRIMARY KEY(principal_id,project_id));
CREATE TABLE issue(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE activity(change_seq INTEGER PRIMARY KEY, issue_id TEXT REFERENCES issue(id), operation_id TEXT NOT NULL, actor_id TEXT NOT NULL, before_title TEXT NOT NULL, after_title TEXT NOT NULL, version INTEGER NOT NULL);
CREATE VIRTUAL TABLE issue_fts USING fts5(issue_id UNINDEXED, title, tokenize='trigram');
CREATE TABLE outbox(event_id TEXT PRIMARY KEY, change_seq INTEGER NOT NULL REFERENCES activity(change_seq), payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state='pending'));
CREATE TABLE operation(workspace_id TEXT NOT NULL REFERENCES workspace(id), principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, hash_version TEXT NOT NULL, payload_hash TEXT NOT NULL, entity_id TEXT NOT NULL, project_at_commit TEXT, result_json TEXT NOT NULL, PRIMARY KEY(workspace_id,principal_id,operation_id));

-- Query projection is explicit: legacy title-only rows have no fabricated assignment.
CREATE TABLE issue_queue(issue_id TEXT PRIMARY KEY REFERENCES issue(id), assignee_id TEXT REFERENCES membership(principal_id), status_category TEXT NOT NULL CHECK(status_category IN ('backlog','ready','in_progress','blocked','done','canceled')), priority INTEGER CHECK(priority IS NULL OR (typeof(priority)='integer' AND priority BETWEEN 0 AND 4)), created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0 AND created_at<=9007199254740991), restricted_read INTEGER NOT NULL DEFAULT 0 CHECK(restricted_read IN (0,1)));
CREATE INDEX issue_queue_order ON issue_queue(assignee_id, COALESCE(priority,5),created_at,issue_id);
CREATE TABLE issue_read_grant(issue_id TEXT NOT NULL REFERENCES issue(id),principal_id TEXT NOT NULL REFERENCES membership(principal_id),can_read INTEGER NOT NULL CHECK(can_read IN (0,1)),PRIMARY KEY(issue_id,principal_id));
CREATE TABLE query_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,cursor_key TEXT NOT NULL);
CREATE TRIGGER query_issue_insert AFTER INSERT ON issue BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_issue_update AFTER UPDATE ON issue BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_issue_delete AFTER DELETE ON issue BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_issue_queue_insert AFTER INSERT ON issue_queue BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_issue_queue_update AFTER UPDATE ON issue_queue BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_issue_queue_delete AFTER DELETE ON issue_queue BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_issue_read_grant_insert AFTER INSERT ON issue_read_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_issue_read_grant_update AFTER UPDATE ON issue_read_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_issue_read_grant_delete AFTER DELETE ON issue_read_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_project_grant_insert AFTER INSERT ON project_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_project_grant_update AFTER UPDATE ON project_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_project_grant_delete AFTER DELETE ON project_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_membership_insert AFTER INSERT ON membership BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_membership_update AFTER UPDATE ON membership BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_membership_delete AFTER DELETE ON membership BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_credential_insert AFTER INSERT ON credential BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_credential_update AFTER UPDATE ON credential BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_credential_delete AFTER DELETE ON credential BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;

-- Capability-v1 additions. Separate relations retain the frozen title-only row shape.
CREATE TABLE project(id TEXT PRIMARY KEY,title TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE principal_scope(principal_id TEXT NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(principal_id,scope));
CREATE TABLE credential_scope(credential_id TEXT NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(credential_id,scope));
CREATE TABLE shared_grant(principal_id TEXT PRIMARY KEY,can_read INTEGER NOT NULL,can_write INTEGER NOT NULL);
CREATE TABLE resource_access(resource_type TEXT NOT NULL CHECK(resource_type IN ('issue','wiki')),resource_id TEXT NOT NULL,policy_version INTEGER NOT NULL CHECK(policy_version>0),mode TEXT NOT NULL CHECK(mode IN ('inherit','restricted')),reader_principal_ids TEXT NOT NULL,writer_principal_ids TEXT NOT NULL,PRIMARY KEY(resource_type,resource_id));
CREATE TABLE access_snapshot(id TEXT PRIMARY KEY,resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,policy_version INTEGER NOT NULL,mode TEXT NOT NULL,reader_principal_ids TEXT NOT NULL,writer_principal_ids TEXT NOT NULL);
CREATE TABLE issue_content(issue_id TEXT PRIMARY KEY REFERENCES issue(id),body_revision_id TEXT,author_ref TEXT NOT NULL,parent_id TEXT REFERENCES issue(id),created_at INTEGER);
CREATE TABLE issue_entry(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issue(id),kind TEXT NOT NULL CHECK(kind IN ('comment','progress','transition')),version INTEGER NOT NULL CHECK(version>0),current_revision_id TEXT NOT NULL,author_ref TEXT NOT NULL,created_at INTEGER NOT NULL,edited_at INTEGER,deleted_at INTEGER);
CREATE TABLE source_mapping(id TEXT PRIMARY KEY,source_system TEXT NOT NULL,source_entity_type TEXT NOT NULL,source_entity_id TEXT NOT NULL,source_revision TEXT NOT NULL,target_resource_type TEXT NOT NULL,target_resource_id TEXT NOT NULL,raw_record TEXT NOT NULL,UNIQUE(source_system,source_entity_type,source_entity_id,source_revision));
CREATE TABLE content_revision(id TEXT PRIMARY KEY,resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,subresource_id TEXT,content_kind TEXT NOT NULL CHECK(content_kind IN ('issue_body','comment','wiki','progress','transition')),content_markdown TEXT NOT NULL,title TEXT,resource_version_at_commit INTEGER NOT NULL,original_author_ref TEXT NOT NULL,occurred_at_raw TEXT,occurred_at_normalized INTEGER,time_quality TEXT NOT NULL,source_edited_at_raw TEXT,recorded_at INTEGER NOT NULL,recorded_by TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('native','import')),source_mapping_id TEXT REFERENCES source_mapping(id),original_scope TEXT NOT NULL,access_snapshot_id TEXT REFERENCES access_snapshot(id));
CREATE INDEX content_revision_resource ON content_revision(resource_type,resource_id,recorded_at,id);
CREATE TABLE history_coverage(id TEXT PRIMARY KEY,resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,record_kind TEXT NOT NULL,source_watermark TEXT,interval_start_raw TEXT,interval_end_raw TEXT,coverage TEXT NOT NULL CHECK(coverage IN ('complete','partial','unknown')),missing_reason TEXT,source_evidence_ids TEXT NOT NULL,checked_backup_ids TEXT NOT NULL);
CREATE TABLE archive_grant(source_mapping_id TEXT NOT NULL REFERENCES source_mapping(id),principal_id TEXT NOT NULL,PRIMARY KEY(source_mapping_id,principal_id));
CREATE TABLE archive_access_audit(id TEXT PRIMARY KEY,source_mapping_id TEXT NOT NULL,principal_id TEXT NOT NULL,read_at INTEGER NOT NULL);
CREATE TABLE operation_scope(workspace_id TEXT NOT NULL,principal_id TEXT NOT NULL,operation_id TEXT NOT NULL,resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,original_scope TEXT NOT NULL,access_snapshot_id TEXT,creation_rejection INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(workspace_id,principal_id,operation_id));
CREATE TABLE content_activity(change_seq INTEGER PRIMARY KEY REFERENCES activity(change_seq),resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,command_type TEXT NOT NULL,subresource_id TEXT,revision_id TEXT,original_author_ref TEXT NOT NULL,recorded_by TEXT NOT NULL,metadata TEXT NOT NULL);
CREATE VIRTUAL TABLE content_fts USING fts5(resource_type UNINDEXED,resource_id UNINDEXED,subresource_id UNINDEXED,content,tokenize='trigram');
CREATE TRIGGER content_revision_no_update BEFORE UPDATE ON content_revision BEGIN SELECT RAISE(ABORT,'immutable content revision'); END;
CREATE TRIGGER content_revision_no_delete BEFORE DELETE ON content_revision BEGIN SELECT RAISE(ABORT,'immutable content revision'); END;
CREATE TRIGGER access_snapshot_no_update BEFORE UPDATE ON access_snapshot BEGIN SELECT RAISE(ABORT,'immutable access snapshot'); END;
CREATE TRIGGER access_snapshot_no_delete BEFORE DELETE ON access_snapshot BEGIN SELECT RAISE(ABORT,'immutable access snapshot'); END;
CREATE TRIGGER query_resource_access_insert AFTER INSERT ON resource_access BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_resource_access_update AFTER UPDATE ON resource_access BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_resource_access_delete AFTER DELETE ON resource_access BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TABLE project_issue_counter(project_id TEXT PRIMARY KEY REFERENCES project(id),next_number INTEGER NOT NULL CHECK(next_number>0));
CREATE TABLE issue_number(issue_id TEXT PRIMARY KEY REFERENCES issue(id),project_id TEXT NOT NULL REFERENCES project(id),number INTEGER NOT NULL CHECK(number>0),UNIQUE(project_id,number));

CREATE TABLE operation_targets(workspace_id TEXT NOT NULL,principal_id TEXT NOT NULL,operation_id TEXT NOT NULL,targets_json TEXT NOT NULL,PRIMARY KEY(workspace_id,principal_id,operation_id));
-- Integrated by the shared schema owner, not a separate store.
CREATE TABLE wiki_page(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,scope TEXT NOT NULL,parent_id TEXT,title TEXT NOT NULL,slug TEXT NOT NULL,version INTEGER NOT NULL,current_revision_id TEXT,summary TEXT,author_ref TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER);
CREATE TABLE wiki_alias(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,raw_key TEXT NOT NULL,comparison_key TEXT NOT NULL,target_page_id TEXT NOT NULL,created_at INTEGER NOT NULL,source_mapping_id TEXT);
CREATE UNIQUE INDEX wiki_alias_unique_path ON wiki_alias(scope,kind,comparison_key) WHERE kind IN ('slug','legacy_url');
CREATE UNIQUE INDEX wiki_alias_unique_title ON wiki_alias(scope,kind,comparison_key,target_page_id) WHERE kind='title';
CREATE TABLE wiki_revision_metadata(revision_id TEXT PRIMARY KEY,summary TEXT,restored_from_revision_id TEXT);
CREATE TABLE link_binding(id TEXT NOT NULL,version INTEGER NOT NULL,source_type TEXT NOT NULL,source_id TEXT NOT NULL,raw_target TEXT NOT NULL,lookup_scope TEXT NOT NULL,target_type TEXT,target_id TEXT,resolution TEXT NOT NULL,decision_provenance TEXT NOT NULL,PRIMARY KEY(id,version));
CREATE TABLE link_occurrence(id TEXT PRIMARY KEY,source_type TEXT NOT NULL,source_id TEXT NOT NULL,source_revision_id TEXT NOT NULL,ordinal INTEGER NOT NULL,raw_target TEXT NOT NULL,kind TEXT NOT NULL,binding_id TEXT NOT NULL,binding_version INTEGER NOT NULL,parser_version TEXT NOT NULL,UNIQUE(source_revision_id,ordinal));
CREATE TABLE link_view(id TEXT PRIMARY KEY,resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,resource_version INTEGER NOT NULL,source_revision_id TEXT NOT NULL,decisions TEXT NOT NULL,original_scope TEXT NOT NULL,access_snapshot_id TEXT NOT NULL,UNIQUE(resource_type,resource_id,resource_version));
CREATE TABLE revision_link_view(revision_id TEXT PRIMARY KEY,link_view_id TEXT NOT NULL);
CREATE TRIGGER link_binding_no_update BEFORE UPDATE ON link_binding BEGIN SELECT RAISE(ABORT,'immutable link binding'); END;
CREATE TRIGGER link_binding_no_delete BEFORE DELETE ON link_binding BEGIN SELECT RAISE(ABORT,'immutable link binding'); END;
CREATE TRIGGER link_occurrence_no_update BEFORE UPDATE ON link_occurrence BEGIN SELECT RAISE(ABORT,'immutable link occurrence'); END;
CREATE TRIGGER link_occurrence_no_delete BEFORE DELETE ON link_occurrence BEGIN SELECT RAISE(ABORT,'immutable link occurrence'); END;
CREATE TRIGGER link_view_no_update BEFORE UPDATE ON link_view BEGIN SELECT RAISE(ABORT,'immutable link view'); END;
CREATE TRIGGER link_view_no_delete BEFORE DELETE ON link_view BEGIN SELECT RAISE(ABORT,'immutable link view'); END;
CREATE TRIGGER revision_link_view_no_update BEFORE UPDATE ON revision_link_view BEGIN SELECT RAISE(ABORT,'immutable revision link view'); END;
CREATE TRIGGER revision_link_view_no_delete BEFORE DELETE ON revision_link_view BEGIN SELECT RAISE(ABORT,'immutable revision link view'); END;

-- I2 durable runtime-neutral workflow. Claim slot tombstones are never removed.
CREATE TABLE execution_claim(issue_id TEXT PRIMARY KEY REFERENCES issue(id),claim_id TEXT NOT NULL,principal_id TEXT NOT NULL,runtime_instance_id TEXT NOT NULL,attempt_id TEXT NOT NULL UNIQUE,fencing_token TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),lease_expires_at INTEGER NOT NULL,renew_not_before INTEGER NOT NULL,released_at INTEGER,workspace_epoch TEXT NOT NULL);
CREATE TABLE execution_attempt(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issue(id),claim_id TEXT NOT NULL UNIQUE,principal_id TEXT NOT NULL,runtime_instance_id TEXT NOT NULL,agent_definition_id TEXT NOT NULL,agent_definition_revision TEXT NOT NULL,fencing_token TEXT NOT NULL,workspace_epoch TEXT NOT NULL,started_at INTEGER NOT NULL);
CREATE TABLE workflow_entry(entry_id TEXT PRIMARY KEY REFERENCES issue_entry(id),payload TEXT NOT NULL,attempt_id TEXT REFERENCES execution_attempt(id),original_scope TEXT NOT NULL,access_snapshot_id TEXT NOT NULL REFERENCES access_snapshot(id));
CREATE TABLE resolution_record(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issue(id),kind TEXT NOT NULL CHECK(kind IN ('done','canceled','reopened')),time_json TEXT NOT NULL,record_nature TEXT NOT NULL CHECK(record_nature IN ('transition','state_observation')),original_author_ref TEXT NOT NULL,source_sequence TEXT,correlation_group_id TEXT,source_mapping_id TEXT,recorded_at INTEGER NOT NULL,recorded_by TEXT NOT NULL,entry_id TEXT NOT NULL REFERENCES issue_entry(id),original_scope TEXT NOT NULL,access_snapshot_id TEXT NOT NULL REFERENCES access_snapshot(id));
CREATE TABLE issue_resolution(issue_id TEXT PRIMARY KEY REFERENCES issue(id),resolution_kind TEXT CHECK(resolution_kind IN ('done','canceled')),resolved_at INTEGER,current_record_id TEXT REFERENCES resolution_record(id),CHECK((resolution_kind IS NULL AND resolved_at IS NULL AND current_record_id IS NULL) OR (resolution_kind IS NOT NULL AND current_record_id IS NOT NULL)));
CREATE TABLE issue_alias(project_id TEXT NOT NULL,number INTEGER NOT NULL,issue_id TEXT NOT NULL REFERENCES issue(id),PRIMARY KEY(project_id,number));
CREATE TRIGGER execution_attempt_no_update BEFORE UPDATE ON execution_attempt BEGIN SELECT RAISE(ABORT,'immutable execution attempt'); END;
CREATE TRIGGER execution_attempt_no_delete BEFORE DELETE ON execution_attempt BEGIN SELECT RAISE(ABORT,'immutable execution attempt'); END;
CREATE TRIGGER execution_claim_no_delete BEFORE DELETE ON execution_claim BEGIN SELECT RAISE(ABORT,'claim tombstone retained'); END;
CREATE TRIGGER workflow_entry_no_update BEFORE UPDATE ON workflow_entry BEGIN SELECT RAISE(ABORT,'immutable workflow entry'); END;
CREATE TRIGGER workflow_entry_no_delete BEFORE DELETE ON workflow_entry BEGIN SELECT RAISE(ABORT,'immutable workflow entry'); END;
CREATE TRIGGER resolution_record_no_update BEFORE UPDATE ON resolution_record BEGIN SELECT RAISE(ABORT,'immutable resolution record'); END;
CREATE TRIGGER resolution_record_no_delete BEFORE DELETE ON resolution_record BEGIN SELECT RAISE(ABORT,'immutable resolution record'); END;
CREATE TABLE effect_checkpoint(entry_id TEXT PRIMARY KEY REFERENCES workflow_entry(entry_id),issue_id TEXT NOT NULL REFERENCES issue(id),effect_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('external_outcome_unknown','reconciled')),reference TEXT NOT NULL,original_attempt_id TEXT REFERENCES execution_attempt(id));
CREATE INDEX effect_checkpoint_issue ON effect_checkpoint(issue_id,effect_id);
CREATE TRIGGER effect_checkpoint_no_update BEFORE UPDATE ON effect_checkpoint BEGIN SELECT RAISE(ABORT,'immutable effect checkpoint'); END;
CREATE TRIGGER effect_checkpoint_no_delete BEFORE DELETE ON effect_checkpoint BEGIN SELECT RAISE(ABORT,'immutable effect checkpoint'); END;

CREATE TRIGGER query_principal_scope_insert AFTER INSERT ON principal_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER query_principal_scope_update AFTER UPDATE ON principal_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER query_principal_scope_delete AFTER DELETE ON principal_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER query_credential_scope_insert AFTER INSERT ON credential_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER query_credential_scope_update AFTER UPDATE ON credential_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER query_credential_scope_delete AFTER DELETE ON credential_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;

-- Reviewed normalized Wiki additive schema
CREATE TRIGGER wiki_revision_metadata_no_update BEFORE UPDATE ON wiki_revision_metadata BEGIN SELECT RAISE(ABORT,'immutable wiki revision metadata'); END;
CREATE TRIGGER wiki_revision_metadata_no_delete BEFORE DELETE ON wiki_revision_metadata BEGIN SELECT RAISE(ABORT,'immutable wiki revision metadata'); END;
CREATE TRIGGER wiki_alias_no_update BEFORE UPDATE ON wiki_alias BEGIN SELECT RAISE(ABORT,'immutable wiki alias'); END;
CREATE TRIGGER wiki_alias_no_delete BEFORE DELETE ON wiki_alias BEGIN SELECT RAISE(ABORT,'immutable wiki alias'); END;
CREATE TABLE link_view_decision(link_view_id TEXT NOT NULL,ordinal INTEGER NOT NULL,occurrence_id TEXT NOT NULL,binding_id TEXT NOT NULL,binding_version INTEGER NOT NULL,PRIMARY KEY(link_view_id,ordinal),UNIQUE(link_view_id,occurrence_id));
CREATE TRIGGER link_view_decision_no_update BEFORE UPDATE ON link_view_decision BEGIN SELECT RAISE(ABORT,'immutable link view decision'); END;
CREATE TRIGGER link_view_decision_no_delete BEFORE DELETE ON link_view_decision BEGIN SELECT RAISE(ABORT,'immutable link view decision'); END;

-- Explicit management authority; no read/write grant implies manage.
CREATE TABLE scope_manage_grant(principal_id TEXT NOT NULL REFERENCES membership(principal_id),scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','workspace_shared')),scope_id TEXT NOT NULL,can_manage INTEGER NOT NULL CHECK(can_manage IN (0,1)),PRIMARY KEY(principal_id,scope_kind,scope_id));
CREATE TABLE resource_access_identity(resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,access_policy_id TEXT NOT NULL UNIQUE,PRIMARY KEY(resource_type,resource_id),FOREIGN KEY(resource_type,resource_id) REFERENCES resource_access(resource_type,resource_id));
CREATE TRIGGER access_identity_no_update BEFORE UPDATE ON resource_access_identity BEGIN SELECT RAISE(ABORT,'immutable policy identity'); END;
CREATE TRIGGER access_identity_no_delete BEFORE DELETE ON resource_access_identity BEGIN SELECT RAISE(ABORT,'immutable policy identity'); END;
CREATE TRIGGER query_manage_insert AFTER INSERT ON scope_manage_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_manage_update AFTER UPDATE ON scope_manage_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_manage_delete AFTER DELETE ON scope_manage_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
