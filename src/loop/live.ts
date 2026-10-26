// The live cycle as scripts/cycle.ts and scripts/watch.ts run it: the checks that refuse a cycle before any read, the
// pieces one process shares across cycles (the Store, the tenant's redactor, the vault), and one cycle over the live
// steps with its own trace file.
//
// Contract:
//   - liveRefusal names the first missing piece the requested cycle needs, or returns null: SAMPLE_MODE off,
//     REDACT_SALT, DATABASE_URL and ZETARIS_API_KEY set; CLOUDFLARE_API_TOKEN when collect or probe runs or --apply
//     is given; LINUX_HOSTS when collect runs; DRIFT_TICKETS_REPO when the tickets step sends.
//   - liveCycle builds the pass's judge (src/agents/falsifier.ts liveJudge, the eval's C3 judge), a FileTracer
//     (logs/cycle_<base36 ms>.jsonl, model_requested none on a dry run with no Nightshift client), the DataLayer
//     over ZetarisEngine inside a CountingEngine (src/data/engines/counting.ts), the technician's lessons read from
//     the store DRIFT_MEMORY_DIR names (read only, so a cycle leaves a committed store as committed), and runs
//     src/loop/cycle.ts over liveSteps with the hosts of LINUX_HOSTS in their configured order. The document goes to
//     document.md at the repository root and the owner's report to report.html beside it (both gitignored), the
//     report naming the trace file and the repository's tip (git rev-parse, read once per cycle). Printed text passes the tenant's redactor; the screen is the
//     table of src/loop/present.ts: the pass row names the Lightning SQL queries the pass sent, and the done line the
//     cycle's Zetaris queries and the trace file.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { liveJudge } from "../agents/falsifier.ts";
import { HOSTS } from "../collectors/linux.ts";
import { config, redact } from "../config.ts";
import { DataLayer } from "../data/layer.ts";
import { repoTip } from "../document/report.ts";
import { CountingEngine } from "../data/engines/counting.ts";
import { ZetarisEngine } from "../data/engines/zetaris.ts";
import { Store } from "../data/store.ts";
import { TechnicianMemory } from "../engine/memory.ts";
import { Redactor } from "../redactor.ts";
import { Vault } from "../vault/vault.ts";
import { runCycle, type CycleResult, type Skippable } from "./cycle.ts";
import type { PresentOptions } from "./present.ts";
import { liveSteps } from "./steps.ts";
import { FileTracer } from "./trace.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface LiveCycleOptions {
  tenant: string;
  apply: boolean;
  skip: ReadonlySet<Skippable>;
  ticketsDryRun: boolean;
  print?: (line: string) => void;
  /** The screen's options and header (src/loop/present.ts); the plain table under "cycle" when absent. */
  present?: PresentOptions;
  header?: { command?: string; mode?: string };
}

/** The first thing the requested cycle lacks, as one sentence; null when it can run. */
export function liveRefusal(o: Pick<LiveCycleOptions, "apply" | "skip" | "ticketsDryRun">, env: NodeJS.ProcessEnv = process.env): string | null {
  if (config.sampleMode) return "the cycle reads and writes the live estate; SAMPLE_MODE=true npm run sample is the pass over the recorded bundle";
  if (!config.redactSalt) return "REDACT_SALT is blank: every row the cycle writes carries the tenant's pseudonyms under its salt";
  if (!env.DATABASE_URL) return "DATABASE_URL is blank: the cycle writes runs, dispositions, actions and tickets to the app Postgres";
  if (!config.zetaris.apiKey) return "ZETARIS_API_KEY is blank: the pass, the Actor, the ticket step and the document read through Zetaris";
  if ((!o.skip.has("collect") || !o.skip.has("probe") || o.apply) && !config.cloudflare.token) {
    return "CLOUDFLARE_API_TOKEN is blank: collect:cloudflare, probe and every applied record write read the account through it";
  }
  if (!o.skip.has("collect") && !Object.keys(HOSTS).length) return "LINUX_HOSTS is blank: collect:linux reads only the aliases listed there";
  if (!o.skip.has("tickets") && !o.ticketsDryRun && !(env.DRIFT_TICKETS_REPO ?? "").trim()) {
    return "DRIFT_TICKETS_REPO is blank: the tickets step opens its issues there (--tickets-dry-run plans them and sends nothing)";
  }
  return null;
}

export interface LiveShared { store: Store; redactor: Redactor; vault: Vault | null }

/** The Store on DATABASE_URL, the tenant's redactor and the vault at DRIFT_VAULT_DIR (null when blank); a vault the path refuses throws. */
export function liveShared(): LiveShared {
  const redactor = new Redactor(config.redactSalt, config.redactWords);
  const vault = Vault.fromEnv({ redactor });
  return { store: Store.fromEnv(), redactor, vault };
}

/** One live cycle with its own trace file. */
export async function liveCycle(o: LiveCycleOptions, shared: LiveShared): Promise<{ result: CycleResult; traceFile: string; traceLines: number }> {
  // The pass's judge: Nemotron 3 Ultra through Nightshift, as the eval's C3; with no runtime token or URL, a judge that counts nothing.
  const judge = liveJudge();
  const tracer = new FileTracer(`cycle_${Date.now().toString(36)}`, o.apply || judge?.nightshift ? {} : { model: "none" });
  const { redactor } = shared;
  const deny = [...new Set([...config.redactWords, ...config.exportDenyWords])];
  const counting = new CountingEngine(new ZetarisEngine());
  const queries = () => counting.tally();
  const traceFile = tracer.logFile.replace(/\\/g, "/");
  const steps = liveSteps({
    tenant: o.tenant, apply: o.apply, ticketsDryRun: o.ticketsDryRun, redactor, labels: new Redactor(config.redactSalt, deny), deny, store: shared.store, vault: shared.vault, vaultDir: config.vaultDir,
    layer: new DataLayer(counting), tracer, memory: new TechnicianMemory({ storage: "read" }), judge, queries,
    out: path.join(ROOT, "document.md"), root: ROOT, source: `Zetaris over the ${config.zetaris.datasource} datasource`,
    traceFile: path.relative(ROOT, tracer.logFile).replace(/\\/g, "/"), tip: repoTip(ROOT),
  });
  const result = await runCycle({ tenant: o.tenant, apply: o.apply, aliases: Object.keys(HOSTS), skip: o.skip }, steps, {
    tracer, print: o.print, scrub: (s) => redactor.text(redact(s)), present: o.present, header: o.header, trace: traceFile, queries,
  });
  return { result, traceFile, traceLines: tracer.lines };
}
