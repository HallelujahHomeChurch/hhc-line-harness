ALTER TABLE job_wakes ADD COLUMN fence bigint NOT NULL DEFAULT 0;
ALTER TABLE job_wakes ADD COLUMN lease_until timestamptz;
