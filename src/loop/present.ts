// The terminal view of npm run cycle, pass, act, tickets and watch: what a reader takes in at a glance. One header,
// one row per step with its time, an indented line under the pass for each finding the agent moves on (ROLLBACK, FIX,
// ESCALATE) and under act for each action, then one done line. The trace keeps every other fact, run ids included.
//
// Contract:
//   - Header: "drift-agent · <command> · tenant <id> · <YYYY-MM-DD HH:MM> UTC · <mode>", the mode one of "dry run",
//     "applied", "recorded" (a pass that writes the ledger) or "watch every <n> min".
//   - Row: two spaces, the step name in 9 columns, a space, the subject in 13 columns (wider when a subject the table
//     is given up front is longer: a redacted host alias), a space, the detail as phrases joined by " · ", and the
//     duration to one decimal, right-aligned to the width: the terminal's columns less one, up to 120, when stdout is
//     a TTY; 90 otherwise. A view with no subject starts its detail in the subject's column. The lines under a row
//     start in the subject's column; a label is padded to the longest label of its group, or the longest verb
//     (ROLLBACK) under the pass and the longest kind (rollback_file) under act, plus two spaces.
//   - Numbers carry thousands separators, durations one decimal, hashes and commits 8 hex; run ids stay in the trace
//     (the table rewrites one that a reason carries as "the run").
//   - Colour only when stdout is a TTY and NO_COLOR is unset or empty: ROLLBACK and FIX bold white, ESCALATE red, HOLD
//     yellow, ADOPT green; done green, failed red, unverified and not judged yellow, refused and skipped dim.
//   - Every text passes `scrub` (the tenant's redactor live) before it is measured and coloured. A collect row's
//     subject is the host's ssh alias as LINUX_HOSTS names it, shown as typed: the operator's own configuration, the
//     name the step carries ("collect:linux <alias>") and the one carrier test/leak.test.ts allows.
//   - A failing step is one red row, "<step> failed <reason, one line>"; the done line then reads "stopped at <step> ·
//     <i> of <n>".
//   - The callers print the old full line after a step's rows under --verbose (the old formatters stay) and only the
//     header and the done line under --quiet.
//
// Measured 25 Oct 2026: test/present.test.ts over fixed step results; the live screen is in scripts/cycle.ts.

import type { ActResult } from "../actions/act.ts";
import type { ActionOutcome, PlanItem } from "../actions/plan.ts";
import type { Finding, Verb } from "../pipeline.ts";
import type { TicketOp } from "../psa/index.ts";
import type { TicketOutcome } from "../psa/step.ts";
import type { HookResult } from "../vault/hook.ts";
import type { PassStep } from "./pass.ts";

export type Tone = "bold" | "strong" | "red" | "yellow" | "green" | "dim";
export interface Span { text: string; tone: Tone }
export type Seg = string | Span;
/** One phrase of a detail: plain text, or text with coloured spans in it. */
export type Phrase = Seg | readonly Seg[];
export interface SubLine { label?: Phrase; parts: readonly Phrase[] }
export interface StepView {
  /** The subject column; absent, the detail starts there. */
  subject?: string;
  /** The subject is a configured ssh alias (a LINUX_HOSTS key), shown as the operator typed it; every other text passes the redactor. */
  alias?: boolean;
  parts: readonly Phrase[];
  /** The lines under the row. */
  sub?: readonly SubLine[];
  /** The narrowest the labels of `sub` are padded to: the longest verb or kind, so a column stays put across runs. */
  labelWidth?: number;
}

export interface PresentOptions { color: boolean; width: number; verbose: boolean; quiet: boolean }

export const STEP_WIDTH = 9;
export const SUBJECT_WIDTH = 13;
export const PLAIN_WIDTH = 90;
export const MAX_WIDTH = 120;
/** Finding lines under the pass row; the rest are counted in one line. */
export const FINDING_LINES = 12;
const INDENT = " ".repeat(2 + STEP_WIDTH + 1);

/** Plain text at 90 columns, the rows and the done line. */
export const PLAIN: PresentOptions = { color: false, width: PLAIN_WIDTH, verbose: false, quiet: false };

/** The options for this process's stdout: colour and width from the terminal, verbose and quiet from the flags. */
export function presentOptions(flags: { verbose?: boolean; quiet?: boolean } = {}, out: { isTTY?: boolean; columns?: number } = process.stdout, env: NodeJS.ProcessEnv = process.env): PresentOptions {
  const tty = out.isTTY === true;
  return {
    color: tty && !env.NO_COLOR,
    width: tty && out.columns ? Math.min(out.columns - 1, MAX_WIDTH) : PLAIN_WIDTH,
    verbose: flags.verbose === true,
    quiet: flags.quiet === true,
  };
}

// ---- numbers, times, hashes ---------------------------------------------------------------------------------

export const thousands = (n: number): string => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const count = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;
export const seconds = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
export const hex8 = (h: string | null | undefined): string => (h ? h.replace(/^sha256:/, "").slice(0, 8) : "-");
const pad2 = (n: number): string => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-10-25 15:38 UTC */
export const utcMinute = (d: Date): string => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
/** 25 Oct 03:21 UTC; the input as given when it is no instant. */
export function shortUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}
/** The first clause of a sentence (up to "; "), cut at `max` characters. */
export function clause(s: string, max = 64): string {
  const c = s.split("; ")[0].trim();
  return c.length > max ? `${c.slice(0, max - 1).trimEnd()}…` : c;
}
/** A path as its last two segments: /etc/nginx/conf.d/x.conf -> conf.d/x.conf. */
export const tail = (p: string): string => (p.includes("/") ? p.split("/").filter(Boolean).slice(-2).join("/") : p);
/** Run ids out of a sentence: the trace carries them. */
export const withoutRunIds = (s: string): string =>
  s.replace(/\b(probe|dns|audit) run run-[0-9a-f]{16}\b/g, "the $1 run").replace(/\brun run-[0-9a-f]{16}\b/g, "the run").replace(/\brun-[0-9a-f]{16}\b/g, "a run");

// ---- tones ----------------------------------------------------------------------------------------------------

const SGR: Record<Tone, string> = { bold: "1", strong: "1;37", red: "31", yellow: "33", green: "32", dim: "2" };
export const paint = (text: string, tone: Tone | undefined, color: boolean): string => (color && tone && text ? `\x1b[${SGR[tone]}m${text}\x1b[0m` : text);

export const VERB_TONE: Readonly<Record<Verb, Tone>> = { ROLLBACK: "strong", FIX: "strong", ESCALATE: "red", HOLD: "yellow", ADOPT: "green" };
const STATUS_TONE: Readonly<Record<string, Tone>> = { done: "green", failed: "red", unverified: "yellow", not_judged: "yellow", refused: "dim", skipped: "dim" };
export const verbSpan = (v: Verb): Span => ({ text: v, tone: VERB_TONE[v] });
export const statusSpan = (s: string): Span => ({ text: s.replace(/_/g, " "), tone: STATUS_TONE[s] ?? "dim" });

// ---- the table ------------------------------------------------------------------------------------------------

const isSegs = (p: Phrase): p is readonly Seg[] => typeof p !== "string" && Array.isArray(p);
const segsOf = (p: Phrase): readonly Seg[] => (isSegs(p) ? p : [p as Seg]);
const padTo = (s: string, w: number): string => (s.length >= w ? s : s.padEnd(w));
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

export interface HeaderInfo { command: string; tenant: string; at: Date; mode: string }
export interface DoneInfo {
  ms: number;
  /** The cycle's step count; absent for a standalone step. */
  steps?: number;
  skipped?: number;
  trace?: string;
  stopped?: { step: string; at: number; of: number };
}

export class Table {
  readonly subjectWidth: number;
  private readonly clean: (s: string) => string;

  /** `subjects`: the subjects the table will show as typed (cloudflare, the ssh aliases); the column fits the longest. */
  constructor(readonly o: PresentOptions = PLAIN, scrub: (s: string) => string = (s) => s, subjects: readonly string[] = []) {
    this.clean = (s) => withoutRunIds(scrub(s));
    this.subjectWidth = Math.max(SUBJECT_WIDTH, ...subjects.map((s) => s.length));
  }

  private join(parts: readonly Phrase[]): { plain: string; ansi: string } {
    let plain = "";
    let ansi = "";
    parts.forEach((p, i) => {
      if (i > 0) { plain += " · "; ansi += " · "; }
      for (const s of segsOf(p)) {
        const text = this.clean(typeof s === "string" ? s : s.text);
        plain += text;
        ansi += typeof s === "string" ? text : paint(text, s.tone, this.o.color);
      }
    });
    return { plain, ansi };
  }

  private timed(lead: string, body: { plain: string; ansi: string }, ms: number | null): string {
    if (ms === null) return `${lead}${body.ansi}`.replace(/ +$/, "");
    const t = seconds(ms);
    return `${lead}${body.ansi}${" ".repeat(Math.max(2, this.o.width - lead.length - body.plain.length - t.length))}${t}`;
  }

  header(h: HeaderInfo): string {
    return paint(["drift-agent", h.command, `tenant ${h.tenant}`, utcMinute(h.at), h.mode].map(this.clean).join(" · "), "bold", this.o.color);
  }

  /** The step's row and the lines under it. */
  row(step: string, view: StepView, ms: number | null): string[] {
    const subject = view.subject === undefined ? "" : `${padTo(view.alias ? view.subject : this.clean(view.subject), this.subjectWidth)} `;
    const out = [this.timed(`  ${padTo(step, STEP_WIDTH)} ${subject}`, this.join(view.parts), ms)];
    const sub = view.sub ?? [];
    const labels = sub.map((s) => (s.label === undefined ? null : this.join([s.label])));
    const w = Math.max(view.labelWidth ?? 0, ...labels.map((l) => l?.plain.length ?? 0));
    sub.forEach((s, i) => {
      const l = labels[i];
      out.push(`${INDENT}${l ? `${l.ansi}${" ".repeat(w - l.plain.length + 2)}` : ""}${this.join(s.parts).ansi}`);
    });
    return out;
  }

  skipped(step: string, subject?: string, alias = false): string {
    return this.row(step, { subject, alias, parts: [[statusSpan("skipped")]] }, null)[0];
  }

  /** One red row: the step, "failed", the reason on one line cut to the width. */
  failed(step: string, reason: string, ms: number | null): string {
    const lead = `  ${padTo(step, STEP_WIDTH)} ${padTo("failed", this.subjectWidth)} `;
    const t = ms === null ? "" : seconds(ms);
    const room = this.o.width - lead.length - (t ? t.length + 2 : 0);
    let why = oneLine(this.clean(reason));
    if (room >= 20 && why.length > room) why = `${why.slice(0, room - 1).trimEnd()}…`;
    const plain = t ? `${lead}${why}${" ".repeat(Math.max(2, this.o.width - lead.length - why.length - t.length))}${t}` : `${lead}${why}`;
    return paint(plain, "red", this.o.color);
  }

  done(d: DoneInfo): string {
    const lead = d.stopped
      ? `${paint(`stopped at ${this.clean(d.stopped.step)}`, "red", this.o.color)} · ${d.stopped.at} of ${d.stopped.of}`
      : [paint("done", "green", this.o.color), ...(d.steps === undefined ? [] : [count(d.steps, "step")]), ...(d.skipped ? [`${d.skipped} skipped`] : [])].join(" · ");
    return [lead, seconds(d.ms), ...(d.trace ? [`trace ${this.clean(d.trace)}`] : [])].join(" · ");
  }
}

// ---- the views of the steps -----------------------------------------------------------------------------------

/** The vault's part of a collect row. */
export function vaultPhrase(h: HookResult): Phrase {
  if (h.status === "committed") return `vault ${hex8(h.commit.commit)}${h.commit.reused ? " (an earlier write)" : ""}`;
  if (h.status === "failed") return [{ text: "vault failed", tone: "red" }];
  return [{ text: h.status === "skipped" ? "vault skipped" : "vault off", tone: "dim" }];
}

export function cloudflareView(o: { records: number; zones: number; audit: number; hook: HookResult }): StepView {
  return { subject: "cloudflare", parts: [`${count(o.records, "record")} in ${count(o.zones, "zone")}`, `audit ${count(o.audit, "row")}`, vaultPhrase(o.hook)] };
}

/** collect:linux: `alias` is the LINUX_HOSTS key as configured, shown as typed. */
export function linuxView(alias: string, o: { files: number; blocks: number; settings: number; hook: HookResult }): StepView {
  return { subject: alias, alias: true, parts: [count(o.files, "file"), count(o.blocks, "block"), count(o.settings, "setting"), vaultPhrase(o.hook)] };
}

export function probeView(o: { names: number; rows: readonly { kind: string; status: string }[] }): StepView {
  const n = (f: (p: { kind: string; status: string }) => boolean): number => o.rows.filter(f).length;
  const parts: Phrase[] = (["http", "dns", "tls"] as const).map((k) => `${k} ${thousands(n((p) => p.kind === k && p.status === "ok"))} ok`);
  const failing = n((p) => p.status === "fail");
  const skipped = n((p) => p.status === "skipped");
  if (failing) parts.push(`${thousands(failing)} failing`);
  if (skipped) parts.push(`${thousands(skipped)} skipped`);
  return { subject: count(o.names, "name"), parts };
}

const RESULT_TEXT: Readonly<Record<string, string>> = { ok: "ok", ok_with_gaps: "ok with gaps", fail: "fail" };
const resultSeg = (r: string): Seg => (r === "fail" ? { text: "fail", tone: "red" } : RESULT_TEXT[r] ?? r);

/** validate: the repository heads; nginx-t once per host repository, cf-schema once per record. */
export function validateView(o: { heads: number; nginx: readonly string[]; rows: readonly { validator: string; result: string }[]; errors: number } | null): StepView {
  if (!o) return { parts: ["no new vault commit", "nothing validated"] };
  const groups = (xs: readonly string[]): [string, number][] =>
    (["ok", "ok_with_gaps", "fail"] as const).map((r) => [r, xs.filter((x) => x === r).length] as [string, number]).filter(([, k]) => k > 0);
  const parts: Phrase[] = [];
  const nginx = groups(o.nginx);
  if (nginx.length) parts.push(["nginx-t ", ...nginx.flatMap(([r, k], i) => [...(i ? [", "] : []), resultSeg(r), k > 1 ? ` ×${k}` : ""])]);
  const cf = groups(o.rows.filter((r) => r.validator === "cf-schema").map((r) => r.result));
  if (cf.length) parts.push(["cf-schema ", ...cf.flatMap(([r, k], i) => [...(i ? [", "] : []), `${thousands(k)} `, r === "ok_with_gaps" ? "with gaps" : resultSeg(r)])]);
  if (o.errors) parts.push([{ text: `${count(o.errors, "repository", "repositories")} not validated`, tone: "red" }]);
  return { subject: count(o.heads, "copy", "copies"), parts: parts.length ? parts : ["no copy validated"] };
}

const VERB_ORDER: readonly Verb[] = ["ROLLBACK", "FIX", "ADOPT", "HOLD", "ESCALATE"];
const MOVING: readonly Verb[] = ["ROLLBACK", "FIX", "ESCALATE"];

const tallyDesc = (xs: readonly string[]): [string, number][] =>
  [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort(([a, n], [b, k]) => k - n || (a < b ? -1 : a > b ? 1 : 0));

/** What a finding is about: a file as its last two segments on its host, a record by its redacted name. */
export function findingWhere(s: Finding["finding"], withSetting: boolean): string {
  if (s.surface === "cloudflare.dns") return `${s.dns_name || s.object_id}${withSetting && s.setting_path ? ` ${s.setting_path}` : ""}`;
  const setting = withSetting && s.setting_path && s.setting_path !== "file" ? ` ${s.setting_path}` : "";
  return `${tail(s.object_id)}${setting}${s.host ? ` on ${s.host}` : ""}`;
}

/** A Decider's reason in its few words: the expiry that ran out, the copy and production it weighed. */
export function reasonClauses(reason: string): string[] {
  const held = reason.match(/hold under rule \S+ expired (\S+?);/);
  if (held) return [`hold expired ${shortUtc(held[1])}`];
  const lapsed = reason.match(/exception lapsed: \S+ expired (\S+?);/);
  if (lapsed) return [`exception lapsed ${shortUtc(lapsed[1])}`];
  const out: string[] = [];
  if (/no valid copy/.test(reason)) out.push("no valid copy");
  const affected = reason.match(/production affected \((\d+) failing probes?/);
  if (affected) out.push(`production affected, ${count(Number(affected[1]), "failing probe")}`);
  else if (/production answering/.test(reason)) out.push("production answering");
  else if (/production is unknown|no probe run in this pass|no probe in \S+ targets a name it serves/.test(reason)) out.push("production unknown");
  return out.length ? out : [clause(reason)];
}

/** One line under the pass row: ROLLBACK with what drifted and the copy it restores; FIX and ESCALATE with the class and why. */
export function findingLine(f: Finding): SubLine {
  const s = f.finding;
  const r = f.disposition.reason;
  if (f.verb !== "ROLLBACK") return { label: [verbSpan(f.verb)], parts: [`${s.class} ${findingWhere(s, false)}`, ...reasonClauses(r)] };
  const drift = r.match(/drifted from approved ([0-9a-f]{8})/);
  const gone = r.match(/approved ([0-9a-f]{8})[0-9a-f]* is absent from the run/);
  const copy = r.match(/vault commit ([0-9a-f]{8}) holds the approved copy, validated (\w+) with (\d+) gaps?/);
  return {
    label: [verbSpan(f.verb)],
    parts: [
      findingWhere(s, true),
      drift ? `drifted from approved ${drift[1]}` : gone ? `approved ${gone[1]} absent` : s.class,
      ...(copy ? [`copy ${copy[1]} validated ${copy[2] === "ok_with_gaps" ? `ok with ${count(Number(copy[3]), "gap")}` : copy[2]}`] : []),
    ],
  };
}

/** pass: the findings by verb; under it the classes, then one line per ROLLBACK, FIX and ESCALATE. */
export function passView(p: Pick<PassStep, "findings">): StepView {
  const fs = p.findings;
  const parts: Phrase[] = VERB_ORDER.map((v) => [v, fs.filter((f) => f.verb === v).length] as const).filter(([, n]) => n > 0).map(([v, n]) => [verbSpan(v), ` ${thousands(n)}`]);
  const sub: SubLine[] = [];
  const classes = tallyDesc(fs.map((f) => f.finding.class));
  if (classes.length) sub.push({ parts: classes.map(([c, n]) => `${c} ${thousands(n)}`) });
  const moving = MOVING.flatMap((v) => fs.filter((f) => f.verb === v));
  for (const f of moving.slice(0, FINDING_LINES)) sub.push(findingLine(f));
  if (moving.length > FINDING_LINES) sub.push({ parts: [`${thousands(moving.length - FINDING_LINES)} more in the trace`] });
  return { subject: count(fs.length, "finding"), parts, sub, labelWidth: "ROLLBACK".length };
}

const PROBE_LINE = /^probe \S+: (\w+) (\S+) (\w+) \(/;

/** The verification probes an action's record names, in a few words. */
export function probeTally(record: readonly string[], verification: string): string {
  const rows = record.map((l) => ({ l, m: l.match(PROBE_LINE) })).filter((x) => x.m !== null);
  if (!rows.length) {
    const n = verification.split(",").filter(Boolean).length;
    return n ? `${count(n, "probe")} ok` : "no probe";
  }
  const skipped = rows.filter((x) => x.m![3] === "skipped").length;
  const ran = rows.length - skipped;
  const ok = rows.filter((x) => x.m![3] === "ok").length;
  let text = ok === ran ? `${count(ran, "probe")} ok` : `${ok} of ${count(ran, "probe")} ok`;
  if (rows.some((x) => /cf-ray present/.test(x.l))) text += ", cf-ray present";
  if (skipped) text += `, ${skipped} skipped`;
  return text;
}

const WRITTEN = /^(?:written and reloaded|written|(?:reverted|re-created) to the approved copy at vault commit [0-9a-f]{8}; the record read back equals the copy field by field); /;

/** Why a completed write ended unverified. */
export function unverifiedWhy(reason: string): string {
  if (/the account holds no record of these names/.test(reason)) return "no probe knew its names";
  if (/the account holds no A, AAAA or CNAME record of this name/.test(reason)) return "no probe knew its name";
  if (/records no name the object serves/.test(reason)) return "the object serves no name";
  const nowhere = reason.match(/(\d+) of (\d+) probes? reached no address/);
  if (nowhere) return `${nowhere[1]} of ${count(Number(nowhere[2]), "probe")} reached no address`;
  const skipped = reason.match(/\((\d+) skipped/);
  if (skipped) return `${count(Number(skipped[1]), "probe")} skipped`;
  if (/did not run/.test(reason)) return "the probes did not run";
  return clause(reason.replace(WRITTEN, ""));
}

/** What failed, in one clause. */
export const failClause = (reason: string): string => clause(reason.replace(WRITTEN, "").split(": ")[0]);

/** Why an action was refused, in one clause. */
export function refuseClause(reason: string): string {
  if (/changed since the decision/.test(reason)) return "changed since the decision";
  if (/a password is required/.test(reason)) return "sudo needs a password";
  return clause(reason);
}

const hashes = (before: string | null, after: string | null): string => `${before ? hex8(before) : "absent"} → ${after ? hex8(after) : "absent"}`;

/** One line under the act row for an applied action. `all` gives an investigation its verb: FIX when a fix follows it on the same disposition. */
export function outcomeLine(o: ActionOutcome, all: readonly ActionOutcome[] = [o]): SubLine {
  const a = o.action;
  const took = seconds(Date.parse(a.finished_at ?? a.started_at) - Date.parse(a.started_at));
  const st = statusSpan(a.status);
  const label: Phrase = a.kind;
  if (a.kind === "investigate") {
    const v: Verb = all.some((x) => x.action.kind === "fix" && x.action.disposition_id === a.disposition_id) ? "FIX" : "ESCALATE";
    if (a.status !== "done") return { label, parts: [[verbSpan(v)], [st], a.status === "refused" ? refuseClause(o.reason) : clause(o.reason)] };
    const m = o.reason.match(/(\d+) checks? ran \(\d+ hold, \d+ fail\); the judge's verdict counted: (\w+)/);
    return { label, parts: [[verbSpan(v)], m ? `${count(Number(m[1]), "check")}, judge ${m[2]}` : clause(o.reason), count(a.receipts.split(",").filter(Boolean).length, "receipt"), [st, ` ${took}`]] };
  }
  if (a.kind === "fix") return { label, parts: [[st], a.status === "refused" ? refuseClause(o.reason) : clause(o.reason)] };
  if (a.status === "failed") return { label, parts: [[st], failClause(o.reason)] };
  if (a.status === "refused") return { label, parts: [[st], refuseClause(o.reason)] };
  const steps = a.kind === "rollback_file" ? ["nginx -t ok", "reloaded"] : [/^re-created/.test(o.reason) ? "re-created, read back equal" : "read back equal"];
  const end: Phrase[] = a.status === "done" ? [probeTally(o.record, a.verification), [st, ` ${took}`]] : [[st], a.status === "unverified" ? unverifiedWhy(o.reason) : clause(o.reason)];
  return { label, parts: [hashes(a.before_hash, a.after_hash), ...steps, ...end] };
}

/** What a plan item is about, from its first line. */
function planTarget(p: PlanItem): string {
  const first = p.lines[0] ?? "";
  let m = first.match(/^target (\S+) on (\S+) \(ssh alias/);
  if (m) return `${tail(m[1])} on ${m[2]}`;
  m = first.match(/^target record \S+ \(([^,]+), (\w+)\)/);
  if (m) return `${m[1]} ${m[2]}`;
  m = first.match(/^target (linux\.nginx|cloudflare\.dns) (.+?), [A-Z]+ under /);
  if (m) {
    const w = m[2].split(" ");
    return m[1] === "linux.nginx" && w.length >= 3 ? `${tail(w[1])} on ${w[0]}` : w.slice(0, 2).join(" ");
  }
  m = first.match(/^finding \S+: \S+ in (\S+?)(?: on (\S+?))?, [A-Z]+ under /);
  if (m) return `${tail(m[1])}${m[2] ? ` on ${m[2]}` : ""}`;
  return clause(first);
}

/** One line under the act row for a planned action (a dry run). */
export function planLine(p: PlanItem, all: readonly PlanItem[] = [p]): SubLine {
  const text = p.lines.join("\n");
  const refused: Phrase[] = p.refused ? [[{ text: "refused on --apply", tone: "dim" }], refuseClause(p.refused)] : [];
  const from = text.match(/(?:from|at) vault commit ([0-9a-f]{8})/);
  const commit = from ? `from vault ${from[1]}` : null;
  if (p.kind === "fix") return { label: p.kind, parts: refused.length ? refused : [clause(p.lines[0] ?? "")] };
  if (p.kind === "investigate") {
    const named = (p.lines[0] ?? "").match(/, (FIX|ESCALATE) under /)?.[1] as Verb | undefined;
    const v: Verb = named ?? (all.some((x) => x.kind === "fix" && x.disposition_id === p.disposition_id) ? "FIX" : "ESCALATE");
    return { label: p.kind, parts: [[verbSpan(v)], planTarget(p), ...(refused.length ? refused : ["checks, then the judge"])] };
  }
  if (refused.length) return { label: p.kind, parts: [planTarget(p), ...refused] };
  const probes = text.match(/then probes http and tls of (.+)$/m);
  const then = p.kind === "rollback_file" ? `then nginx -t, reload, ${probes ? count(probes[1].split(", ").length, "probe") : "no probe"}` : "then read back, dns probe";
  return { label: p.kind, parts: [planTarget(p), ...(commit ? [commit] : []), then] };
}

/** act: the actions done (applied) or planned (dry run), one line each. */
export function actView(res: Pick<ActResult, "apply" | "plan" | "outcomes" | "acted">): StepView {
  const items = res.apply ? res.outcomes.length : res.plan.length;
  const already: Phrase[] = res.acted.length ? [`${count(res.acted.length, "action")} already recorded`] : [];
  if (!items) return { parts: ["nothing to do", ...already] };
  return {
    parts: [res.apply ? count(items, "action") : `${count(items, "action")} planned`, ...already],
    sub: res.apply ? res.outcomes.map((o) => outcomeLine(o, res.outcomes)) : res.plan.map((p) => planLine(p, res.plan)),
    labelWidth: "rollback_file".length,
  };
}

/** One ticket operation as it went: "#5 change · opened and closed". */
export function ticketPhrases(op: Exclude<TicketOp, { op: "skip" }>, o: TicketOutcome): Phrase[] {
  const ext = o.external_id ?? op.ticket.external_id;
  const ref = `${ext ? `#${ext}` : "new"} ${op.ticket.type}`;
  if (o.status === "created") return [ref, ...(/^created and commented/.test(o.line) ? ["opened", "left open, write unverified"] : ["opened"])];
  if (o.status === "closed") return [ref, op.op === "create" ? "opened and closed" : "closed"];
  if (o.status === "commented") return [ref, "commented"];
  if (o.status === "synced") return [ref, "closed in the PSA"];
  if (o.status === "refused" || o.status === "failed") return [ref, [statusSpan(o.status)], clause(o.line.split(": ").at(-1) ?? o.line)];
  return [ref, o.status];
}

/** tickets: what was sent, or what a dry run would send; "nothing to send" with the open count when the plan is all skips. */
export function ticketsView(r: { ops: readonly TicketOp[]; outcomes: readonly TicketOutcome[]; open: number }, dryRun: boolean): StepView {
  const pairs = r.ops.flatMap((op, i) => (op.op === "skip" || !r.outcomes[i] ? [] : [[op, r.outcomes[i]] as const]));
  if (!pairs.length) return { parts: ["nothing to send", `${thousands(r.open)} open`] };
  if (dryRun) {
    const would = { create: "would open", comment: "would comment on", close: "would close" } as const;
    const parts = (["create", "comment", "close"] as const).map((k) => [k, pairs.filter(([op]) => op.op === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${would[k]} ${n}`);
    const why = (reason: string): string => (/ is resolved in the pass/.test(reason) ? "resolved" : clause(reason, 48));
    return {
      parts,
      sub: pairs.map(([op]) => ({ parts: [`${op.ticket.external_id ? `#${op.ticket.external_id}` : "new"} ${op.ticket.type} ${op.ticket.priority}`, would[op.op], `${op.ticket.finding_id} ${why(op.reason)}`] })),
    };
  }
  const lines = pairs.map(([op, o]) => ticketPhrases(op, o));
  if (lines.length === 1) return { parts: lines[0] };
  return { parts: [count(lines.length, "ticket")], sub: lines.map((parts) => ({ parts })) };
}

export const documentView = (o: { file: string; lines: number }): StepView => ({ parts: [o.file, count(o.lines, "line")] });

/** A step's row when it gives no view: its summary less its "<step>: " lead ("collect:linux <alias>: ", "PASS: ", "validate:copies: "). */
export function summaryView(step: string, summary: string, subject?: string, alias = false): StepView {
  const m = summary.match(/^([A-Za-z]+)(?::\S+(?: \S+)?)?: /);
  const lead = m && m[1].toLowerCase() === step.split(/[: ]/)[0].toLowerCase() ? m[0].length : 0;
  return { subject, alias, parts: [summary.slice(lead)] };
}
