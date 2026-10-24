// Idempotent Zetaris setup: the DRIFT datasource over the app Postgres, the drift_usl Unified Semantic
// Layer over it and the run_complete DQ rule on its collection table. The statements are the ones that
// ran live on 2.4.3.1 on 24 Oct 2026, in the order they ran; plan() lists them, apply() runs them.
//
// Contract:
//   - Re-runnable. CREATE DATASOURCE has no IF NOT EXISTS, so SHOW DATASOURCES decides it; REGISTER
//     DATASOURCE TABLES follows a create and REFRESH DATASOURCE TABLES an existing source; namespaces and
//     the USL carry IF NOT EXISTS; REGISTER DQ runs only when LIST DQ USL does not list the rule. An error
//     saying "already exist" is done (skipped). Any other error stops the run.
//   - One statement per call, except COMPILE USL ... DDL: four CREATE TABLE blocks separated by ';' in
//     one request, sent with the adapter's allowMultiStatement (honoured for COMPILE USL only).
//   - The CREATE DATASOURCE statement carries the Postgres password and is built in memory when it is
//     sent, nowhere else: plan() holds password "<redacted>", its trace line says only "CREATE DATASOURCE
//     DRIFT (credentials redacted)", and every error message is redact()ed and scrubbed of the literal
//     password before it is printed or traced.
//   - Zetaris reaches the Postgres at ZETARIS_PG_HOST (host[:port], 5432 when absent), not at
//     DATABASE_URL's host: measured drift-pg:5432 from the driver container, 127.0.0.1:15432 from Windows.
//     Only the user, password and database come from DATABASE_URL.
//   - Admin-only statements (CREATE/REGISTER/REFRESH DATASOURCE, COMPILE/ACTIVATE USL, REGISTER DQ) need
//     an admin-role key; the agent's own key only SELECTs.
//
// Measured: the USL DDL validator rejects a column named source and a table named reference with a
// generic "Invalid DDL statement", hence source_kind and referent. RUN DQ TABLE returns name | table |
// type | total_record | valid_record | invalid_record; on the sample bundle run_complete is 12/11/1.
// First run against the instance already set up (24 Oct, 4.3 s, 17 ok, 2 skipped): LIST DQ USL, run after
// steps 04-11, listed the 6 PK/FK constraint rules and not run_complete, which it lists before and after;
// one of REFRESH, COMPILE USL IF NOT EXISTS or a re-ACTIVATE drops the custom rule of an existing USL
// (not bisected), so the run re-registers it and ends with the same 7 rules.

import { Zetaris, type QueryResult } from "../adapters/zetaris.ts";
import { config, redact } from "../config.ts";
import type { Tracer, TraceEvent } from "../trace.ts";

export const NAMESPACE = "lightning.metastore.drift";
export const USL = `${NAMESPACE}.drift_usl`;
export const USL_TABLES = ["collection", "setting", "referent", "backup_copy"] as const;
export const DQ_RULE = "run_complete";
const DESCRIPTION = "drift-agent app Postgres on the zetaris network";
const AGENT = "zetaris-setup";
const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const PG_IDENT = /^[A-Za-z0-9_-]+$/;

export class SetupError extends Error {
  constructor(message: string) { super(redact(message)); }
}

export interface SetupEnv {
  /** postgresql://user:password@host:port/db as the app reaches it; only user, password and db are used. */
  databaseUrl: string;
  /** host[:port] as the Zetaris driver container reaches the same Postgres. */
  pgHost: string;
  datasource: string;
}

export function envFromProcess(): SetupEnv {
  return { databaseUrl: process.env.DATABASE_URL ?? "", pgHost: config.zetaris.pgHost, datasource: config.zetaris.datasource };
}

/** Run a step only in this state: the datasource was absent before this run, it existed, or the DQ rule is not registered. */
export type When = "datasource_absent" | "datasource_present" | "dq_rule_absent";

export interface Step {
  name: string;
  /** The statement as printed. For CREATE DATASOURCE the password is "<redacted>". */
  sql: string;
  /** The statement as sent, built in memory when it runs. Only CREATE DATASOURCE has one. */
  secret?: () => string;
  /** The trace line's input_summary instead of sql, for a statement that carries credentials. */
  traceAs?: string;
  when?: When;
  /** What the result tells the steps after it. */
  probe?: "datasources" | "dq_rules";
  /** An "already exist" error from this step means the datasource existed. */
  marksDatasource?: true;
  multi?: true;
  /** Print the result rows. */
  show?: true;
  timeoutMs?: number;
}

interface PgTarget { user: string; password: string; db: string; host: string; port: string }

/** Parse DATABASE_URL and ZETARIS_PG_HOST. Messages never carry the URL. */
function pgTarget(env: SetupEnv): PgTarget {
  if (!env.databaseUrl) throw new SetupError("DATABASE_URL is not set");
  let u: URL;
  try { u = new URL(env.databaseUrl); } catch { throw new SetupError("DATABASE_URL is not a URL"); }
  if (!/^postgres(?:ql)?:$/.test(u.protocol)) throw new SetupError("DATABASE_URL must be postgres:// or postgresql://");
  let user: string, password: string, db: string;
  try {
    [user, password, db] = [u.username, u.password, u.pathname.replace(/^\//, "")].map(decodeURIComponent);
  } catch { throw new SetupError("DATABASE_URL has a malformed percent-escape"); }
  if (!user || !password || !db) throw new SetupError("DATABASE_URL must carry a user, a password and a database");
  if (!PG_IDENT.test(user) || !PG_IDENT.test(db)) throw new SetupError("DATABASE_URL user and database must be [A-Za-z0-9_-]");
  // Zetaris option values are double-quoted; how it escapes a quote inside one is unmeasured, so refuse rather than guess.
  if (/["\\\r\n]/.test(password)) throw new SetupError("the DATABASE_URL password holds a double quote, backslash or newline; Zetaris option values are double-quoted and their escaping is unmeasured");
  const m = env.pgHost.match(/^([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/);
  if (!m) throw new SetupError("ZETARIS_PG_HOST must be host or host:port");
  return { user, password, db, host: m[1], port: m[2] ?? "5432" };
}

function createDatasource(ds: string, t: PgTarget, password: string): string {
  return `CREATE DATASOURCE ${ds} DESCRIBE BY "${DESCRIPTION}" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://${t.host}:${t.port}/${t.db}", username "${t.user}", password "${password}", schema "public", fetchsize "1000")`;
}

/** Each CREATE TABLE starts on its own line; the whole block is one request. */
export const COMPILE_USL = `COMPILE USL IF NOT EXISTS drift_usl DEPLOY NAMESPACE ${NAMESPACE} DDL
CREATE TABLE collection (
  run_id varchar(128) NOT NULL PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  surface varchar(64) NOT NULL,
  host varchar(128),
  started_at varchar(40) NOT NULL,
  expected_count int,
  observed_count int,
  status varchar(16) NOT NULL
);
CREATE TABLE setting (
  setting_id varchar(128) NOT NULL PRIMARY KEY,
  run_id varchar(128) NOT NULL FOREIGN KEY REFERENCES collection(run_id),
  tenant_id varchar(64) NOT NULL,
  host varchar(128),
  surface varchar(64) NOT NULL,
  object_id varchar(512) NOT NULL,
  setting_path varchar(512) NOT NULL,
  value_hash varchar(80) NOT NULL,
  refers_to_type varchar(32),
  refers_to_id varchar(255),
  observed_at varchar(40) NOT NULL,
  source_kind varchar(32) NOT NULL,
  authority int NOT NULL
);
CREATE TABLE referent (
  ref_id varchar(255) NOT NULL PRIMARY KEY,
  setting_id varchar(128) NOT NULL FOREIGN KEY REFERENCES setting(setting_id),
  tenant_id varchar(64) NOT NULL,
  target_type varchar(32) NOT NULL,
  target_name varchar(255) NOT NULL,
  resolves_to varchar(255) NOT NULL,
  proxied int,
  resolved_at varchar(40) NOT NULL,
  dns_run_id varchar(128) NOT NULL
);
CREATE TABLE backup_copy (
  copy_id varchar(1024) NOT NULL PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  host varchar(128) NOT NULL,
  kind varchar(16) NOT NULL,
  object_id varchar(512) NOT NULL,
  setting_path varchar(512) NOT NULL,
  value_hash varchar(80) NOT NULL,
  taken_at varchar(40) NOT NULL
)`;

/** The activation query per USL table: exactly the declared columns, NOT NULL varchars wrapped in COALESCE, ints CAST. */
function activation(table: (typeof USL_TABLES)[number], ds: string): string {
  switch (table) {
    case "collection":
      return `SELECT COALESCE(run_id, '') AS run_id, COALESCE(tenant_id, '') AS tenant_id, COALESCE(surface, '') AS surface, host, COALESCE(started_at, '') AS started_at, CAST(expected_count AS INT) AS expected_count, CAST(observed_count AS INT) AS observed_count, COALESCE(status, '') AS status FROM ${ds}.collection_run`;
    case "setting":
      return `SELECT COALESCE(obs_id, '') AS setting_id, COALESCE(run_id, '') AS run_id, COALESCE(tenant_id, '') AS tenant_id, host, COALESCE(surface, '') AS surface, COALESCE(object_id, '') AS object_id, COALESCE(setting_path, '') AS setting_path, COALESCE(value_hash, '') AS value_hash, refers_to_type, refers_to_id, COALESCE(observed_at, '') AS observed_at, COALESCE(source, '') AS source_kind, CAST(COALESCE(authority, 0) AS INT) AS authority FROM ${ds}.observation`;
    case "referent":
      return `SELECT CONCAT(o.obs_id, ':', d.record_id, ':', d.run_id) AS ref_id, COALESCE(o.obs_id, '') AS setting_id, COALESCE(o.tenant_id, '') AS tenant_id, COALESCE(o.refers_to_type, '') AS target_type, COALESCE(o.refers_to_id, '') AS target_name, COALESCE(d.content, '') AS resolves_to, CAST(d.proxied AS INT) AS proxied, COALESCE(d.observed_at, '') AS resolved_at, COALESCE(d.run_id, '') AS dns_run_id FROM ${ds}.observation o JOIN ${ds}.dns_record d ON d.tenant_id = o.tenant_id AND d.name = o.refers_to_id WHERE o.refers_to_type = 'dns_name'`;
    case "backup_copy":
      return `SELECT CONCAT(b.snapshot_id, ':', b.object_id, ':', b.setting_path) AS copy_id, COALESCE(s.tenant_id, '') AS tenant_id, COALESCE(s.host, '') AS host, COALESCE(s.kind, '') AS kind, COALESCE(b.object_id, '') AS object_id, COALESCE(b.setting_path, '') AS setting_path, COALESCE(b.value_hash, '') AS value_hash, COALESCE(s.taken_at, '') AS taken_at FROM ${ds}.backup_item b JOIN ${ds}.backup_snapshot s ON s.snapshot_id = b.snapshot_id`;
  }
}

/** The ordered statements. Throws SetupError when DATABASE_URL or ZETARIS_PG_HOST cannot build the datasource. */
export function plan(env: SetupEnv = envFromProcess()): Step[] {
  const ds = env.datasource;
  if (!IDENT.test(ds)) throw new SetupError("ZETARIS_DATASOURCE must be an unquoted identifier");
  const t = pgTarget(env);
  return [
    { name: "show datasources", sql: "SHOW DATASOURCES", probe: "datasources" },
    {
      name: `create datasource ${ds}`, sql: createDatasource(ds, t, "<redacted>"), secret: () => createDatasource(ds, t, t.password),
      traceAs: `CREATE DATASOURCE ${ds} (credentials redacted)`, when: "datasource_absent", marksDatasource: true,
    },
    { name: "register datasource tables", sql: `REGISTER DATASOURCE TABLES FROM ${ds}`, when: "datasource_absent" },
    { name: "refresh datasource tables", sql: `REFRESH DATASOURCE TABLES FROM ${ds}`, when: "datasource_present" },
    { name: "namespace lightning.metastore", sql: "CREATE NAMESPACE IF NOT EXISTS lightning.metastore" },
    { name: `namespace ${NAMESPACE}`, sql: `CREATE NAMESPACE IF NOT EXISTS ${NAMESPACE}` },
    { name: "compile usl drift_usl", sql: COMPILE_USL, multi: true, timeoutMs: 120_000 },
    ...USL_TABLES.map((tb): Step => ({ name: `activate ${tb}`, sql: `ACTIVATE USL TABLE ${USL}.${tb} AS ${activation(tb, ds)}`, timeoutMs: 120_000 })),
    { name: "list dq rules", sql: `LIST DQ USL ${USL}`, probe: "dq_rules" },
    { name: `register dq ${DQ_RULE}`, sql: `REGISTER DQ ${DQ_RULE} TABLE ${USL}.collection AS observed_count >= expected_count AND status = 'complete'`, when: "dq_rule_absent" },
    { name: "run dq collection", sql: `RUN DQ TABLE ${USL}.collection`, show: true, timeoutMs: 150_000 },
    { name: `show ${NAMESPACE}`, sql: `SHOW NAMESPACES OR TABLES IN ${NAMESPACE}`, show: true },
    ...USL_TABLES.map((tb): Step => ({ name: `count ${tb}`, sql: `SELECT COUNT(*) AS n FROM ${USL}.${tb}` })),
  ];
}

const WHEN_TEXT: Record<When, (ds: string) => string> = {
  datasource_absent: (ds) => `only when ${ds} is absent`,
  datasource_present: (ds) => `only when ${ds} already existed`,
  dq_rule_absent: () => `only when LIST DQ USL does not list ${DQ_RULE}`,
};

/** The plan as printed by --plan: number, name, condition, then the statement indented. No password: sql holds "<redacted>". */
export function formatPlan(steps: Step[], ds: string = config.zetaris.datasource): string[] {
  const lines: string[] = [];
  for (const [i, s] of steps.entries()) {
    const notes = [s.when && WHEN_TEXT[s.when](ds), s.multi && "one request"].filter(Boolean);
    lines.push(`${String(i + 1).padStart(2, "0")} ${s.name}${notes.length ? `  (${notes.join("; ")})` : ""}`);
    for (const l of s.sql.split("\n")) lines.push(`     ${l}`);
  }
  return lines.map(redact);
}

export interface StepResult {
  name: string;
  status: "ok" | "skipped" | "failed";
  note: string;
  ms?: number;
  result?: QueryResult;
}

export interface ApplyResult { ok: boolean; results: StepResult[]; dq?: QueryResult; error?: string; ms: number }

export interface ApplyDeps {
  client?: Pick<Zetaris, "query">;
  tracer?: Tracer;
  out?: (line: string) => void;
  env?: SetupEnv;
}

/** Does LIST DQ USL list the rule? Matches the name column when there is one, else any cell. */
function listsRule(r: QueryResult, rule: string): boolean {
  const i = r.columns.findIndex((c) => c.toLowerCase() === "name");
  return r.rows.some((row) => (i >= 0 ? row[i] === rule : row.includes(rule)));
}

function rowsNote(r: QueryResult): string {
  const one = r.rowCount === 1 && r.columns.length === 1 ? r.rows[0][0] : undefined;
  return one !== undefined && one.length <= 40 && !one.includes("\n") ? `= ${one}` : `${r.rowCount} row${r.rowCount === 1 ? "" : "s"}`;
}

function table(r: QueryResult): string[] {
  return [r.columns.join(" | "), ...r.rows.map((row) => row.join(" | "))].map((l) => `     ${l}`);
}

/**
 * Run the plan one statement at a time. Prints one line per statement (status, number, name, note,
 * latency), the rows of RUN DQ and SHOW NAMESPACES, and a closing summary; emits one trace line per
 * statement, ok, skipped or failed. Stops at the first error that is not "already exist".
 */
export async function apply(deps: ApplyDeps = {}): Promise<ApplyResult> {
  const env = deps.env ?? envFromProcess();
  const client = deps.client ?? new Zetaris();
  const out = deps.out ?? ((l: string) => console.log(l));
  const steps = plan(env);
  const { password } = pgTarget(env);
  const clean = (s: string) => (password.length >= 4 ? redact(s).split(password).join("<redacted>") : redact(s)).slice(0, 400);
  const state = { datasourceExisted: false, dqRuleRegistered: false };
  const results: StepResult[] = [];
  const t0 = Date.now();
  let dq: QueryResult | undefined;

  const record = (i: number, s: Step, res: StepResult, ev: Partial<Omit<TraceEvent, "ts" | "trace_id">> = {}) => {
    results.push(res);
    deps.tracer?.emit({ agent: AGENT, action: "query", status: res.status, input_summary: (s.traceAs ?? s.sql).slice(0, 160), output_summary: res.status === "failed" ? undefined : res.note, latency_ms: res.ms, ...ev });
    const label = `${String(i + 1).padStart(2, "0")} ${s.name}`;
    out(`${res.status.padEnd(7)} ${label.padEnd(44)} ${res.note}${res.ms !== undefined ? `  (${res.ms} ms)` : ""}`);
  };

  for (const [i, s] of steps.entries()) {
    const gated = s.when === "datasource_absent" ? state.datasourceExisted && `${env.datasource} exists`
      : s.when === "datasource_present" ? !state.datasourceExisted && `${env.datasource} created this run`
      : s.when === "dq_rule_absent" ? state.dqRuleRegistered && `${DQ_RULE} already registered`
      : false;
    if (gated) {
      record(i, s, { name: s.name, status: "skipped", note: gated });
      continue;
    }
    const s0 = Date.now();
    try {
      const r = await client.query(s.secret ? s.secret() : s.sql, { limit: 200, timeoutMs: s.timeoutMs ?? 60_000, ...(s.multi ? { allowMultiStatement: true } : {}) });
      let note = rowsNote(r);
      if (s.probe === "datasources") {
        state.datasourceExisted = r.rows.some((row) => row.some((v) => v.toUpperCase() === env.datasource.toUpperCase()));
        note += `, ${env.datasource} ${state.datasourceExisted ? "listed" : "not listed"}`;
      }
      if (s.probe === "dq_rules") {
        state.dqRuleRegistered = listsRule(r, DQ_RULE);
        note += `, ${DQ_RULE} ${state.dqRuleRegistered ? "listed" : "not listed"}`;
      }
      if (s.name === "run dq collection") dq = r;
      record(i, s, { name: s.name, status: "ok", note, ms: Date.now() - s0, result: r }, { query_id: r.queryId });
      if (s.show) for (const l of table(r)) out(l);
    } catch (e) {
      const msg = clean((e as Error).message ?? String(e));
      if (/already exist/i.test(msg)) {
        if (s.marksDatasource) state.datasourceExisted = true;
        record(i, s, { name: s.name, status: "skipped", note: "already exists", ms: Date.now() - s0 }, { detail: msg });
        continue;
      }
      record(i, s, { name: s.name, status: "failed", note: msg, ms: Date.now() - s0 }, { detail: msg });
      const ms = Date.now() - t0;
      out(`ZETARIS SETUP FAILED at ${String(i + 1).padStart(2, "0")} ${s.name} after ${ms} ms: ${msg}`);
      return { ok: false, results, dq, error: msg, ms };
    }
  }

  const ms = Date.now() - t0;
  const n = (st: StepResult["status"]) => results.filter((r) => r.status === st).length;
  out(`ZETARIS SETUP: ${results.length} statements, ${n("ok")} ok, ${n("skipped")} skipped, 0 failed, ${(ms / 1000).toFixed(1)} s`);
  return { ok: true, results, dq, ms };
}
