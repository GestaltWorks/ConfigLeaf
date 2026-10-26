// The rows of the file tables (src/data/files.ts), built from the files themselves: the lessons of the technician's
// memory store as TechnicianMemory reads them (the Decider's own reading, lessonOf over state.json), the H-MEM ledger's
// entries as the store wrote them, and the policy file's rules as the policy loader turns them into rows (the same
// rule ids policy_rule and every disposition carry). Pure reads: nothing here writes.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config.ts";
import { TechnicianMemory, type Lesson } from "../engine/memory.ts";
import { loadPolicyFile } from "../policy/load.ts";
import { Redactor } from "../redactor.ts";
import type { FileRows, LessonRow, RuleRow } from "./files.ts";

const provenanceOf = (l: Lesson): string => `${l.provenance.kind} by ${l.provenance.by} at ${l.provenance.at}${l.provenance.runId ? ` in ${l.provenance.runId}` : ""}`;

/** One row per lesson of the store, oldest first, as the Decider recalls them. */
export function lessonRows(memory: TechnicianMemory): LessonRow[] {
  return memory.lessons().map((l): LessonRow => ({
    lesson_id: l.id,
    tenant_id: l.tenantId,
    kind: l.kind,
    finding_class: l.kind === "exception" ? l.findingClass : null,
    scope_key: l.kind === "exception" ? (l.scopeKeys ?? [l.scopeKey]).join(" ") : l.scope.key, // a rule (npm run dream) covers several keys, one token each
    reason: l.kind === "exception" ? l.reason : l.answer,
    recorded_at: l.recordedAt,
    expires_at: l.expiresAt,
    provenance: provenanceOf(l),
  }));
}

/** The H-MEM ledger of the store in `dir` (ledger.jsonl), one entry per line, as the store wrote it; [] when there is none. */
export function ledgerEntries(dir: string = config.memoryDir): unknown[] {
  const file = path.join(path.resolve(dir), "ledger.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l, i) => {
    try {
      return JSON.parse(l) as unknown;
    } catch {
      throw new Error(`${file} line ${i + 1} is not JSON`);
    }
  });
}

/** One row per rule of the policy file, in file order, for every tenant ("*") or the file's own. */
export function ruleRows(file: string = config.policyFile, redactor: Redactor = new Redactor(config.redactSalt || randomBytes(16).toString("hex"), config.redactWords)): RuleRow[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { tenant?: unknown };
  const tenant = typeof raw.tenant === "string" ? raw.tenant : "*";
  return loadPolicyFile(file, { tenant, redactor }).rows.map((r): RuleRow => ({
    rule_id: r.rule_id, tenant_id: r.tenant_id, version: r.version, surface: r.surface, object_glob: r.object_glob, setting_glob: r.setting_glob,
    criticality: r.criticality, locked: r.lock, on_drift: r.on_drift, on_no_copy: r.on_no_copy, hold_hours: r.hold_max_hours, alert: r.alert,
    psa_priority: r.psa_priority, description: r.note,
  }));
}

/** Both tables: the store in `memoryDir` (read only) and the policy file. */
export function fileRows(opts: { memoryDir?: string; policyFile?: string; redactor?: Redactor } = {}): FileRows {
  return { lesson: lessonRows(new TechnicianMemory({ storage: "read", directory: opts.memoryDir ?? config.memoryDir })), rule: ruleRows(opts.policyFile ?? config.policyFile, opts.redactor) };
}
