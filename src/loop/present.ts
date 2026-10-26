// The terminal view of npm run cycle, pass, act, tickets, watch and sample: what a reader takes in at a glance. One header,
// one row per step with its time, under a row its facts one to a line (under the pass a block for each finding the
// agent moves on, ROLLBACK, FIX and ESCALATE; under act a block for each action), a cycle's "what happened" block, then
// one done line. The trace keeps every other fact, run ids included.
//
// Contract:
//   - Header: "ConfigLeaf · <command> · tenant <id> · <YYYY-MM-DD HH:MM> UTC · <mode>", the mode one of MODE's
//     "dry run, nothing changed" and "applying changes", "recorded" (a pass that writes the ledger) or "watch every
//     <n> min". It is the one line that never wraps.
//   - Width: the terminal's columns, from COLUMNS when it is a positive integer, else stdout's columns on a TTY, less
//     one on a TTY (a console that wraps at its last column then never wraps a full line early); DEFAULT_WIDTH (120)
//     otherwise. No line passes it: a line's phrases go to it whole, joined by " · ", as many as fit; the next starts
//     a line of its own in the same column; a phrase longer than a line breaks at its spaces, a word longer than one
//     is cut. Each line under a row is one fact (SubLine lines), wrapped the same way.
//   - Row: two spaces, the step name in 9 columns, a space, the subject in 13 columns (wider when a subject the table
//     is given up front is longer: a redacted host alias), a space, the detail, and on the row's first line only the
//     duration to one decimal, right-aligned to the width; the detail wraps in its own column. A view with no subject
//     starts its detail in the subject's column. The lines under a row start in the subject's column; a label is
//     padded to the longest label of its group, or the longest verb (ROLLBACK) under the pass and the longest kind
//     (rollback_file) under act, plus two spaces, and a fact's further lines start where its first line's text does.
//   - Finding classes read in plain words (CLASS_LABEL, one map for the screen, the document and the replay page).
//   - Under the pass, given the queries it sent through Zetaris (passView's second argument): "Zetaris <n> queries ·
//     <n> rows · <n> failed", the failures red above 0; "schema <n> tables as expected" when the pass ran the
//     source-schema guard (src/zetaris/schema-guard.ts; red "<ds>.<table> changed: <column>" when a column it reads is
//     missing or changed type, and under it, red, "<n> findings not checked on <surfaces>: nothing decided or
//     recorded"); "files lessons and rules refreshed in Zetaris" when the pass
//     put them again (yellow "... not refreshed" when the put failed, no line when the copy was current); "DQ
//     exception_in_force holds for <n> of <n> adoptions" when the pass read it (src/loop/pass.ts AdoptionCheck; red when
//     fewer hold than were read, " of the pass recorded at <YYYY-MM-DD HH:MM> UTC" after a pass with no ledger, yellow
//     "exception_in_force not read" when the read failed); "dns_inventory_current holds for <n> of <n> live records"
//     when the pass read it (src/loop/pass.ts DnsInventoryCheck), under the same label, red when fewer hold than the
//     DNS API returns (the provider changed since the last complete DNS run), yellow "dns_inventory_current not read"
//     when the read failed. When the pass ran the judge (src/agents/falsifier.ts), "judge <model> · <n> judged · <n> struck
//     · <n> held · <n> not counted", the model its last path segment, the not counted yellow above 0; yellow "not counted:
//     judge off · <n> findings" with DRIFT_JUDGE off, "not counted: no model configured · <n> findings" with no runtime
//     token, URL or judge model; no line when the pass ran no judge. Then "classes", one class a line, its count right-aligned
//     in the counts' width, two spaces, its words, the most first. Then one block per ROLLBACK, FIX and ESCALATE, in
//     that order, at most FINDING_LINES: the verb, coloured, and the class's words; the object on the next line; the
//     copy a ROLLBACK restores, or why a FIX or an ESCALATE goes as it does, on the third.
//   - Under act, one block per action: the kind and its object ("DNS record <name>", "<dir>/<file> on <host>"; an
//     investigation's verb before it) on the first line, then the status (with the action's time when done), what
//     the write did ("<before> → <after> · nginx -t ok · reloaded"), the verification or the reason, each on a line.
//     An investigation that is done names both Nemotron calls from its record (nemotronOf): the checks Lightning
//     picked, or the default checks when Lightning's selection held none, then Ultra's refuting SELECT with its row
//     count and verdict, each call's served model (its last path segment) and receipt id on a line of its own. A
//     record without the judge's line gives the count form: "<n> checks, judge <verdict>", "<n> receipts". A dry run's
//     block names the object, the vault commit and what follows, or "refused on --apply" and why. outcomeLine's parts
//     stay one phrase list for a reader that joins them on one line (src/document/report.ts).
//   - Under tickets, one line per operation, "#7 incident · opened", and an opened issue's title on the next line, two
//     columns in; one operation goes on the row itself.
//   - Under explain (explainedView in the cycle, causesView in the sample), one block per cause: the verb, the object
//     and the cause's class, then the cause's sentence on lines of its own; the errors after them.
//   - What happened (whatHappened, a cycle's screen only): after a blank line, the heading, then at most STORY_MAX
//     sentences, each wrapped at the width, two spaces in and its further lines four, built from the pass's findings,
//     the explain step's causes, the act step's outcomes or plan and the tickets step's operations: one per action,
//     one for the tickets closed as resolved, one for the findings with a technician, one for the findings adopted and
//     held; "Nothing changed on the estate" when act ran or was skipped and nothing moved. An action's sentence, and
//     the technician's for an escalation no action sentence names, carries its finding's cause after it, joined by a
//     space (src/explain/ withRestore: the stored sentence, with ", N minutes before the agent restored it" once the
//     agent's rollback or revert wrote), so a cause counts as part of its sentence under STORY_MAX. Omitted under
//     --quiet.
//   - Numbers carry thousands separators, durations one decimal, hashes and commits 8 hex; run ids stay in the trace
//     (the table rewrites one that a reason carries as "the run").
//   - Colour only when stdout is a TTY and NO_COLOR is unset or empty: ROLLBACK and FIX bold white, ESCALATE red, HOLD
//     yellow, ADOPT green; done green, failed red, unverified and not judged yellow, refused and skipped dim.
//   - Every text passes `scrub` (the tenant's redactor live) before it is measured and coloured. A collect row's
//     subject is the host's ssh alias as LINUX_HOSTS names it, shown as typed: the operator's own configuration, the
//     name the step carries ("collect:linux <alias>") and the one carrier test/leak.test.ts allows.
//   - A failing step is one red row, "<step> failed <reason, one line>", cut to the width; the done line then reads
//     "stopped at <step> · <i> of <n>".
//   - Done line: "done · <n> steps · <n> skipped · <s> s · <n> Zetaris queries, <n> failed · trace <file>", the
//     queries when the cycle's tally is given; past the width its phrases go on to a further line, two columns in.
//   - The callers print the old full line after a step's rows under --verbose (the old formatters stay) and only the
//     header and the done line under --quiet.
//   - Sample (npm run sample): the header's mode SAMPLE_HEADER_MODE, then one row per stage with no subject and no
//     time: load (under it the file tables), gate, observe, detect (one line per class, its count first), decide (the
//     verbs and the decision instant; under it memory, policy, DQ and ledger, then the ROLLBACK, FIX and ESCALATE
//     blocks as the pass row gives them), explain (one block per cause), document and report (the file, its bytes,
//     "written" or "same bytes as on disk"), judge ("skipped, no model in sample mode"); then what happened and the
//     done line.
//
// Measured 26 Oct 2026: test/present.test.ts over fixed step results, a whole cycle among them at 100 and 160 columns;
// the live screen is in scripts/cycle.ts.

import type { ActResult } from "../actions/act.ts";
import { unavailableLabel } from "../agents/falsifier.ts";
import type { ActionOutcome, PlanItem } from "../actions/plan.ts";
import type { FindingClass } from "../catalogue/templates.ts";
import type { QueryTally } from "../data/engines/counting.ts";
import type { Action, FindingCause } from "../data/rows.ts";
import { withRestore } from "../explain/cause.ts";
import type { Finding, Verb } from "../pipeline.ts";
import type { TicketOp } from "../psa/index.ts";
import type { TicketOutcome } from "../psa/step.ts";
import type { HookResult } from "../vault/hook.ts";
import { schemaText } from "../zetaris/schema-guard.ts";
import { dispositionIdOf, type AdoptionCheck, type DnsInventoryCheck, type PassStep } from "./pass.ts";

export type Tone = "bold" | "strong" | "red" | "yellow" | "green" | "dim";
export interface Span { text: string; tone: Tone }
export type Seg = string | Span;
/** One phrase of a detail: plain text, or text with coloured spans in it. */
export type Phrase = Seg | readonly Seg[];
/**
 * One line under a row, or one block of lines. `parts` are its phrases in order, joined by " · " where they fit (a
 * reader that wants one line, the owner's report, joins them). `lines`, when given, is how the screen breaks them: one
 * fact a line, each group starting a line of its own in the column the first starts in. `indent`: columns further in
 * than the other lines under the row.
 */
export interface SubLine { label?: Phrase; parts: readonly Phrase[]; lines?: readonly (readonly Phrase[])[]; indent?: number }
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
/** The width when neither COLUMNS nor a terminal gives one. */
export const DEFAULT_WIDTH = 120;
/** Finding blocks under the pass row, and cause blocks under the explain row; the rest are counted in one line. */
export const FINDING_LINES = 12;
const INDENT = " ".repeat(2 + STEP_WIDTH + 1);

/** Plain text at 90 columns, the rows and the done line: the tests' fixed screen. */
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

/** The options for this process's stdout: colour from the terminal, width from COLUMNS or the terminal, verbose and quiet from the flags. */
export function presentOptions(flags: { verbose?: boolean; quiet?: boolean } = {}, out: { isTTY?: boolean; columns?: number } = process.stdout, env: NodeJS.ProcessEnv = process.env): PresentOptions {
  const tty = out.isTTY === true;
  const set = Number(env.COLUMNS);
  const columns = Number.isInteger(set) && set > 0 ? set : tty && out.columns ? out.columns : 0;
  return {
    color: tty && !env.NO_COLOR,
    width: columns ? columns - (tty ? 1 : 0) : DEFAULT_WIDTH,
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

/** A run of text on one screen line, in one tone or none. */
interface Piece { text: string; tone?: Tone }
type Line = Piece[];
const widthOf = (l: Line): number => l.reduce((n, p) => n + p.text.length, 0);
const SEP: Piece = { text: " · " };

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

/** The queries a step sent through Zetaris, with the datasource they read (the summary names it; the pass row gives the counts). */
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

  /** A phrase as pieces: each segment's text through the redactor, on one line, with its tone. */
  private pieces(p: Phrase): Piece[] {
    return segsOf(p).map((s) => (typeof s === "string" ? { text: this.clean(s) } : { text: this.clean(s.text), tone: s.tone }))
      .map((x) => ({ ...x, text: x.text.replace(/\s*\n\s*/g, " ") })).filter((x) => x.text !== "");
  }

  /**
   * The phrases as lines, the first at most `first` columns and the rest at most `rest`: whole phrases joined by " · "
   * while they fit, the next on a line of its own; a phrase longer than a line breaks at its spaces (its leading
   * spaces kept, a count's alignment), a word longer than a line is cut.
   */
  private fit(phrases: readonly Phrase[], first: number, rest: number): Line[] {
    const lines: Line[] = [[]];
    let used = 0;
    const room = (): number => Math.max(8, lines.length === 1 ? first : rest);
    const put = (p: Piece): void => { lines.at(-1)!.push(p); used += p.text.length; };
    const newline = (): void => { lines.push([]); used = 0; };
    for (const phrase of phrases) {
      const ps = this.pieces(phrase);
      const len = widthOf(ps);
      if (!len) continue;
      if (used && used + SEP.text.length + len <= room()) { put(SEP); ps.forEach(put); continue; }
      if (used) newline();
      if (len <= room()) { ps.forEach(put); continue; }
      let start = true;
      let gap: Piece | null = null;
      for (const p of ps) {
        for (const tok of p.text.split(/( +)/).filter(Boolean)) {
          const piece = { text: tok, tone: p.tone };
          if (tok.startsWith(" ")) {
            if (start) put(piece);
            else gap = piece;
            continue;
          }
          start = false;
          if (used + (gap?.text.length ?? 0) + tok.length <= room()) {
            if (gap && used) put(gap);
            put(piece);
          } else {
            // a line that holds only the phrase's leading spaces is dropped, not left blank
            if (lines.at(-1)!.every((x) => !x.text.trim())) { lines[lines.length - 1] = []; used = 0; } else newline();
            let w = tok;
            for (let r = room(); w.length > r; r = room()) { put({ text: w.slice(0, r), tone: p.tone }); w = w.slice(r); newline(); }
            put({ text: w, tone: p.tone });
          }
          gap = null;
        }
      }
    }
    return lines;
  }

  /** A line painted: the pieces of one tone together. */
  private render(line: Line): string {
    const runs: Piece[] = [];
    for (const p of line) {
      const last = runs.at(-1);
      if (last && last.tone === p.tone) last.text += p.text;
      else runs.push({ ...p });
    }
    return runs.map((r) => paint(r.text, r.tone, this.o.color)).join("");
  }

  header(h: HeaderInfo): string {
    return paint(["ConfigLeaf", h.command, `tenant ${h.tenant}`, utcMinute(h.at), h.mode].map(this.clean).join(" · "), "bold", this.o.color);
  }

  /** The step's row, its time on the first line, and the lines under it, none past the width. */
  row(step: string, view: StepView, ms: number | null): string[] {
    const subject = view.subject === undefined ? "" : `${padTo(view.alias ? view.subject : this.clean(view.subject), this.subjectWidth)} `;
    const lead = `  ${padTo(step, STEP_WIDTH)} ${subject}`;
    const t = ms === null ? "" : seconds(ms);
    const room = this.o.width - lead.length;
    const [head, ...more] = this.fit(view.parts, t ? room - t.length - 2 : room, room);
    const out = [
      t ? `${lead}${this.render(head)}${" ".repeat(Math.max(2, room - widthOf(head) - t.length))}${t}` : `${lead}${this.render(head)}`.replace(/ +$/, ""),
      ...more.map((l) => `${" ".repeat(lead.length)}${this.render(l)}`),
    ];
    const sub = view.sub ?? [];
    const labels = sub.map((s) => (s.label === undefined ? null : this.fit([s.label], Infinity, Infinity)[0]));
    const w = Math.max(view.labelWidth ?? 0, ...labels.map((l) => (l ? widthOf(l) : 0)));
    sub.forEach((s, i) => {
      const l = labels[i];
      const lead = `${INDENT}${" ".repeat(s.indent ?? 0)}${l ? `${this.render(l)}${" ".repeat(w - widthOf(l) + 2)}` : ""}`;
      const at = INDENT.length + (s.indent ?? 0) + (l ? w + 2 : 0);
      // one fact a group, each group from a line of its own; a group with nothing in it prints no line
      const lines = (s.lines ?? [s.parts]).flatMap((g) => this.fit(g, this.o.width - at, this.o.width - at)).filter((x) => x.length);
      (lines.length ? lines : [[]]).forEach((x, k) => out.push(`${k ? " ".repeat(at) : lead}${this.render(x)}`.replace(/ +$/, "")));
    });
    return out;
  }

  /** The cycle's "what happened" block: a blank line, the heading, each sentence wrapped at the width, two columns in and four after its first line; an empty list for an empty block. */
  story(sentences: readonly string[]): string[] {
    if (!sentences.length) return [];
    const w = this.o.width;
    return ["", paint("what happened", "bold", this.o.color), ...sentences.flatMap((s) => this.fit([oneLine(s)], w - 2, w - 4).map((l, k) => `${k ? "    " : "  "}${this.render(l)}`))];
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

  /** The done line; past the width its phrases go on to further lines, two columns in, joined by newlines. */
  done(d: DoneInfo): string {
    const lead: Phrase[] = d.stopped
      ? [[{ text: `stopped at ${d.stopped.step}`, tone: "red" }], `${d.stopped.at} of ${d.stopped.of}`]
      : [[{ text: "done", tone: "green" }], ...(d.steps === undefined ? [] : [count(d.steps, "step")]), ...(d.skipped ? [`${d.skipped} skipped`] : [])];
    const q: Phrase[] = d.queries ? [[`${count(d.queries.queries, "Zetaris query", "Zetaris queries")}, `, d.queries.failed > 0 ? { text: `${thousands(d.queries.failed)} failed`, tone: "red" } : `${thousands(d.queries.failed)} failed`]] : [];
    const lines = this.fit([...lead, seconds(d.ms), ...q, ...(d.trace ? [`trace ${d.trace}`] : [])], this.o.width, this.o.width - 2);
    return lines.map((l, k) => `${k ? "  " : ""}${this.render(l)}`).join("\n");
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

/** A block of lines under a row: one group of phrases a line, the parts the groups in order. */
const block = (label: Phrase | undefined, lines: readonly (readonly Phrase[])[]): SubLine => ({ ...(label === undefined ? {} : { label }), parts: lines.flat(), lines });

/** One block under the pass row: the verb, then the class in plain words; the object; then the copy a ROLLBACK restores, or why a FIX or an ESCALATE goes as it does. */
export function findingLine(f: Finding): SubLine {
  const s = f.finding;
  const r = f.disposition.reason;
  const label: Phrase = [verbSpan(f.verb)];
  if (f.verb !== "ROLLBACK") return block(label, [[classLabel(s.class)], [findingWhere(s, false)], reasonClauses(r)]);
  const copy = r.match(/vault commit ([0-9a-f]{8}) holds the approved copy, validated (\w+) with (\d+) gaps?/);
  return block(label, [
    [classLabel(s.class)],
    [findingObject(s, true)],
    ...(copy ? [[`copy ${copy[1]} validated ${copy[2] === "ok_with_gaps" ? `ok with ${count(Number(copy[3]), "gap")}` : copy[2]}`]] : []),
  ]);
}

/** The pass's read of exception_in_force: "exception_in_force holds for 23 of 23 adoptions", red when one fails, yellow when not read. */
function adoptionSeg(a: AdoptionCheck): Seg {
  if ("error" in a) return { text: `${a.rule} not read`, tone: "yellow" };
  const of = a.of === "recorded" ? (a.decidedAt ? ` of the pass recorded at ${a.decidedAt.slice(0, 16).replace("T", " ")} UTC` : ", no pass recorded one") : "";
  const text = `${a.rule} holds for ${thousands(a.inForce)} of ${count(a.adoptions, "adoption")}${of}`;
  return a.inForce < a.adoptions ? { text, tone: "red" } : text;
}

/** The pass's read of dns_inventory_current: "dns_inventory_current holds for 58 of 58 live records", red when one fails, yellow when not read. */
function dnsSeg(d: DnsInventoryCheck): Seg {
  if ("error" in d) return { text: `${d.rule} not read`, tone: "yellow" };
  const text = `${d.rule} holds for ${thousands(d.current)} of ${count(d.live, "live record")}`;
  return d.current < d.live ? { text, tone: "red" } : text;
}

/** The file tables' refresh when it put the files or failed: "lessons and rules refreshed in Zetaris", yellow when not; null when the copy was current. */
function filesSeg(r: NonNullable<PassStep["files"]>): Seg | null {
  if (r.status === "current") return null;
  return r.status === "failed" ? { text: "lessons and rules not refreshed in Zetaris", tone: "yellow" } : "lessons and rules refreshed in Zetaris";
}

/** The classes of the findings, one a line under the label "classes", the most first, each count right-aligned in the counts' width. */
function classLines(fs: readonly Pick<Finding, "finding">[]): SubLine[] {
  const classes = tallyDesc(fs.map((f) => f.finding.class));
  const w = Math.max(0, ...classes.map(([, n]) => thousands(n).length));
  return classes.map(([c, n], i) => ({ label: i ? "" : "classes", parts: [`${thousands(n).padStart(w)}  ${classLabel(c)}`] }));
}

/**
 * pass: the findings by verb; under it, given `zetaris`, the queries the pass sent through Zetaris, the file tables'
 * refresh and, when the pass read them, the DQ rule exception_in_force over its adoptions and dns_inventory_current
 * over the live records, each on a line; then the classes in plain words, one a line; then one block per ROLLBACK, FIX
 * and ESCALATE.
 */
export function passView(p: Pick<PassStep, "findings"> & Partial<Pick<PassStep, "adoptions" | "dns" | "files" | "schema" | "notChecked">> & { pass?: Pick<PassStep["pass"], "judge"> }, zetaris?: ZetarisFacts): StepView {
  const fs = p.findings;
  const parts: Phrase[] = VERB_ORDER.map((v) => [v, fs.filter((f) => f.verb === v).length] as const).filter(([, n]) => n > 0).map(([v, n]) => [verbSpan(v), ` ${thousands(n)}`]);
  const sub: SubLine[] = [];
  if (zetaris) {
    sub.push({ label: "Zetaris", parts: [count(zetaris.queries, "query", "queries"), count(zetaris.rows, "row"), [failedSeg(zetaris.failed)]] });
    if (p.schema) {
      const text = schemaText(p.schema);
      sub.push({ label: "schema", parts: [[p.schema.changes.length ? { text, tone: "red" } : text]] });
      const nc = p.notChecked ?? [];
      if (nc.length) {
        const surfaces = [...new Set(nc.map((f) => f.finding.surface))].sort().join(", ");
        sub.push({ label: "", parts: [[{ text: `${count(nc.length, "finding")} not checked on ${surfaces}: nothing decided or recorded`, tone: "red" }]] });
      }
    }
    const files = p.files ? filesSeg(p.files) : null;
    if (files) sub.push({ label: "files", parts: [[files]] });
    if (p.adoptions) sub.push({ label: "DQ", parts: [[adoptionSeg(p.adoptions)]] });
    if (p.dns) sub.push({ label: p.adoptions ? "" : "DQ", parts: [[dnsSeg(p.dns)]] });
  }
  const j = p.pass?.judge;
  if (j?.unavailable) sub.push({ label: "judge", parts: [[{ text: `not counted: ${unavailableLabel(j.unavailable)}`, tone: "yellow" }], count(j.not_counted, "finding")] });
  else if (j) {
    const notCounted = `${thousands(j.not_counted)} not counted`;
    sub.push({ label: "judge", parts: [shortModel(j.model), `${thousands(j.judged)} judged`, `${thousands(j.struck)} struck`, `${thousands(j.held)} held`, [j.not_counted > 0 ? { text: notCounted, tone: "yellow" } : notCounted]] });
  }
  sub.push(...classLines(fs));
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
 * One block under the act row for an applied action: the kind, and the object (an investigation's verb before it),
 * then the status, what the write did, the verification or the reason, one a line. `all` gives an investigation its
 * verb: FIX when a fix follows it on the same disposition. The object comes from `pass` when given, else from the
 * action's target. An investigation that is done names its Nemotron calls when its record holds the judge's line, each
 * served model with its receipt id on a line of its own. `parts`, the facts as one list, leave out an investigation's
 * and a fix's object (the owner's report joins them on one line under its finding).
 */
export function outcomeLine(o: ActionOutcome, all: readonly ActionOutcome[] = [o], pass?: PassFindings): SubLine {
  const a = o.action;
  const took = seconds(Date.parse(a.finished_at ?? a.started_at) - Date.parse(a.started_at));
  const st = statusSpan(a.status);
  const label: Phrase = a.kind;
  const object = actionObject(a, pass);
  /** The block: `parts` for one line, `lines` for the screen. */
  const lines = (parts: readonly Phrase[], screen: readonly (readonly Phrase[])[]): SubLine => ({ label, parts, lines: screen });
  if (a.kind === "investigate") {
    const v: Verb = all.some((x) => x.action.kind === "fix" && x.action.disposition_id === a.disposition_id) ? "FIX" : "ESCALATE";
    const head: Phrase[] = [[verbSpan(v)], object];
    if (a.status !== "done") {
      const why = a.status === "refused" ? refuseClause(o.reason) : clause(o.reason);
      return lines([[verbSpan(v)], [st], why], [head, [[st]], [why]]);
    }
    const m = o.reason.match(/(\d+) checks? ran \(\d+ hold, \d+ fail\); the judge's verdict counted: (\w+)/);
    const n = nemotronOf(o.record);
    const picked = lightningPicked(n);
    if (n.judge && (picked || m)) {
      const j = n.judge;
      const checks: Phrase[] = picked ? [`Lightning picked ${count(picked.checks, "check")}`, `${picked.model} on ${picked.receipt}`] : [`default checks: ${thousands(Number(m![1]))}`];
      const verdict = `${j.rows === null ? "" : `${count(j.rows, "row")}, `}${j.status.replace(/_/g, " ")}`;
      const ultra: Phrase[] = [`Ultra's refuting SELECT: ${verdict}`, `${j.model} on ${j.receipt}`, picked ? "both receipts verified" : "receipt verified"];
      return lines([[verbSpan(v)], ...checks, ...ultra, [st, ` ${took}`]], [head, [[st, ` ${took}`]], ...[...checks, ...ultra].map((p) => [p])]);
    }
    const tally = m ? `${count(Number(m[1]), "check")}, judge ${m[2]}` : clause(o.reason);
    const receipts = count(a.receipts.split(",").filter(Boolean).length, "receipt");
    return lines([[verbSpan(v)], tally, receipts, [st, ` ${took}`]], [head, [[st, ` ${took}`]], [tally], [receipts]]);
  }
  if (a.kind === "fix") {
    const why = a.status === "refused" ? refuseClause(o.reason) : clause(o.reason);
    return lines([[st], why], [[object], [[st]], [why]]);
  }
  if (a.status === "failed") return lines([object, [st], failClause(o.reason)], [[object], [[st]], [failClause(o.reason)]]);
  if (a.status === "refused") return lines([object, [st], refuseClause(o.reason)], [[object], [[st]], [refuseClause(o.reason)]]);
  const wrote: Phrase[] = [hashes(a.before_hash, a.after_hash), ...(a.kind === "rollback_file" ? ["nginx -t ok", "reloaded"] : [/^re-created/.test(o.reason) ? "re-created, provider confirms" : "provider confirms"])];
  if (a.status === "done") {
    const probes = probeTally(o.record, a.verification);
    return lines([object, ...wrote, probes, [st, ` ${took}`]], [[object], [[st, ` ${took}`]], wrote, [probes]]);
  }
  const why = a.status === "unverified" ? unverifiedWhy(o.reason) : clause(o.reason);
  return lines([object, ...wrote, [st], why], [[object], [[st]], wrote, [why]]);
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

/**
 * One block under the act row for a planned action (a dry run): the kind and the object (an investigation's verb
 * before it; a fix names its investigation's object), then the vault commit and what follows, or "refused on --apply"
 * and why, one a line.
 */
export function planLine(p: PlanItem, all: readonly PlanItem[] = [p]): SubLine {
  const text = p.lines.join("\n");
  const refused: Phrase[][] = p.refused ? [[[{ text: "refused on --apply", tone: "dim" }]], [refuseClause(p.refused)]] : [];
  const from = text.match(/(?:from|at) vault commit ([0-9a-f]{8})/);
  if (p.kind === "fix") {
    const inv = all.find((x) => x.kind === "investigate" && x.disposition_id === p.disposition_id);
    return block(p.kind, [...(inv ? [[planTarget(inv)]] : []), ...(refused.length ? refused : [[clause(p.lines[0] ?? "")]])]);
  }
  if (p.kind === "investigate") {
    const named = (p.lines[0] ?? "").match(/, (FIX|ESCALATE) under /)?.[1] as Verb | undefined;
    const v: Verb = named ?? (all.some((x) => x.kind === "fix" && x.disposition_id === p.disposition_id) ? "FIX" : "ESCALATE");
    return block(p.kind, [[[verbSpan(v)], planTarget(p)], ...(refused.length ? refused : [["checks, then the judge"]])]);
  }
  if (refused.length) return block(p.kind, [[planTarget(p)], ...refused]);
  const probes = text.match(/then probes http and tls of (.+)$/m);
  const then = p.kind === "rollback_file" ? `then nginx -t, reload, ${probes ? count(probes[1].split(", ").length, "probe") : "no probe"}` : "then read back, dns probe";
  return block(p.kind, [[planTarget(p)], ...(from ? [[`from vault ${from[1]}`]] : []), [then]]);
}

/** act: the actions done (applied) or planned (dry run), one block each; `pass` names the objects of the applied ones. */
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

/** An opened issue's title as the line under its operation, two columns in; none for a comment or a close. */
const titleLine = (op: Exclude<TicketOp, { op: "skip" }>): SubLine[] => (op.op === "create" && op.draft.title ? [{ parts: [op.draft.title], indent: 2 }] : []);

/**
 * tickets: what was sent, or what a dry run would send, one line per operation and an opened issue's title under it;
 * one operation goes on the row itself. "nothing to send" with the open count when the plan is all skips.
 */
export function ticketsView(r: { ops: readonly TicketOp[]; outcomes: readonly TicketOutcome[]; open: number }, dryRun: boolean): StepView {
  const pairs = r.ops.flatMap((op, i) => (op.op === "skip" || !r.outcomes[i] ? [] : [[op, r.outcomes[i]] as const]));
  if (!pairs.length) return { parts: ["nothing to send", `${thousands(r.open)} open`] };
  if (dryRun) {
    const would = { create: "would open", comment: "would comment on", close: "would close" } as const;
    const parts = (["create", "comment", "close"] as const).map((k) => [k, pairs.filter(([op]) => op.op === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${would[k]} ${n}`);
    const why = (reason: string): string => (/ is resolved in the pass/.test(reason) ? "resolved" : clause(reason, 48));
    return {
      parts,
      sub: pairs.flatMap(([op]) => [{ parts: [`${op.ticket.external_id ? `#${op.ticket.external_id}` : "new"} ${op.ticket.type} ${op.ticket.priority}`, would[op.op], `${op.ticket.finding_id} ${why(op.reason)}`] }, ...titleLine(op)]),
    };
  }
  const lines = pairs.map(([op, o]) => ticketPhrases(op, o));
  if (lines.length === 1) {
    const title = titleLine(pairs[0][0]);
    return title.length ? { parts: lines[0], sub: title } : { parts: lines[0] };
  }
  return { parts: [count(lines.length, "ticket")], sub: pairs.flatMap(([op], i) => [{ parts: lines[i] }, ...titleLine(op)]) };
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

/** One block per cause, at most FINDING_LINES: the finding's verb, its object (its class when the finding is not given) and the cause's class, then the cause's sentence on lines of its own; then the errors, one a line. */
function causeLines(causes: readonly SampleCause[], findings: readonly Finding[], errors: readonly string[]): SubLine[] {
  const sub: SubLine[] = causes.slice(0, FINDING_LINES).map((c) => {
    const f = findings.find((x) => x.id === c.finding_id);
    return block([verbSpan(c.verb)], [[f ? findingObject(f.finding) : classLabel(c.finding_class), CAUSE_WORD[c.cause.class] ?? c.cause.class], [c.cause.summary]]);
  });
  if (causes.length > FINDING_LINES) sub.push({ parts: [`${thousands(causes.length - FINDING_LINES)} more in the trace`] });
  for (const e of errors) sub.push({ parts: [clause(e)] });
  return sub;
}

/** The cycle's explain row: the step's row (explainView), its errors counted in yellow, and under it one block per cause, as the sample's explain row gives them. */
export function explainedView(view: StepView, r: { causes: readonly SampleCause[]; errors?: readonly string[] }, findings: readonly Finding[]): StepView {
  const errors = r.errors ?? [];
  return { ...view, parts: [...view.parts, ...(errors.length ? [[{ text: count(errors.length, "error"), tone: "yellow" }] as Phrase] : [])], sub: causeLines(r.causes, findings, errors), labelWidth: "ROLLBACK".length };
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

// ---- the sample's stages ----------------------------------------------------------------------------------------
//
// npm run sample (scripts/sample.ts) prints the same table over the recorded bundle: the header with SAMPLE_HEADER_MODE,
// then one row per stage with no subject and no time (one call runs gate to decide; the done line carries the time):
// load, gate, observe, detect, decide, explain, document, report, judge; then the cycle's "what happened" block and
// the done line.

/** The sample header's mode: the pass reads the recorded bundle and holds no credential. */
export const SAMPLE_HEADER_MODE = "recorded estate, no credentials";

/** load: the bundle, its runs and tenants, its rows and tables; under it, the file tables and where their rows come from. */
export function loadView(o: { file: string; counts: Readonly<Record<string, number>>; tenants: number; lessons: { rows: number; from: string }; rules: { rows: number; from: string } }): StepView {
  const tables = Object.values(o.counts);
  const rows = tables.reduce((n, k) => n + k, 0);
  return {
    parts: [o.file, `${count(o.counts.collection_run ?? 0, "run")} of ${count(o.tenants, "tenant")}`, `${count(rows, "row")} in ${count(tables.length, "table")}`],
    sub: [{ label: "files", parts: [`${count(o.lessons.rows, "lesson")} from ${o.lessons.from}`, `${count(o.rules.rows, "rule")} from ${o.rules.from}`] }],
  };
}

/** gate: the runs that pass the DQ gate of all the pass read; the ones that fail it in red. */
export function gateView(o: { runs: number; gatedOut: readonly string[] }): StepView {
  const out = o.gatedOut.length;
  return { parts: [`${thousands(o.runs - out)} of ${count(o.runs, "run")} pass the DQ gate`, ...(out ? [[{ text: `${count(out, "run")} fail it`, tone: "red" }] as Phrase] : [])] };
}

/** observe: the observations the pass put in the World Model. */
export const observeView = (observed: number): StepView => ({ parts: [`${count(observed, "observation")} in the World Model`] });

/** detect: the findings and their classes; under it, one line per class in plain words, the most first, its count right-aligned. */
export function detectView(fs: readonly Pick<Finding, "finding">[]): StepView {
  const classes = tallyDesc(fs.map((f) => f.finding.class));
  const w = Math.max(0, ...classes.map(([, n]) => thousands(n).length));
  return {
    parts: [`${count(fs.length, "finding")}${classes.length ? ` in ${count(classes.length, "class", "classes")}` : ""}`],
    sub: classes.map(([c, n]) => ({ label: thousands(n).padStart(w), parts: [classLabel(c)] })),
  };
}

export interface DecideFacts {
  findings: readonly Finding[];
  decidedAt: string;
  /** What the Decider recalled from the technician's memory; null when the pass was given none. */
  memory: { lessons: number; applied: number; lapsed: number } | null;
  /** exception_in_force over the pass's ADOPTs: those under an accepted exception, and those joined to a lesson in force at the decision instant. */
  adoptions: { adoptions: number; inForce: number } | null;
  /** The dispositions the ledger wrote, and the findings whose disposition reads back from it; null with no ledger. */
  ledger: { dispositions: number; readBack: number } | null;
}

/**
 * decide: the findings by verb and the decision instant; under it the technician's memory ("23 exceptions applied"),
 * the findings decided under policy rules and the default checks, the DQ rule exception_in_force over the adoptions,
 * the ledger, then one block per ROLLBACK, FIX and ESCALATE as the pass row gives it.
 */
export function decideView(d: DecideFacts): StepView {
  const fs = d.findings;
  const verbs: Phrase[] = VERB_ORDER.map((v) => [v, fs.filter((f) => f.verb === v).length] as const).filter(([, n]) => n > 0).map(([v, n]) => [verbSpan(v), ` ${thousands(n)}`]);
  const by = (who: string): number => fs.filter((f) => f.disposition.decided_by === who).length;
  const sub: SubLine[] = [];
  if (d.memory) sub.push({ label: "memory", parts: [count(d.memory.lessons, "lesson"), `${count(d.memory.applied, "exception")} applied`, `${thousands(d.memory.lapsed)} lapsed`] });
  const ruled: Phrase[] = [
    ...(by("policy") ? [`${count(by("policy"), "finding")} decided under policy rules`] : []),
    ...(by("default") ? [`${count(by("default"), "finding")} under the default checks`] : []),
  ];
  if (ruled.length) sub.push({ label: "policy", parts: ruled });
  if (d.adoptions) {
    const text = `exception_in_force holds for ${thousands(d.adoptions.inForce)} of ${thousands(d.adoptions.adoptions)} ADOPT under an exception`;
    sub.push({ label: "DQ", parts: [d.adoptions.inForce < d.adoptions.adoptions ? [{ text, tone: "red" }] : text] });
  }
  if (d.ledger) {
    const back = `${thousands(d.ledger.readBack)} of ${thousands(fs.length)} read back`;
    sub.push({ label: "ledger", parts: [`${count(d.ledger.dispositions, "disposition")} written`, d.ledger.readBack < fs.length ? [{ text: back, tone: "red" }] : back] });
  }
  const moving = MOVING.flatMap((v) => fs.filter((f) => f.verb === v));
  for (const f of moving.slice(0, FINDING_LINES)) sub.push(findingLine(f));
  if (moving.length > FINDING_LINES) sub.push({ parts: [`${thousands(moving.length - FINDING_LINES)} more in the trace`] });
  return { parts: [...verbs, `decided at ${utcMinute(new Date(d.decidedAt))}`], sub, labelWidth: "ROLLBACK".length };
}

/** One cause the explain step found, as the sample's explain row reads it: the finding's verb and class, the cause's class and sentence. */
export interface SampleCause { finding_id: string; verb: Verb; finding_class: string; cause: { class: string; summary: string } }

/** explain: the causes by class as explainView counts them ("1 cause · unknown 1"), the errors in yellow; under it one block per cause: the verb, the object and the cause's class, then its sentence. */
export function causesView(causes: readonly SampleCause[], findings: readonly Finding[], errors: readonly string[] = []): StepView {
  const head = explainView({ causes: causes.map((c) => c.cause) });
  const parts: Phrase[] = [head.subject ?? count(causes.length, "cause"), ...head.parts, ...(errors.length ? [[{ text: count(errors.length, "error"), tone: "yellow" }] as Phrase] : [])];
  return { parts, sub: causeLines(causes, findings, errors), labelWidth: "ROLLBACK".length };
}

/** document and report: the file, its size, its facts, and whether this run wrote it or found the same bytes on disk. */
export const fileView = (o: { file: string; bytes: number; facts?: readonly Phrase[]; written: boolean; sub?: readonly SubLine[] }): StepView => ({
  parts: [o.file, count(o.bytes, "byte"), ...(o.facts ?? []), o.written ? "written" : "same bytes as on disk"],
  ...(o.sub ? { sub: o.sub } : {}),
});

/** judge: no model runs in sample mode. */
export const judgeSkippedView = (): StepView => ({ parts: [[statusSpan("skipped"), ", no model in sample mode"]] });
