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
-- The MSP's policy as data, versioned: the Decider reads the highest version of each
-- (tenant_id, surface, object_glob, setting_glob) family. Globs and note pass through the redactor
-- when stored, so a name typed in a policy carries the pseudonym the observations carry.
CREATE TABLE IF NOT EXISTS policy_rule (
  rule_id        TEXT PRIMARY KEY,   -- stableId("rule", tenant_id, surface, object_glob, setting_glob, version)
  tenant_id      TEXT NOT NULL,      -- a tenant id | * (every tenant)
  surface        TEXT NOT NULL,      -- linux.nginx | cloudflare.dns | *
  object_glob    TEXT NOT NULL,      -- * any run within one path segment, ** any run across segments, ? one character
  setting_glob   TEXT NOT NULL,      -- same glob rule, over setting_path
  criticality    TEXT NOT NULL,      -- critical | high | normal | low
  lock           INTEGER NOT NULL,   -- 0/1; 1 = a drifted setting is rolled back at the next cycle
  on_drift       TEXT NOT NULL,      -- rollback | investigate | adopt | hold
  on_no_copy     TEXT NOT NULL,      -- investigate_ticket | ticket | adopt
  hold_max_hours INTEGER NOT NULL,   -- a HOLD under this rule expires this many hours after it is decided
  alert          TEXT NOT NULL,      -- always | on_fix | never
  psa_priority   TEXT NOT NULL,      -- P1 | P2 | P3 | P4
  version        INTEGER NOT NULL,
  author         TEXT NOT NULL,
  since          TEXT NOT NULL,      -- ISO 8601 UTC, the millisecond form
  note           TEXT
);
-- One row per object per collection run the vault committed (src/vault/).
CREATE TABLE IF NOT EXISTS vault_copy (
  copy_id        TEXT PRIMARY KEY,   -- stableId("copy", run_id, object_id)
  tenant_id      TEXT NOT NULL,
  surface        TEXT NOT NULL,      -- linux.nginx | cloudflare.dns
  host           TEXT,               -- null for cloudflare.dns
  object_id      TEXT NOT NULL,      -- the redacted object id the observation row carries
  run_id         TEXT NOT NULL,
  git_commit     TEXT NOT NULL,      -- the vault commit that holds the copy
  blob_sha256    TEXT NOT NULL,      -- sha256:<64 hex> of the exact bytes; equals the file observation's value_hash
  taken_at       TEXT NOT NULL,
  source         TEXT NOT NULL       -- collector
);
-- One row per vault copy per validation (src/validate/).
CREATE TABLE IF NOT EXISTS copy_validation (
  validation_id  TEXT PRIMARY KEY,   -- stableId("val", copy_id, validator, validated_at)
  copy_id        TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  validator      TEXT NOT NULL,      -- nginx-t | cf-schema
  result         TEXT NOT NULL,      -- ok | ok_with_gaps | fail
  missing_dependencies TEXT NOT NULL, -- newline-separated redacted paths or names; '' when none
  output_redacted TEXT NOT NULL,     -- the validator's output through the redactor, first 2000 characters; '' when none
  validated_at   TEXT NOT NULL
);
-- One row per kind per target per probe run (src/probe/); the run is a collection_run of surface probe.
CREATE TABLE IF NOT EXISTS probe (
  probe_id       TEXT PRIMARY KEY,   -- stableId("probe", run_id, kind, target)
  run_id         TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  kind           TEXT NOT NULL,      -- http | dns | tls
  target         TEXT NOT NULL,      -- the redacted name
  expected       TEXT NOT NULL,
  observed       TEXT NOT NULL,      -- redacted
  status         TEXT NOT NULL,      -- ok | fail
  latency_ms     INTEGER,
  observed_at    TEXT NOT NULL
);
-- The ledger: one row per finding per pass, about the live value the decision is about.
CREATE TABLE IF NOT EXISTS disposition (
  disposition_id TEXT PRIMARY KEY,   -- stableId("disp", tenant_id, surface, host, object_id, setting_path, value_hash, finding_id, run_id)
  tenant_id      TEXT NOT NULL,
  surface        TEXT NOT NULL,
  host           TEXT,
  object_id      TEXT NOT NULL,
  setting_path   TEXT NOT NULL,
  value_hash     TEXT NOT NULL,      -- the live value decided on; a later change to the object is a new value and a new decision
  verb           TEXT NOT NULL,      -- ADOPT | HOLD | ESCALATE | ROLLBACK | FIX
  reason         TEXT NOT NULL,      -- one plain sentence
  expires_at     TEXT,               -- set on every HOLD
  decided_by     TEXT NOT NULL,      -- policy | operator | judge | default
  rule_id        TEXT,               -- the policy_rule that decided, when one did
  finding_id     TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  decided_at     TEXT NOT NULL
);
-- What the agent did about a disposition (filled by the write paths behind --apply).
CREATE TABLE IF NOT EXISTS action (
  action_id      TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  kind           TEXT NOT NULL,      -- rollback_file | revert_record | fix | investigate
  target         TEXT NOT NULL,      -- the redacted object or record
  before_hash    TEXT,
  after_hash     TEXT,
  vault_commit   TEXT,
  verification   TEXT NOT NULL,      -- probe ids, comma-separated; '' when none
  receipts       TEXT NOT NULL,      -- receipt ids, comma-separated; '' when none
  status         TEXT NOT NULL,      -- done | failed | refused
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  disposition_id TEXT NOT NULL
);
-- The PSA ticket a disposition or an action opened (filled by the PSA adapter).
CREATE TABLE IF NOT EXISTS ticket (
  ticket_id      TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  psa            TEXT NOT NULL,      -- github | halo | connectwise | autotask | jira
  external_id    TEXT,               -- the PSA's own id, once it has one
  url            TEXT,
  type           TEXT NOT NULL,      -- change | incident
  priority       TEXT NOT NULL,      -- P1 | P2 | P3 | P4
  status         TEXT NOT NULL,
  action_id      TEXT,
  finding_id     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
-- What a dns_name observation's name resolved to in one DNS run, written by the pass: two runs with an
-- equal value_hash and a different fingerprint are FOUND-BUT-DIFFERENT.
CREATE TABLE IF NOT EXISTS referent_fingerprint (
  obs_id         TEXT NOT NULL,      -- the dns_name observation
  dns_run_id     TEXT NOT NULL,      -- the DNS run it was fingerprinted against
  fingerprint    TEXT NOT NULL,      -- the name's A and AAAA contents in that run, sorted, joined by ","; '' when it has none
  resolved_at    TEXT NOT NULL,
  PRIMARY KEY (obs_id, dns_run_id)
);
