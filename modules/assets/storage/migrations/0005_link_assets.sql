ALTER TABLE assets_blobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'file';
ALTER TABLE assets_blobs ADD COLUMN url TEXT;
ALTER TABLE assets_blobs ADD COLUMN title TEXT;
CREATE TRIGGER assets_check_blobs_insert BEFORE INSERT ON assets_blobs WHEN NEW.kind NOT IN ('file','link') BEGIN SELECT RAISE(ABORT,'invalid asset kind'); END;
CREATE TRIGGER assets_check_blobs_update BEFORE UPDATE ON assets_blobs WHEN NEW.kind NOT IN ('file','link') BEGIN SELECT RAISE(ABORT,'invalid asset kind'); END;
