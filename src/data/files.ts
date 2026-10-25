// The file tables: two sources beside the app Postgres that Zetaris reads as files and sql.js holds as tables of
// the same names. `lesson` is the technician's memory store, one row per lesson the Decider recalls; `rule` is the
// policy file, one row per rule. src/data/file-rows.ts builds both from the store and the file, npm run
// zetaris:setup writes them into the Zetaris filestore and registers them (src/zetaris/setup.ts), and sample mode and
// the parity test load the same rows into sql.js (SqlJsEngine.loadFileTables). On Zetaris, {{t:lesson}} renders as
// LESSONS.lesson and {{t:rule}} as RULES.rule (src/data/engines/zetaris.ts); every other table is DRIFT.<table>.
//
// ADOPTION_SQL is the cross-source read: every ADOPT the Decider made under an accepted exception (decided_by
// operator, verb ADOPT) joined to the lesson its reason names. The Decider writes that reason as "accepted exception
// <lesson id> holds until <expiry> (...)" (src/policy/decide.ts), so the join takes the lesson by tenant and by the id
// the reason names; a lesson's scope key is not a column of the disposition, and two lessons can share one (mem-1
// and mem-21 of examples/memory, both on one name), which a join on the scope key would count twice. A LEFT JOIN, so
// an ADOPT whose lesson the store no longer holds comes back with an empty lesson_id and fails the DQ rule
// exception_in_force. The SQL is the portable subset of src/data/layer.ts: COALESCE for the NOT NULL columns, ||
// for concatenation and LIKE in the JOIN ON, a plain-column WHERE. It is the activation of drift_usl.adoption.

import type { TableDef } from "./schema.ts";

/** The Zetaris Lightning database each file table is registered in. */
export const FILE_DATASOURCES = { lesson: "LESSONS", rule: "RULES" } as const;
export type FileTable = keyof typeof FILE_DATASOURCES;

/** One lesson of the technician's memory store, as lessonRows() writes it. */
export interface LessonRow {
  /** The H-MEM record id (mem-<n>). */
  lesson_id: string;
  tenant_id: string;
  /** exception | answer */
  kind: string;
  /** The finding class an exception covers; null for an answer. */
  finding_class: string | null;
  /** The pseudonym an exception or an answer is scoped to. */
  scope_key: string;
  /** An exception's reason; an answer's answer. */
  reason: string;
  recorded_at: string;
  expires_at: string;
  /** "<kind> by <who> at <instant>[ in <run>]". */
  provenance: string;
}

/** One rule of the policy file, as ruleRows() writes it. */
export interface RuleRow {
  rule_id: string;
  tenant_id: string;
  version: number;
  surface: string;
  object_glob: string;
  setting_glob: string;
  criticality: string;
  locked: number;
  on_drift: string;
  on_no_copy: string;
  hold_hours: number;
  alert: string;
  psa_priority: string;
  description: string | null;
}

export interface FileRows { lesson: LessonRow[]; rule: RuleRow[] }

/** Column order, the same in sql.js and in every check; the Zetaris file table lists them by name. */
export const FILE_TABLES: readonly TableDef[] = [
  { name: "lesson", columns: ["lesson_id", "tenant_id", "kind", "finding_class", "scope_key", "reason", "recorded_at", "expires_at", "provenance"] },
  { name: "rule", columns: ["rule_id", "tenant_id", "version", "surface", "object_glob", "setting_glob", "criticality", "locked", "on_drift", "on_no_copy", "hold_hours", "alert", "psa_priority", "description"] },
];
export const FILE_TABLE_NAMES: readonly string[] = FILE_TABLES.map((t) => t.name);

const INTEGER = new Set(["version", "locked", "hold_hours"]);
const NULLABLE = new Set(["finding_class", "description"]);

/** The sql.js DDL of the file tables. Postgres never holds them. */
export const FILE_SCHEMA_SQL = FILE_TABLES.map((t) =>
  `CREATE TABLE IF NOT EXISTS ${t.name} (\n${t.columns.map((c, i) => `  ${c} ${INTEGER.has(c) ? "INTEGER" : "TEXT"}${NULLABLE.has(c) ? "" : " NOT NULL"}${i === 0 ? " PRIMARY KEY" : ""}`).join(",\n")}\n);`).join("\n");

export function fileTableDef(name: string): TableDef | undefined {
  return FILE_TABLES.find((t) => t.name === name);
}

/** The reason the Decider writes for an ADOPT under an accepted exception starts with this, then the lesson id, then " holds until ". */
export const EXCEPTION_REASON_PREFIX = "accepted exception ";

/**
 * The DQ rule exception_in_force on drift_usl.adoption, plain columns only: the ADOPT names a lesson the store holds,
 * an exception, taught at or before the decision instant and expiring after it. Timestamps are the millisecond ISO
 * form on both sides, so they compare as text.
 */
export const EXCEPTION_IN_FORCE = "lesson_id IS NOT NULL AND lesson_kind = 'exception' AND lesson_recorded_at <= decided_at AND decided_at < lesson_expires_at";

/** Every ADOPT decided under an accepted exception, with the lesson its reason names (src/policy/decide.ts). */
export const ADOPTION_SQL = `SELECT COALESCE(d.disposition_id, '') AS disposition_id, COALESCE(d.tenant_id, '') AS tenant_id, COALESCE(d.finding_id, '') AS finding_id, COALESCE(d.decided_at, '') AS decided_at,
       l.lesson_id AS lesson_id, l.kind AS lesson_kind, l.recorded_at AS lesson_recorded_at, l.expires_at AS lesson_expires_at
FROM {{t:disposition}} d
LEFT JOIN {{t:lesson}} l ON l.tenant_id = d.tenant_id AND d.reason LIKE '${EXCEPTION_REASON_PREFIX}' || l.lesson_id || ' holds until %'
WHERE d.decided_by = 'operator' AND d.verb = 'ADOPT'`;

/** The rule over the adoptions of one decision instant, on either engine: what sample mode prints and the parity test holds equal. */
export const ADOPTION_CHECK_SQL = `SELECT COUNT(*) AS adoptions, COALESCE(SUM(CASE WHEN ${EXCEPTION_IN_FORCE} THEN 1 ELSE 0 END), 0) AS in_force
FROM (${ADOPTION_SQL}) a
WHERE a.decided_at = {{p:decided_at}}`;
