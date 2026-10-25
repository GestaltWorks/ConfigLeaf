// One cycle of the loop as a function over injectable steps: collect, probe, validate, pass, act, tickets, document,
// in that order. scripts/cycle.ts and scripts/watch.ts run it over the live steps (src/loop/steps.ts liveSteps); a
// test runs it over fakes.
//
// Contract:
//   - Steps, in order: collect:cloudflare, collect:linux <alias> for every alias given (LINUX_HOSTS live), probe,
//     validate, pass, act, tickets, document. `skip` names groups: collect (every collect step), probe, validate, act,
//     tickets, document; the pass runs in every cycle.
//   - Each step returns a StepReport: ok, its one summary line, the reason when it fails, detail lines for the trace.
//     A step that throws fails with its message. The first failing step stops the cycle: every later step is not run,
//     and the result names the step and its reason.
//   - The collect steps hand their new vault commits to validate; the pass step hands its result to act, tickets and
//     document.
//   - The screen is the table of src/loop/present.ts: the header, then as each step ends its row (and the lines under
//     it) from the step's view, its summary when it gives none; a skipped step's row says so, a failing step's row is
//     red with its reason and the rows end there; the done line names the trace. --verbose prints
//     after each step's rows its full line, "cycle: [i/n] <step> <status> in <s> s: <summary>", and after the done
//     line the CYCLE summary line; --quiet prints the header and the done line only. A collect:linux row's subject
//     is the alias as given (a LINUX_HOSTS key, as the step's name carries it); every other text passes `scrub`.
//   - Every step gives one trace line (agent cycle, action triage, latency_ms the step's time); the cycle ends with
//     one CYCLE summary line, traced and returned. Printed text passes `scrub` (the tenant's redactor live); the
//     tracer redacts its own fields.
//
// Measured 24 Oct 2026: test/loop.test.ts runs it over fakes and over sql.js with the policy fixture; scripts/cycle.ts
// has the live run.

import { redact } from "../config.ts";
import type { Tracer } from "../trace.ts";
import type { PassStep } from "./pass.ts";
import { PLAIN, Table, passView, summaryView, type PresentOptions, type StepView } from "./present.ts";

export const SKIPPABLE = ["collect", "probe", "validate", "act", "tickets", "document"] as const;
export type Skippable = (typeof SKIPPABLE)[number];

/** `--skip` values, each a comma list, into the set of groups; an unknown name throws. */
export function parseSkip(values: readonly string[] | undefined): Set<Skippable> {
  const out = new Set<Skippable>();
  for (const v of (values ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean)) {
    if (!(SKIPPABLE as readonly string[]).includes(v)) throw new Error(`--skip takes ${SKIPPABLE.join(", ")}; got ${v}`);
    out.add(v as Skippable);
  }
  return out;
}

export interface StepReport {
  ok: boolean;
  summary: string;
  /** Why the step failed: the cycle's stop reason. */
  reason?: string;
  /** Lines for the trace only. */
  detail?: string[];
  /** The step's row on the screen (src/loop/present.ts); absent, the row carries the summary. */
  view?: StepView;
}

/** One vault commit a collect step made this cycle. */
export interface NewCommit { repo: string; commit: string }
export interface CollectReport extends StepReport { commits: NewCommit[] }
export interface PassReport extends StepReport { pass: PassStep | null }

export interface CycleSteps {
  collectCloudflare(): Promise<CollectReport>;
  collectLinux(alias: string): Promise<CollectReport>;
  probe(): Promise<StepReport>;
  validate(commits: readonly NewCommit[]): Promise<StepReport>;
  pass(): Promise<PassReport>;
  act(pass: PassStep): Promise<StepReport>;
  tickets(pass: PassStep): Promise<StepReport>;
  document(pass: PassStep): Promise<StepReport>;
}

export interface CycleOptions {
  tenant: string;
  apply: boolean;
  /** The host aliases collect:linux reads, in order. */
  aliases: readonly string[];
  skip: ReadonlySet<Skippable>;
}

export interface CycleIO {
  tracer?: Tracer;
  print?: (line: string) => void;
  /** Milliseconds, for step times; Date.now when absent. */
  clock?: () => number;
  /** Printed text through this; config.redact when absent. */
  scrub?: (s: string) => string;
  /** Colour, width, verbose, quiet; plain at 90 columns when absent. */
  present?: PresentOptions;
  /** The header's command and mode; "cycle" and "dry run" or "applied" when absent. */
  header?: { command?: string; mode?: string };
  /** The trace file the done line names. */
  trace?: string;
}

export type StepStatus = "ok" | "failed" | "skipped" | "not_run";
export interface StepLine { step: string; status: StepStatus; summary: string; ms: number }

export interface CycleResult {
  tenant: string;
  apply: boolean;
  steps: StepLine[];
  stopped: { step: string; reason: string } | null;
  ms: number;
  pass: PassStep | null;
  summary: string;
}

/** The step names of a cycle over these aliases, in order. */
export const stepNames = (aliases: readonly string[]): string[] =>
  ["collect:cloudflare", ...aliases.map((a) => `collect:linux ${a}`), "probe", "validate", "pass", "act", "tickets", "document"];

const seconds = (ms: number): string => (ms / 1000).toFixed(1);
const TRACE_STATUS = { ok: "ok", failed: "failed", skipped: "skipped", not_run: "skipped" } as const;

/** The step's name on the screen ("collect" of "collect:linux <alias>") and its subject when the name carries one; alias when it is a LINUX_HOSTS key. */
export function screenName(step: string): { name: string; subject?: string; alias: boolean } {
  const m = step.match(/^collect:(cloudflare|linux (.+))$/);
  return m ? { name: "collect", subject: m[2] ?? m[1], alias: m[2] !== undefined } : { name: step, alias: false };
}

export async function runCycle(opts: CycleOptions, steps: CycleSteps, io: CycleIO = {}): Promise<CycleResult> {
  const clock = io.clock ?? Date.now;
  const scrub = io.scrub ?? redact;
  const print = io.print ?? ((l: string) => console.log(l));
  const present = io.present ?? PLAIN;
  const table = new Table(present, scrub, ["cloudflare", ...opts.aliases]);
  const names = stepNames(opts.aliases);
  const lines: StepLine[] = [];
  let stopped = null as CycleResult["stopped"];
  const t0 = clock();
  print(table.header({ command: io.header?.command ?? "cycle", tenant: opts.tenant, at: new Date(t0), mode: io.header?.mode ?? (opts.apply ? "applied" : "dry run") }));

  const show = (step: string, status: StepStatus, summary: string, ms: number, view?: StepView): void => {
    if (present.quiet) return;
    const { name, subject, alias } = screenName(step);
    if (status === "skipped") print(table.skipped(name, subject, alias));
    else if (status === "failed") print(table.failed(name, stopped?.reason ?? summary, ms));
    else if (status === "ok") {
      // a collect:linux row's subject is the alias the cycle was given (opts.aliases), whatever the view's subject says
      const shown = view && alias ? { ...view, subject, alias } : view ?? summaryView(step, summary, subject, alias);
      for (const l of table.row(name, shown, ms)) print(l);
    }
  };

  const note = (step: string, status: StepStatus, summary: string, ms: number, detail?: readonly string[], view?: StepView): void => {
    const line: StepLine = { step, status, summary: scrub(summary), ms };
    lines.push(line);
    const i = lines.length;
    show(step, status, line.summary, ms, view);
    if (present.verbose) print(`cycle: [${i}/${names.length}] ${step} ${status.replace("_", " ")} in ${seconds(ms)} s: ${line.summary}`);
    io.tracer?.emit({
      agent: "cycle", action: "triage", status: TRACE_STATUS[status], input_summary: `cycle ${opts.tenant} [${i}/${names.length}] ${step}`,
      output_summary: line.summary.slice(0, 1000), latency_ms: ms, detail: detail?.length ? detail.join("\n").slice(0, 4000) : undefined,
    });
  };

  async function step<R extends StepReport>(name: string, group: Skippable | null, fn: () => Promise<R>): Promise<R | null> {
    if (stopped) {
      note(name, "not_run", `the cycle stopped at ${stopped.step}`, 0);
      return null;
    }
    if (group && opts.skip.has(group)) {
      note(name, "skipped", `skipped (--skip ${group})`, 0);
      return null;
    }
    const t = clock();
    let rep: R | StepReport;
    try {
      rep = await fn();
    } catch (e) {
      const msg = scrub(e instanceof Error ? e.message : String(e));
      rep = { ok: false, summary: `${name}: ${msg}`, reason: msg };
    }
    const ms = clock() - t;
    if (!rep.ok) {
      stopped = { step: name, reason: scrub(rep.reason ?? rep.summary) };
      note(name, "failed", rep.summary, ms, rep.detail);
      return null;
    }
    const pass = (rep as Partial<PassReport>).pass;
    note(name, "ok", rep.summary, ms, rep.detail, rep.view ?? (pass ? passView(pass) : undefined));
    return rep as R;
  }

  const commits: NewCommit[] = [];
  const cf = await step("collect:cloudflare", "collect", () => steps.collectCloudflare());
  if (cf) commits.push(...cf.commits);
  for (const alias of opts.aliases) {
    const host = await step(`collect:linux ${alias}`, "collect", () => steps.collectLinux(alias));
    if (host) commits.push(...host.commits);
  }
  await step("probe", "probe", () => steps.probe());
  await step("validate", "validate", () => steps.validate(commits));
  const passed = await step("pass", null, async () => {
    const r = await steps.pass();
    return r.ok && !r.pass ? { ...r, ok: false, reason: "the pass step returned no result" } : r;
  });
  const pass = passed?.pass ?? null;
  for (const [name, fn] of [["act", steps.act], ["tickets", steps.tickets], ["document", steps.document]] as const) {
    await step(name, name, () => fn.call(steps, pass!));
  }

  const ms = clock() - t0;
  const count = (s: StepStatus): number => lines.filter((l) => l.status === s).length;
  const mode = opts.apply ? "applied (act carries out its plan)" : "dry run (act plans and writes nothing to a host or a zone; --apply performs it)";
  const end = stopped ? `stopped at ${stopped.step}: ${stopped.reason}` : "completed";
  const summary = scrub(`CYCLE: tenant ${opts.tenant}, ${mode}: ${lines.length} step(s): ok ${count("ok")}, skipped ${count("skipped")}, failed ${count("failed")}, not run ${count("not_run")}; ${end}; ${seconds(ms)} s`);
  const at = lines.findIndex((l) => l.status === "failed") + 1;
  print(table.done({ ms, steps: names.length, skipped: count("skipped"), trace: io.trace, stopped: stopped ? { step: stopped.step, at, of: names.length } : undefined }));
  if (present.verbose) print(summary);
  io.tracer?.emit({ agent: "cycle", action: "triage", status: stopped ? "failed" : "ok", input_summary: `cycle ${opts.tenant}`, output_summary: summary.slice(0, 1000), latency_ms: ms });
  return { tenant: opts.tenant, apply: opts.apply, steps: lines, stopped, ms, pass, summary };
}
