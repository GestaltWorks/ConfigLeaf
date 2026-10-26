// The Actor's live dependencies, as one function, so scripts/act.ts and a cycle (scripts that run every step in one
// process) build the same thing: the hosts by their LINUX_HOSTS aliases, the write session over ssh, the Cloudflare
// client for the record writes, the probes through src/probe into the Store, Nemotron through Nightshift with its
// receipts, and the pass's findings (src/pipeline.ts runPass over the same DataLayer, run once on the first
// investigation and never for a dry run).
//
// Contract: a dry run gets no Cloudflare client, no model, no sink and a probe function that probes nothing: it
// prints its plan from the ledger, the policy, the approvals, the copies and the vault alone. An apply gets all of
// them; the probe rows of a verification go into the Store as one probe run of surface probe.verify per action, and the
// Store is the sink of the action rows and of the approvals a re-created record carries. The verification's population
// is src/probe/run.ts probePopulation: PROBE_TARGETS_OVERRIDE's names when it is set (a lab aid), else the account's,
// with the real names the restored object serves as its served names (verifyProbe), so a name a wildcard covers is
// probed under that wildcard. An apply also gets the contract authority (src/guard/contract.ts): the deployment's
// Ed25519 key under .scout/, generated the first time a contract is issued or checked, gitignored; a dry run gets none.

import { Nightshift } from "../adapters/nightshift.ts";
import { Cloudflare } from "../collectors/cloudflare.ts";
import { HOSTS } from "../collectors/linux.ts";
import { config, type ProbeOverride } from "../config.ts";
import type { DataLayer } from "../data/layer.ts";
import type { Store } from "../data/store.ts";
import { ReceiptStore } from "../gate.ts";
import { LocalContractAuthority } from "../guard/contract.ts";
import { runPass, type Finding } from "../pipeline.ts";
import { probePopulation, type PopulationSource, type ProbeSink } from "../probe/run.ts";
import type { Redactor } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import type { Vault } from "../vault/vault.ts";
import { aliasFromHosts, probeNames, type ActorDeps } from "./act.ts";
import type { ProbeFn } from "./plan.ts";
import { RELOAD_SETTLE_MS } from "./rollback.ts";
import { runWriteSession } from "./ssh.ts";

/**
 * The live Actor's verification probes: probeNames (act.ts) over probePopulation, one population per call, the real
 * names the restored object serves (ProbeFn's `served`) as its served names, so each one a wildcard of its zone covers
 * joins the population under that wildcard (src/probe/rules.ts matchName).
 */
export function verifyProbe(o: { tenantId: string; redactor: Redactor; source: () => PopulationSource; sink: ProbeSink | null; override?: readonly ProbeOverride[]; tracer?: Tracer }): ProbeFn {
  return (names, kinds, served = []) => probeNames({
    tenantId: o.tenantId, redactor: o.redactor, sink: o.sink,
    population: probePopulation({ source: o.source, override: o.override, served: () => served, tracer: o.tracer, agent: "actor" }),
  })(names, kinds);
}

export interface LiveOptions {
  tenantId: string;
  apply: boolean;
  layer: DataLayer;
  /** The Store: the action sink and the probe sink of an apply; unused by a dry run. */
  store: Store | null;
  vault: Vault | null;
  redactor: Redactor;
  tracer?: Tracer;
}

export function liveActorDeps(o: LiveOptions): ActorDeps {
  const cf = o.apply && config.cloudflare.token ? new Cloudflare() : null;
  const nightshift = o.apply ? new Nightshift() : null;
  let findings: Map<string, Finding> | null = null;
  return {
    layer: o.layer,
    sink: o.apply ? o.store : null,
    redactor: o.redactor,
    vault: o.vault,
    aliasOf: aliasFromHosts(Object.keys(HOSTS), o.redactor),
    ssh: runWriteSession,
    records: cf,
    probe: cf ? verifyProbe({ tenantId: o.tenantId, redactor: o.redactor, source: () => cf, sink: o.store, tracer: o.tracer }) : async () => [],
    model: nightshift,
    receipts: nightshift ? new ReceiptStore(nightshift) : { find: async () => null },
    findingOf: async (d) => {
      findings ??= new Map((await runPass(o.layer, { tracer: o.tracer })).findings.map((f) => [f.id, f]));
      return findings.get(d.finding_id) ?? null;
    },
    lightning: [config.nightshift.modelFast, ...config.nightshift.fallbackFast],
    ultra: [config.nightshift.modelJudge, ...config.nightshift.fallbackJudge],
    tracer: o.tracer,
    settleMs: RELOAD_SETTLE_MS,
    contracts: o.apply ? LocalContractAuthority.local() : null,
  };
}
