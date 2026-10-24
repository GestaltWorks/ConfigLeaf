-- sql/schema.sql. Portable across SQLite (sql.js, SAMPLE_MODE) and PostgreSQL (live; the Postgres
-- is registered in Zetaris as one datasource). Timestamps are ISO 8601 UTC text so they compare and
-- sort identically in both engines. No SERIAL, no JSON columns, no booleans (INTEGER 0/1).
CREATE TABLE IF NOT EXISTS collection_run (
  run_id         TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  surface        TEXT NOT NULL,      -- linux.etc | linux.nginx | cloudflare.dns | cloudflare.audit | inventory
  host           TEXT,               -- linux surfaces only
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  expected_count INTEGER,            -- population asserted BEFORE collecting (the DQ gate input)
  observed_count INTEGER,
  status         TEXT NOT NULL       -- running (between Store.beginRun and finishRun) | complete | partial | failed
);
CREATE TABLE IF NOT EXISTS observation (
  obs_id         TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  surface        TEXT NOT NULL,
  host           TEXT,
  object_id      TEXT NOT NULL,      -- file path or vendor object id
  setting_path   TEXT NOT NULL,      -- dotted path inside the object
  value_hash     TEXT NOT NULL,      -- sha256 of the canonical value
  value_redacted TEXT,               -- redacted text for display; raw values are never stored
  refers_to_type TEXT,               -- dns_name | ip | upstream | ip_list | ... (null when the value references nothing)
  refers_to_id   TEXT,
  observed_at    TEXT NOT NULL,
  source         TEXT NOT NULL,      -- ssh | cloudflare | backup | approved
  authority      INTEGER NOT NULL    -- 100 live vendor API/SSH, 40 backup artifact, 20 approved copy
);
CREATE TABLE IF NOT EXISTS approved_setting (
  approval_id    TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  surface        TEXT NOT NULL,
  host           TEXT,
  object_id      TEXT NOT NULL,
  setting_path   TEXT NOT NULL,
  value_hash     TEXT NOT NULL,
  approved_at    TEXT NOT NULL,
  approved_by    TEXT,
  note           TEXT
);
CREATE TABLE IF NOT EXISTS backup_snapshot (
  snapshot_id    TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  host           TEXT NOT NULL,
  kind           TEXT NOT NULL,      -- export (a config tarball or a folder of copies) | restic | etckeeper
  taken_at       TEXT NOT NULL,
  source_ref     TEXT                -- the tarball or folder path (redacted), restic snapshot id or etckeeper commit
);
CREATE TABLE IF NOT EXISTS backup_item (
  snapshot_id    TEXT NOT NULL,
  object_id      TEXT NOT NULL,
  setting_path   TEXT NOT NULL,
  value_hash     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dns_record (
  record_id      TEXT NOT NULL,      -- Cloudflare record id; not unique across runs
  run_id         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  zone           TEXT NOT NULL,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL,      -- A | AAAA | CNAME | ...
  content        TEXT NOT NULL,
  ttl            INTEGER,
  proxied        INTEGER,            -- 0/1
  observed_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_event (
  event_id       TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  source         TEXT NOT NULL,      -- cloudflare | etckeeper | journal
  actor          TEXT,               -- redacted/pseudonymous; null when the log has none
  action         TEXT NOT NULL,
  resource_type  TEXT,
  resource_id    TEXT,
  old_value      TEXT,
  new_value      TEXT,
  occurred_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_asset (
  asset_id       TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  host           TEXT,
  address        TEXT NOT NULL,      -- IPv4/IPv6 literal or hostname as the inventory records it
  kind           TEXT,               -- vps | lb | cdn | office | ...
  source         TEXT NOT NULL,      -- inventory file / REST table
  observed_at    TEXT NOT NULL
);
