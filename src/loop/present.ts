// The terminal view of npm run cycle, pass, act, tickets and watch: what a reader takes in at a glance. One header,
// one row per step with its time, an indented line under the pass for each finding the agent moves on (ROLLBACK, FIX,
// ESCALATE) and under act for each action, a cycle's "what happened" block, then one done line. The trace keeps every
// other fact, run ids included.
//
// Contract:
//   - Header: "ConfigLeaf · <command> · tenant <id> · <YYYY-MM-DD HH:MM> UTC · <mode>", the mode one of MODE's
//     "dry run, nothing changed" and "applying changes", "recorded" (a pass that writes the ledger) or "watch every
//     <n> min".
//   - Finding classes read in plain words (CLASS_LABEL, one map for the screen, the document and the replay page): the
//     pass's tally line, wrapped onto further indented lines at the width, and each finding line, the verb first, then
//     the class's words, then the object. An action line names its kind as the ledger does (rollback_file,
//     revert_record), then the object in plain words ("DNS record <name>", "<dir>/<file> on <host>").
//   - An investigation that is done names both Nemotron calls from its record (nemotronOf): the checks Lightning picked,
//     or the default checks when Lightning's selection held none, then Ultra's refuting SELECT with its row count and
//     verdict, each call's served model (its last path segment) and receipt id, wrapped at the width. A record without
//     the judge's line gives the count form: "<n> checks, judge <verdict> · <n> receipts". Its what-happened sentence
//     names Lightning and Ultra, each on a verified receipt, when Lightning picked the checks and Ultra ruled.
//   - What happened (whatHappened, a cycle's screen only): between the last row and the done line, at most STORY_MAX
//     sentences of one line each, built from the pass's findings, the explain step's causes, the act step's outcomes
//     or plan and the tickets step's operations: one per action, one for the tickets closed as resolved, one for the
//     findings with a technician, one for the findings adopted and held; "Nothing changed on the estate" when act ran
//     or was skipped and nothing moved. An action's sentence, and the technician's for an escalation no action
//     sentence names, carries its finding's cause on the same line, joined by a space (src/explain/ withRestore: the
//     stored sentence, with ", N minutes before the agent restored it" once the agent's rollback or revert wrote), so a
//     cause counts as part of its sentence under STORY_MAX. Omitted under --quiet.
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
//   - Zetaris: given the queries the pass sent (passView's second argument), the first line under the pass row reads
//     "Zetaris Lightning SQL over <datasource> · <n> queries · <n> rows · <n> failed", the failures red above 0, then
//     "file tables refreshed" when the pass put the lessons and the rules again (yellow "file tables not refreshed"
//     when the put failed, nothing when the copy was current), then, when the pass read it (src/loop/pass.ts AdoptionCheck), "DQ exception_in_force <n> of <n> adoptions" (red when
//     fewer hold than were read; " of the pass recorded at <YYYY-MM-DD HH:MM> UTC" after a pass with no ledger; yellow
//     "not read" when the read failed); given the cycle's tally, the done line names "<n> Zetaris queries, <n> failed"
//     before the trace.
//   - The callers print the old full line after a step's rows under --verbose (the old formatters stay) and only the
//     header and the done line under --quiet.
//
// Measured 25 Oct 2026: test/present.test.ts over fixed step results; the live screen is in scripts/cycle.ts.

import type { ActResult } from "../actions/act.ts";
import type { ActionOutcome, PlanItem } from "../actions/plan.ts";
import type { FindingClass } from "../catalogue/templates.ts";
import type { QueryTally } from "../data/engines/counting.ts";
import type { Action, FindingCause } from "../data/rows.ts";
import { withRestore } from "../explain/cause.ts";
import type { Finding, Verb } from "../pipeline.ts";
import type { TicketOp } from "../psa/index.ts";
import type { TicketOutcome } from "../psa/step.ts";
import type { HookResult } from "../vault/hook.ts";
import { dispositionIdOf, type AdoptionCheck, type PassStep } from "./pass.ts";

export type Tone = "bold" | "strong" | "red" | "yellow" | "green" | "dim";
export interface Span { text: string; tone: Tone }
export type Seg = string | Span;
/** One phrase of a detail: plain text, or text with coloured spans in it. */
export type Phrase = Seg | readonly Seg[];
/** One line under a row; `wrap` carries its parts onto further lines at the width, each starting where the first does. */
export interface SubLine { label?: Phrase; parts: readonly Phrase[]; wrap?: boolean }
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

/** The header's mode for a run that writes to the hosts and the zones, and for one that plans only. */
export const MODE = { applied: "applying changes", dryRun: "dry run, nothing changed" } as const;

/** Each finding class in plain words: the screen's tally and finding lines, the owner's document and the replay page. */
export const CLASS_LABEL: Readonly<Record<FindingClass, string>> = {
  proxied_without_real_ip: "proxied name, origin trusts no Cloudflare range",
  orphan_record: "DNS record with no site behind it",
  orphan_vhost: "site with no DNS record",
  found_but_different: "unchanged setting, its target moved",
  drift_vs_approved: "drifted from the approved value",
  approved_missing: "approved setting missing",
  changed_since_backup: "changed since the last backup",
  proxy_split: "name and its www treated differently by the proxy",
  dns_change: "DNS target moved",
};
/** A class in plain words; any other class as it is. */
export const classLabel = (c: string): string => (CLASS_LABEL as Readonly<Record<string, string>>)[c] ?? c;

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
  /** The queries the cycle sent through Zetaris (src/data/engines/counting.ts); absent, the line names none. */
  queries?: Pick<QueryTally, "queries" | "failed">;
}

/** The queries a step sent through Zetaris, with the datasource they read. */
export type ZetarisFacts = Pick<QueryTally, "queries" | "rows" | "failed"> & { datasource: string };

/** "<n> failed", red above 0. */
const failedSeg = (n: number): Seg => (n > 0 ? { text: `${thousands(n)} failed`, tone: "red" } : "0 failed");

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
    return paint(["ConfigLeaf", h.command, `tenant ${h.tenant}`, utcMinute(h.at), h.mode].map(this.clean).join(" · "), "bold", this.o.color);
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
      const lead = `${INDENT}${l ? `${l.ansi}${" ".repeat(w - l.plain.length + 2)}` : ""}`;
      if (!s.wrap) { out.push(`${lead}${this.join(s.parts).ansi}`); return; }
      // the parts in order, as many to a line as the width holds, at least one
      const at = INDENT.length + (l ? w + 2 : 0);
      const lines: Phrase[][] = [];
      for (const p of s.parts) {
        const last = lines.at(-1);
        if (last && at + this.join([...last, p]).plain.length <= this.o.width) last.push(p);
        else lines.push([p]);
      }
      lines.forEach((ps, k) => out.push(`${k ? " ".repeat(at) : lead}${this.join(ps).ansi}`));
    });
    return out;
  }

  /** The cycle's "what happened" block: a heading and one sentence a line; an empty list for an empty block. */
  story(sentences: readonly string[]): string[] {
    if (!sentences.length) return [];
    return [paint("what happened", "bold", this.o.color), ...sentences.map((s) => `  ${oneLine(this.clean(s))}`)];
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
    const q = d.queries ? [`${count(d.queries.queries, "Zetaris query", "Zetaris queries")}, ${paint(`${thousands(d.queries.failed)} failed`, d.queries.failed > 0 ? "red" : undefined, this.o.color)}`] : [];
    return [lead, seconds(d.ms), ...q, ...(d.trace ? [`trace ${this.clean(d.trace)}`] : [])].join(" · ");
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

/** A finding's object in plain words: "DNS record <name>", or a file as its last two segments on its host; the setting in brackets when asked for. */
export function findingObject(s: Finding["finding"], withSetting = false): string {
  if (s.surface === "cloudflare.dns") return `DNS record ${s.dns_name || s.object_id}${withSetting && s.setting_path ? ` (${s.setting_path})` : ""}`;
  const setting = withSetting && s.setting_path && s.setting_path !== "file" ? ` (${s.setting_path})` : "";
  return `${tail(s.object_id)}${setting}${s.host ? ` on ${s.host}` : ""}`;
}

/** A Decider's reason in its few words: the expiry that ran out, the copy and production it weighed. */
export function reasonClauses(reason: string): string[] {
  const held = reason.match(/hold under rule \S+ expired (\S+?);/);
  if (held) return [`the hold ran out at ${shortUtc(held[1])}, a technician owns it`];
  const lapsed = reason.match(/exception lapsed: \S+ expired (\S+?);/);
  if (lapsed) return [`the accepted exception ran out at ${shortUtc(lapsed[1])}, a technician owns it`];
  const out: string[] = [];
  if (/no valid copy/.test(reason)) out.push("no valid copy");
  const affected = reason.match(/production affected \((\d+) failing probes?/);
  if (affected) out.push(`production affected, ${count(Number(affected[1]), "failing probe")}`);
  else if (/production answering/.test(reason)) out.push("production answering");
  else if (/production is unknown|no probe run in this pass|no probe in \S+ targets a name it serves/.test(reason)) out.push("production unknown");
  return out.length ? out : [clause(reason)];
}

/** One line under the pass row, the verb first, then the class in plain words, then the object: ROLLBACK with the copy it restores; FIX and ESCALATE with why. */
export function findingLine(f: Finding): SubLine {
  const s = f.finding;
  const r = f.disposition.reason;
  if (f.verb !== "ROLLBACK") return { label: [verbSpan(f.verb)], parts: [classLabel(s.class), findingWhere(s, false), ...reasonClauses(r)] };
  const copy = r.match(/vault commit ([0-9a-f]{8}) holds the approved copy, validated (\w+) with (\d+) gaps?/);
  return {
    label: [verbSpan(f.verb)],
    parts: [
      classLabel(s.class),
      findingObject(s, true),
      ...(copy ? [`copy ${copy[1]} validated ${copy[2] === "ok_with_gaps" ? `ok with ${count(Number(copy[3]), "gap")}` : copy[2]}`] : []),
    ],
  };
}

/** The pass's read of exception_in_force as one phrase: "DQ exception_in_force 23 of 23 adoptions", red when one fails, yellow when not read. */
function adoptionSeg(a: AdoptionCheck): Seg {
  if ("error" in a) return { text: `DQ ${a.rule} not read`, tone: "yellow" };
  const of = a.of === "recorded" ? (a.decidedAt ? ` of the pass recorded at ${a.decidedAt.slice(0, 16).replace("T", " ")} UTC` : ", no pass recorded one") : "";
  const text = `DQ ${a.rule} ${thousands(a.inForce)} of ${count(a.adoptions, "adoption")}${of}`;
  return a.inForce < a.adoptions ? { text, tone: "red" } : text;
}

/** The file tables' refresh when it put the files or failed: "file tables refreshed", yellow "file tables not refreshed"; null when the copy was current. */
function filesSeg(r: NonNullable<PassStep["files"]>): Seg | null {
  if (r.status === "current") return null;
  return r.status === "failed" ? { text: "file tables not refreshed", tone: "yellow" } : "file tables refreshed";
}

/**
 * pass: the findings by verb; under it, given `zetaris`, the queries the pass sent through Zetaris (and, when the pass
 * read it, the DQ rule exception_in_force over its adoptions), then the classes in plain words, then one line per
 * ROLLBACK, FIX and ESCALATE.
 */
export function passView(p: Pick<PassStep, "findings"> & Partial<Pick<PassStep, "adoptions" | "files">>, zetaris?: ZetarisFacts): StepView {
  const fs = p.findings;
  const parts: Phrase[] = VERB_ORDER.map((v) => [v, fs.filter((f) => f.verb === v).length] as const).filter(([, n]) => n > 0).map(([v, n]) => [verbSpan(v), ` ${thousands(n)}`]);
  const sub: SubLine[] = [];
  if (zetaris) {
    const files = p.files ? filesSeg(p.files) : null;
    sub.push({ parts: [`Zetaris Lightning SQL over ${zetaris.datasource}`, count(zetaris.queries, "query", "queries"), count(zetaris.rows, "row"), [failedSeg(zetaris.failed)], ...(files ? [[files]] : []), ...(p.adoptions ? [[adoptionSeg(p.adoptions)]] : [])], wrap: true });
  }
  const classes = tallyDesc(fs.map((f) => f.finding.class));
  if (classes.length) sub.push({ parts: classes.map(([c, n]) => `${classLabel(c)} ${thousands(n)}`), wrap: true });
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

/** The findings of a pass and, when known, the instant it decided at: what names an action's object. */
export type PassFindings = Pick<PassStep, "findings"> & { decidedAt?: string };

/** The setting a finding is about as an action's target names it (src/actions/plan.ts targetOf). */
const targetKey = (s: Finding["finding"]): string => `${s.surface} ${s.host ? `${s.host} ` : ""}${s.object_id} ${s.setting_path}`;

/** The pass's finding an action or a plan item is for: by the disposition id the pass gave it, else by the action's target, a moving verb first. */
export function findingFor(pass: PassFindings | undefined, dispositionId: string, target?: string): Finding | undefined {
  if (!pass) return undefined;
  const { findings, decidedAt } = pass;
  const byId = decidedAt ? findings.find((f) => dispositionIdOf(f, decidedAt) === dispositionId) : undefined;
  if (byId || target === undefined) return byId;
  const same = findings.filter((f) => targetKey(f.finding) === target);
  return same.find((f) => MOVING.includes(f.verb)) ?? same[0];
}

/** An action's object in plain words: its finding's, else read off its target ("<surface> [<host>] <object> <setting>"). */
export function actionObject(a: Pick<Action, "target" | "disposition_id">, pass?: PassFindings): string {
  const f = findingFor(pass, a.disposition_id, a.target);
  if (f) return findingObject(f.finding);
  const w = a.target.split(" ");
  if (w[0] === "cloudflare.dns" && w.length >= 2) return `DNS record ${w[1]}`;
  return w.length >= 3 ? `${tail(w[2])} on ${w[1]}` : a.target;
}

/** One Nemotron call an investigation's record names: its receipt id and its served model, shortened. */
export interface NemotronCall { receipt: string; model: string }
export interface NemotronFacts {
  /** Lightning's gated selection and the valid checks it picked; null when the record holds no selection line. */
  lightning: (NemotronCall & { checks: number }) | null;
  /** Ultra's verdict on a gated receipt and the refuting SELECT's row count (null when it gave none); null when the record holds no such judge line. */
  judge: (NemotronCall & { status: "stands" | "refuted" | "invalid_output"; rows: number | null }) | null;
}

/** The lines src/actions/investigate.ts records for Lightning's gated selection and for the judge's verdict. */
const LIGHTNING_LINE = /^Lightning selection \(receipt (\S+), ([^,]+),.*?\): (\d+) valid checks?/;
const JUDGE_LINE = /^judge (stands|refuted|invalid_output) \(receipt (\S+), ([^,)]+).*?(?:, (\d+) rows?)?$/s;

/** A served model as its last path segment, less a ":free" suffix: openrouter/nvidia/nemotron-3-ultra-550b-a55b:free reads nemotron-3-ultra-550b-a55b. */
export const shortModel = (m: string): string => (m.split("/").at(-1) ?? m).replace(/:free$/, "");

/** The two Nemotron calls an investigation's record names, each null when its line is absent. */
export function nemotronOf(record: readonly string[]): NemotronFacts {
  let lightning: NemotronFacts["lightning"] = null;
  let judge: NemotronFacts["judge"] = null;
  for (const l of record) {
    const s: RegExpMatchArray | null = lightning ? null : l.match(LIGHTNING_LINE);
    if (s) lightning = { receipt: s[1], model: shortModel(s[2].trim()), checks: Number(s[3]) };
    const j: RegExpMatchArray | null = judge ? null : l.match(JUDGE_LINE);
    if (j) judge = { status: j[1] as "stands" | "refuted" | "invalid_output", receipt: j[2], model: shortModel(j[3].trim()), rows: j[4] === undefined ? null : Number(j[4]) };
  }
  return { lightning, judge };
}

/** Lightning's call when its selection held a valid check; null when the default checks ran. */
const lightningPicked = (n: NemotronFacts): NemotronFacts["lightning"] => (n.lightning && n.lightning.checks > 0 ? n.lightning : null);

/**
 * One line under the act row for an applied action. `all` gives an investigation its verb: FIX when a fix follows it
 * on the same disposition. A rollback_file or revert_record names its object, from `pass` when given. An investigation
 * that is done names its Nemotron calls when its record holds the judge's line, its parts wrapped at the width.
 */
export function outcomeLine(o: ActionOutcome, all: readonly ActionOutcome[] = [o], pass?: PassFindings): SubLine {
  const a = o.action;
  const took = seconds(Date.parse(a.finished_at ?? a.started_at) - Date.parse(a.started_at));
  const st = statusSpan(a.status);
  const label: Phrase = a.kind;
  if (a.kind === "investigate") {
    const v: Verb = all.some((x) => x.action.kind === "fix" && x.action.disposition_id === a.disposition_id) ? "FIX" : "ESCALATE";
    if (a.status !== "done") return { label, parts: [[verbSpan(v)], [st], a.status === "refused" ? refuseClause(o.reason) : clause(o.reason)] };
    const m = o.reason.match(/(\d+) checks? ran \(\d+ hold, \d+ fail\); the judge's verdict counted: (\w+)/);
    const n = nemotronOf(o.record);
    const picked = lightningPicked(n);
    if (n.judge && (picked || m)) {
      const j = n.judge;
      const checks: Phrase[] = picked ? [`Lightning picked ${count(picked.checks, "check")}`, `${picked.model} on ${picked.receipt}`] : [`default checks: ${thousands(Number(m![1]))}`];
      const verdict = `${j.rows === null ? "" : `${count(j.rows, "row")}, `}${j.status.replace(/_/g, " ")}`;
      return {
        label,
        parts: [[verbSpan(v)], ...checks, `Ultra's refuting SELECT: ${verdict}`, `${j.model} on ${j.receipt}`, picked ? "both receipts verified" : "receipt verified", [st, ` ${took}`]],
        wrap: true,
      };
    }
    return { label, parts: [[verbSpan(v)], m ? `${count(Number(m[1]), "check")}, judge ${m[2]}` : clause(o.reason), count(a.receipts.split(",").filter(Boolean).length, "receipt"), [st, ` ${took}`]] };
  }
  if (a.kind === "fix") return { label, parts: [[st], a.status === "refused" ? refuseClause(o.reason) : clause(o.reason)] };
  const object = actionObject(a, pass);
  if (a.status === "failed") return { label, parts: [object, [st], failClause(o.reason)] };
  if (a.status === "refused") return { label, parts: [object, [st], refuseClause(o.reason)] };
  const steps = a.kind === "rollback_file" ? ["nginx -t ok", "reloaded"] : [/^re-created/.test(o.reason) ? "re-created, provider confirms" : "provider confirms"];
  const end: Phrase[] = a.status === "done" ? [probeTally(o.record, a.verification), [st, ` ${took}`]] : [[st], a.status === "unverified" ? unverifiedWhy(o.reason) : clause(o.reason)];
  return { label, parts: [object, hashes(a.before_hash, a.after_hash), ...steps, ...end] };
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

/** act: the actions done (applied) or planned (dry run), one line each; `pass` names the objects of the applied ones. */
export function actView(res: Pick<ActResult, "apply" | "plan" | "outcomes" | "acted">, pass?: PassFindings): StepView {
  const items = res.apply ? res.outcomes.length : res.plan.length;
  const already: Phrase[] = res.acted.length ? [`${count(res.acted.length, "action")} already recorded`] : [];
  if (!items) return { parts: ["nothing to do", ...already] };
  return {
    parts: [res.apply ? count(items, "action") : `${count(items, "action")} planned`, ...already],
    sub: res.apply ? res.outcomes.map((o) => outcomeLine(o, res.outcomes, pass)) : res.plan.map((p) => planLine(p, res.plan)),
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

/** document: the page and its lines, then the owner's report beside it when one is written ("document.md · 181 lines · report.html"). */
export const documentView = (o: { file: string; lines: number; report?: string }): StepView => ({ parts: [o.file, count(o.lines, "line"), ...(o.report ? [o.report] : [])] });

/** Each cause class in a word, in the order the explain row lists them: people and tools, then the agent, then unknown. */
export const CAUSE_WORD: Readonly<Record<string, string>> = { operator_edit: "operator", automation: "automation", account_change: "account", token_change: "token", agent: "agent", unknown: "unknown" };

/** explain: the causes by class, "2 causes · operator 1 · unknown 1"; "nothing to explain" when the pass moved on nothing; the reason when it stopped. */
export function explainView(o: { causes: readonly { class: string }[]; stopped?: string }): StepView {
  if (o.stopped) return { subject: count(o.causes.length, "cause"), parts: [[{ text: "not explained", tone: "yellow" }], clause(o.stopped)] };
  if (!o.causes.length) return { subject: count(0, "cause"), parts: ["nothing to explain"] };
  const parts = Object.keys(CAUSE_WORD).map((k) => [CAUSE_WORD[k], o.causes.filter((c) => c.class === k).length] as const).filter(([, n]) => n > 0).map(([w, n]) => `${w} ${thousands(n)}`);
  return { subject: count(o.causes.length, "cause"), parts };
}

/** A step's row when it gives no view: its summary less its "<step>: " lead ("collect:linux <alias>: ", "PASS: ", "validate:copies: "). */
export function summaryView(step: string, summary: string, subject?: string, alias = false): StepView {
  const m = summary.match(/^([A-Za-z]+)(?::\S+(?: \S+)?)?: /);
  const lead = m && m[1].toLowerCase() === step.split(/[: ]/)[0].toLowerCase() ? m[0].length : 0;
  return { subject, alias, parts: [summary.slice(lead)] };
}

// ---- what happened ----------------------------------------------------------------------------------------------

/** What the act step did (applied) or planned (dry run). */
export type ActFacts = Pick<ActResult, "apply" | "plan" | "outcomes">;
/** What the tickets step did or planned: its operations and their outcomes, index for index. */
export interface TicketFacts { ops: readonly TicketOp[]; outcomes: readonly TicketOutcome[] }
/** One cause the explain step found (src/explain/), the fields the block reads: whose it is, and its stored sentence. */
export type CauseFacts = Pick<FindingCause, "disposition_id" | "finding_id" | "class" | "summary" | "occurred_at">;

export interface StoryInput {
  pass: PassFindings;
  /** The act step's result; null when act gave none. */
  act: ActFacts | null;
  /** Act ran to its end or was skipped: only then can the block say that nothing changed. */
  actSettled: boolean;
  /** The tickets step's result; null when tickets gave none. */
  tickets: TicketFacts | null;
  /** The explain step's causes, one per explained disposition; none when explain gave none. */
  causes?: readonly CauseFacts[];
}

/** The most sentences the block holds. */
export const STORY_MAX = 5;

interface Move { op: Exclude<TicketOp, { op: "skip" }>; out: TicketOutcome }
const UNTIL = "stays open until a pass finds it at its approved value";
const ROLLBACK_KINDS: readonly string[] = ["rollback_file", "revert_record"];
const ADOPTED_UNDER: Readonly<Record<string, string>> = { operator: "the technician's exceptions", policy: "policy rules", default: "the default checks" };
const list = (xs: readonly string[]): string => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const isAre = (n: number): string => (n === 1 ? "is" : "are");

const movesOf = (t: TicketFacts | null): Move[] =>
  t ? t.ops.flatMap((op, i) => (op.op === "skip" || !t.outcomes[i] ? [] : [{ op, out: t.outcomes[i] }])) : [];

const ticketName = (m: Move): string => {
  const ext = m.out.external_id ?? m.op.ticket.external_id;
  return ext ? `ticket #${ext}` : "a new ticket";
};

/** Where a ticket stands, as a clause; `opened` is what follows its name once it is created. */
function ticketState(m: Move, opened: string): string {
  const name = ticketName(m);
  if (m.out.status === "closed") return `${name} is closed`;
  if (m.out.status === "synced") return `${name} is closed in the PSA`;
  if (m.out.status === "created") return `${name} ${opened}`;
  if (m.out.status === "commented") return `${name} carries the update`;
  if (m.out.status === "planned") return `${name} ${m.op.op === "close" ? "is due to close" : m.op.op === "create" ? "is drafted" : "is due a comment"} (tickets dry run)`;
  return `${name} is ${m.out.status}`;
}

/** What a rollback is about: a record or a file that drifted, or one that went missing. */
function rollbackSubject(kind: string, f: Finding | undefined, reason = ""): string {
  const missing = f?.finding.class === "approved_missing" || /^re-created/.test(reason);
  if (kind === "revert_record") return missing ? "An approved DNS record went missing" : "A DNS record drifted from its approved value";
  return missing ? "An approved vhost file went missing" : "A vhost file drifted from its approved copy";
}

/** What an investigation is about: a FIX (production affected) or an ESCALATE under a rule that investigates. */
function investigateSubject(fix: boolean, f: Finding | undefined): string {
  const what = f ? ` (${classLabel(f.finding.class)})` : "";
  if (!fix) return `A finding${what} needs a technician`;
  return f && /no valid copy/.test(f.disposition.reason) ? "An approved setting with no valid copy affected production" : `A finding${what} affected production`;
}

/** The verification probes an action's record names as ok; the verification ids when the record names none. */
function okProbes(o: ActionOutcome): number {
  const rows = o.record.map((l) => l.match(PROBE_LINE)).filter((m): m is RegExpMatchArray => m !== null);
  return rows.length ? rows.filter((m) => m[3] === "ok").length : o.action.verification.split(",").filter(Boolean).length;
}

function rollbackSentence(o: ActionOutcome, f: Finding | undefined, m: Move | undefined): string {
  const a = o.action;
  const subject = rollbackSubject(a.kind, f, o.reason);
  const record = a.kind === "revert_record";
  const restored = record ? "the agent restored it from the vault copy, the provider confirmed it" : "the agent restored it, nginx reloaded";
  const ticket = (opened: string): string => (m ? `, and ${ticketState(m, opened)}` : "");
  if (a.status === "done") return `${subject}; ${restored}${record ? "" : `, ${count(okProbes(o), "probe")} passed`}${ticket("is open")}.`;
  if (a.status === "unverified") return `${subject}; ${restored}, and the change could not be verified from outside${m ? `; ${ticketState(m, UNTIL)}` : ""}.`;
  if (a.status === "failed") return `${subject}; the restore failed (${failClause(o.reason)})${ticket("is open for a technician")}.`;
  return `${subject}; the agent left it as it is (${refuseClause(o.reason)})${ticket("is open for a technician")}.`;
}

function investigateSentence(inv: ActionOutcome, fix: boolean, f: Finding | undefined, m: Move | undefined): string {
  const subject = investigateSubject(fix, f);
  const s = inv.action.status;
  const n = s === "done" ? nemotronOf(inv.record) : null;
  const judged = n && lightningPicked(n) && n.judge && n.judge.status !== "invalid_output" ? n.judge.status : null;
  const did = judged ? `Nemotron Lightning picked the checks and Nemotron Ultra's refuting SELECT ${judged === "stands" ? "left the claim standing" : "refuted the claim"}, each on a verified receipt`
    : s === "done" ? "the agent investigated with Nemotron"
    : s === "not_judged" ? `the agent ran its checks (${clause(inv.reason)})`
    : `the investigation stopped (${s === "refused" ? refuseClause(inv.reason) : clause(inv.reason)})`;
  if (!m) return `${subject}; ${did}.`;
  if (m.out.status === "created") return judged ? `${subject}; ${did}; the agent opened ${ticketName(m)} for a technician.` : `${subject}; ${did} and opened ${ticketName(m)} for a technician.`;
  return `${subject}; ${did}, and ${ticketState(m, "is open for a technician")}.`;
}

/** A dry run's sentence for one plan item; a fix goes with its investigation. */
function planSentence(p: PlanItem, all: readonly PlanItem[], f: Finding | undefined): string | null {
  if (p.kind === "fix") return null;
  const text = p.lines.join("\n");
  const subject = p.kind === "investigate"
    ? investigateSubject(all.some((x) => x.kind === "fix" && x.disposition_id === p.disposition_id) || /, FIX under /.test(p.lines[0] ?? ""), f)
    : rollbackSubject(p.kind, f, /^POST /m.test(text) ? "re-created" : "");
  if (p.refused) return `${subject}; a run with --apply leaves it as it is (${refuseClause(p.refused)}).`;
  if (p.kind === "investigate") return `${subject}; a run with --apply investigates it with Nemotron and opens a ticket for a technician.`;
  const from = text.match(/(?:from|at) vault commit ([0-9a-f]{8})/)?.[1];
  return `${subject}; a run with --apply restores it from ${from ? `vault copy ${from}` : "the vault copy"}${p.kind === "rollback_file" ? " and reloads nginx" : ""}.`;
}

/** A sentence with its finding's cause after it on the same line, when the explain step found one. */
type WithCause = (sentence: string, dispositionId: string, f: Finding | undefined) => string;

/** One sentence per action (an investigation and its fix are one), or per planned action in a dry run, each with its cause; the ticket moves they account for. */
function actionSentences(act: ActFacts, pass: PassFindings, moves: readonly Move[], because: WithCause): { sentences: string[]; used: Set<Move> } {
  const used = new Set<Move>();
  if (!act.apply) {
    return {
      sentences: act.plan.flatMap((p) => {
        const f = findingFor(pass, p.disposition_id);
        const s = planSentence(p, act.plan, f);
        return s === null ? [] : [because(s, p.disposition_id, f)];
      }),
      used,
    };
  }
  const sentences: string[] = [];
  for (const o of act.outcomes) {
    const a = o.action;
    const group = act.outcomes.filter((x) => x.action.disposition_id === a.disposition_id);
    if (a.kind === "fix" && group.some((x) => x.action.kind === "investigate")) continue;
    const f = findingFor(pass, a.disposition_id, a.target);
    const ids = group.map((x) => x.action.action_id);
    const m = moves.find((x) => (x.op.ticket.action_id !== null && ids.includes(x.op.ticket.action_id)) || (f !== undefined && x.op.ticket.finding_id === f.id));
    if (m) used.add(m);
    const s = ROLLBACK_KINDS.includes(a.kind) ? rollbackSentence(o, f, m)
      : a.kind === "investigate" ? investigateSentence(o, group.some((x) => x.action.kind === "fix"), f, m)
      : `The agent's ${a.kind} is ${a.status.replace(/_/g, " ")} (${clause(o.reason)}).`;
    sentences.push(because(s, a.disposition_id, f));
  }
  return { sentences, used };
}

/** The tickets of earlier actions and holds the step closes because the pass finds their settings at their approved values. */
function resolvedSentence(moves: readonly Move[]): string | null {
  const rs = moves.filter((m) => m.op.op === "close" && / is resolved in the pass/.test(m.op.reason) && ["closed", "synced", "planned"].includes(m.out.status));
  if (!rs.length) return null;
  const one = rs.length === 1;
  const kinds = [...new Set(rs.map((m) => (m.op.ticket.type === "change" ? "rollback" : "hold")))];
  const planned = rs.every((m) => m.out.status === "planned");
  const refs = list(rs.map((m) => `#${m.out.external_id ?? m.op.ticket.external_id}`));
  const from = one ? `an earlier ${kinds[0]}` : `earlier ${list(kinds.map((k) => `${k}s`))}`;
  const state = planned ? `${isAre(rs.length)} due to close` : `${isAre(rs.length)} closed`;
  const why = one ? "the setting holds its approved value" : "their settings hold their approved values";
  return `${one ? "Ticket" : "Tickets"} ${refs} from ${from} ${state}: ${why}${planned ? " (tickets dry run)" : ""}.`;
}

/** The pass's ESCALATE findings: the ones a technician owns. */
function escalationSentence(fs: readonly Finding[]): string | null {
  const esc = fs.filter((f) => f.verb === "ESCALATE");
  if (!esc.length) return null;
  if (esc.length === 1) return `1 finding is with a technician: ${classLabel(esc[0].finding.class)} at ${findingWhere(esc[0].finding, false)}.`;
  return `${count(esc.length, "finding")} are with a technician: ${tallyDesc(esc.map((f) => classLabel(f.finding.class))).map(([l, n]) => `${l} (${thousands(n)})`).join("; ")}.`;
}

/** The pass's ADOPT and HOLD findings: what stands as it is. */
function standingSentence(fs: readonly Finding[]): string | null {
  const adopt = fs.filter((f) => f.verb === "ADOPT");
  const hold = fs.filter((f) => f.verb === "HOLD");
  const parts: string[] = [];
  if (adopt.length) {
    const under = tallyDesc(adopt.map((f) => ADOPTED_UNDER[f.disposition.decided_by] ?? f.disposition.decided_by));
    const lead = `${count(adopt.length, "finding")} ${isAre(adopt.length)} adopted`;
    parts.push(under.length === 1 ? `${lead} under ${under[0][0]}` : `${lead}, ${list(under.map(([w, n]) => `${thousands(n)} under ${w}`))}`);
  }
  if (hold.length) parts.push(`${adopt.length ? thousands(hold.length) : count(hold.length, "finding")} ${isAre(hold.length)} held with an expiry`);
  return parts.length ? `${parts.join("; ")}.` : null;
}

/**
 * The cycle's "what happened" block, sentence by sentence, from the step results and nothing else: the actions (or
 * "Nothing changed on the estate" when act settled and neither act nor tickets moved), the tickets closed as
 * resolved, the findings with a technician, the findings adopted and held. An action's sentence carries its
 * finding's cause, and the technician's sentence the causes of the escalations no action sentence told, each on the
 * same line. At most STORY_MAX sentences: past it, the last action sentence counts the rest.
 */
export function whatHappened(i: StoryInput): string[] {
  const fs = i.pass.findings;
  const moves = movesOf(i.tickets);
  const causes = i.causes ?? [];
  // the actions that can have restored a setting: the applied ones (a dry run restores nothing)
  const wrote = i.act?.apply ? i.act.outcomes.map((o) => o.action) : [];
  const told = new Set<CauseFacts>();
  const causeOf = (dispositionId: string, f: Finding | undefined): CauseFacts | undefined =>
    causes.find((c) => c.disposition_id === dispositionId) ?? (f ? causes.find((c) => c.finding_id === f.id) : undefined);
  const because: WithCause = (s, dispositionId, f) => {
    const c = causeOf(dispositionId, f);
    if (!c) return s;
    told.add(c);
    return `${s} ${withRestore(c, wrote)}`;
  };
  const acted = i.act ? actionSentences(i.act, i.pass, moves, because) : { sentences: [], used: new Set<Move>() };
  const escalated = escalationSentence(fs);
  const untold = fs.filter((f) => f.verb === "ESCALATE")
    .map((f) => causeOf(i.pass.decidedAt ? dispositionIdOf(f, i.pass.decidedAt) : "", f))
    .filter((c): c is CauseFacts => c !== undefined && !told.has(c));
  const escalation = escalated && untold.length ? [escalated, ...new Set(untold.map((c) => withRestore(c, wrote)))].join(" ") : escalated;
  const rest = [resolvedSentence(moves.filter((m) => !acted.used.has(m))), escalation, standingSentence(fs)].filter((s): s is string => s !== null);
  const nothing = fs.length ? "Nothing changed on the estate; every finding stands as before." : "Nothing changed on the estate; the pass found every setting in order.";
  const lead = acted.sentences.length || moves.length || !i.actSettled ? acted.sentences : [nothing];
  const room = STORY_MAX - rest.length;
  const more = lead.length - room + 1;
  return [...(lead.length > room ? [...lead.slice(0, room - 1), `${count(more, "more action")} ${isAre(more)} listed under act.`] : lead), ...rest];
}
