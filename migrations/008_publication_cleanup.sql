ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('download','index','publish','cleanup','unpublish'));
ALTER TABLE publications ADD COLUMN removed_at timestamptz;
