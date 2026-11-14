ALTER TABLE jobs ADD COLUMN lease_recoveries integer NOT NULL DEFAULT 0;
ALTER TABLE model_budget_alerts ADD COLUMN lease_until timestamptz,
 ADD COLUMN fence bigint NOT NULL DEFAULT 0,
 ADD COLUMN acknowledged_at timestamptz;
