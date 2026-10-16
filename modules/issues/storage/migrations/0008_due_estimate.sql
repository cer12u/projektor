ALTER TABLE issues_issues ADD COLUMN estimate REAL;
ALTER TABLE issues_issues ADD COLUMN due_date TEXT;
CREATE INDEX issues_due_date ON issues_issues(workspace_id,due_date);
CREATE TRIGGER issues_check_due_estimate_insert BEFORE INSERT ON issues_issues
WHEN (NEW.estimate IS NOT NULL AND (NEW.estimate < 0 OR NEW.estimate > 1000))
  OR (NEW.due_date IS NOT NULL AND (NEW.due_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' OR date(NEW.due_date) IS NOT NEW.due_date))
BEGIN SELECT RAISE(ABORT,'invalid due date or estimate'); END;
CREATE TRIGGER issues_check_due_estimate_update BEFORE UPDATE ON issues_issues
WHEN (NEW.estimate IS NOT NULL AND (NEW.estimate < 0 OR NEW.estimate > 1000))
  OR (NEW.due_date IS NOT NULL AND (NEW.due_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' OR date(NEW.due_date) IS NOT NEW.due_date))
BEGIN SELECT RAISE(ABORT,'invalid due date or estimate'); END;
