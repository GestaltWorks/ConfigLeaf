// investigate: a FIX, or an ESCALATE under a rule whose on_drift is investigate, worked through with Nemotron via
// Nightshift under the tenant's app id (gate.ts tenantAppId), every call receipt-gated as the judge's is. Lightning
// picks up to four catalogue checks for the finding (catalogue/select.ts selectionPrompt and validateSelection), which
// run through the DataLayer; Ultra answers the detector's claim with one refuting SELECT (agents/judge.ts
// judgeClaim); the probes of the names the object serves and the exposure line come from the pass. The record is
// what ran: one plain sentence per check tied to its query id, the selection and the verdict each tied to its receipt
// and to the ladder's route that answered, each probe tied to its
// probe id. The model's prose stays out of the record.
//
// Contract:
//   - The finding is the pass's (findingOf, by the disposition's finding id); a finding no pass over the current rows
//     raises is a refusal.
//   - Lightning: one call with a request nonce first in the user message, max_tokens SELECT_MAX_TOKENS (the eval's
//     selection cap: Lightning's reasoning counts against max_tokens and stays out of the content), gated for the
//     lightning tier with custody (gateWithCustody: one retry on a receipt that is not ours). A gated selection keeps its valid checks, at most
//     four. A selection the gate refuses, a model that does not answer, or no valid check: the class's default checks
//     (defaultChecks) run, and the record says why.
//   - Ultra: judgeClaim with the tenant id, the finding's summary as the claim and the finding's fields as the one
//     evidence row. not_judged (the gate refused, or no judge answered) makes the action not_judged with the reason;
//     any counted verdict (stands, refuted, invalid_output) makes it done.
//   - receipts: every receipt id the calls returned, discarded ones included, in call order; verification: the ids of
//     the probes recorded.
//   - "Fix where allowed": a FIX names no valid copy under this policy (src/policy/decide.ts reaches FIX only without
//     one), so the Actor records kind fix, status refused, FIX_REFUSED, after the investigation.
//
// Measured 24 Oct 2026: exercised with a stub model and receipts signed by a throwaway key (test/actions.test.ts), two
// model calls per investigation. Measured 25 Oct 2026 live on the lab
// (lab/README.md), a FIX on www.lab.test: at max_tokens 1,024 all four Lightning route attempts answered
// empty_response (act-8e962ee34398e0e1, the default checks ran); at SELECT_MAX_TOKENS, act-45f088e61ed545f1: Lightning
// selected 4 valid checks on receipt rcpt_req_nn4ag0yu (4,094 tokens out, 27.5 s), Ultra stood on rcpt_req_iehg9gmt
// (14.9 s), both receipts verified with custody, done in 87 s, then the fix refused.

import type { ChatMessage, ChatResult } from "../adapters/nightshift.ts";
import { judgeClaim, type JudgeModel } from "../agents/judge.ts";
import { ASK_CHECKS, defaultChecks, selectionPrompt, validateSelection, type FindingSummary, type SelectedCheck } from "../catalogue/select.ts";
import { CatalogueError, runCheck } from "../catalogue/templates.ts";
import { DataLayerError, type DataLayer } from "../data/layer.ts";
import { listRuns, objects, probesOfRun, runComplete } from "../data/queries.ts";
import type { Disposition } from "../data/rows.ts";
import { SELECT_MAX_TOKENS } from "../eval/models.ts";
import { gateWithCustody, tenantAppId, type ReceiptFinder } from "../gate.ts";
import { PASS_WINDOW_MS, type Finding } from "../pipeline.ts";
import type { Redactor } from "../redactor.ts";
import type { Tracer } from "../trace.ts";
import { outcome, plural, probeSentence, type ActionOutcome, type ActorReads, type Row } from "./plan.ts";
import { servedNames } from "./rollback.ts";

export const FIX_REFUSED = "no fix is allowed without a valid copy; investigated and ticketed";

export interface InvestigateDeps {
  layer: DataLayer;
  reads: ActorReads;
  /** The pass's finding of a disposition, or null when no pass over the current rows raises it. */
  findingOf: (d: Disposition) => Promise<Finding | null>;
  /** Nightshift's chat with fallback; null when no model is configured, and the investigation is not_judged. */
  model: JudgeModel | null;
  receipts: ReceiptFinder;
  /** Lightning first, then its fallbacks; Ultra the same. */
  lightning: readonly string[];
  ultra: readonly string[];
  redactor: Redactor;
  now: () => Date;
  tracer?: Tracer;
}

/** The pass's probe rows for some names: the passing probe run nearest in time to the run, within PASS_WINDOW_MS. */
export interface ProbeEvidence { run_id: string | null; rows: Row[] }

/** The probe run a pass over this run reads (pipeline.ts nearestRun over the runs that pass the gate), and its rows on these names. */
export async function passProbes(layer: DataLayer, d: Pick<Disposition, "tenant_id" | "run_id">, names: readonly string[], tracer?: Tracer): Promise<ProbeEvidence> {
  const opts = { tracer, agent: "actor" };
  const runs = objects(await listRuns(layer, opts)).filter((r) => r.tenant_id === d.tenant_id);
  const own = runs.find((r) => r.run_id === d.run_id);
  if (!own) return { run_id: null, rows: [] };
  const t = Date.parse(own.started_at);
  const gap = (r: Row): number => Math.abs(Date.parse(r.started_at) - t);
  const candidates = runs.filter((r) => r.surface === "probe" && gap(r) <= PASS_WINDOW_MS).sort((a, b) => gap(a) - gap(b) || (a.run_id < b.run_id ? -1 : 1));
  for (const c of candidates) {
    if ((await runComplete(layer, c.run_id, opts)).total > 0) continue;
    const want = new Set(names);
    const rows = objects(await probesOfRun(layer, { tenant_id: d.tenant_id, run_id: c.run_id }, opts)).filter((p) => want.has(p.target));
    return { run_id: c.run_id, rows };
  }
  return { run_id: null, rows: [] };
}

/** The names the finding's object serves: a record's own name, or the nginx object's server_name values in the run. */
export async function findingNames(f: FindingSummary, reads: ActorReads): Promise<string[]> {
  if (f.surface === "cloudflare.dns") return f.dns_name ? [f.dns_name] : [];
  return servedNames(await reads.observationsOf(f.run_id), f.object_id);
}

const EVIDENCE_COLUMNS = ["class", "tenant_id", "run_id", "surface", "host", "object_id", "setting_path", "value_hash", "dns_name", "resolves_to", "resource_id", "dns_run_id", "since", "until"] as const;

/** The finding's own fields as the judge's one evidence row. */
const evidenceOf = (f: FindingSummary) => ({ columns: [...EVIDENCE_COLUMNS], rows: [EVIDENCE_COLUMNS.map((c) => String(f[c] ?? ""))] });

/** The dry-run lines of one investigation. */
export function planInvestigate(d: Disposition, models: { lightning: readonly string[]; ultra: readonly string[] }): string[] {
  return [
    `finding ${d.finding_id}: ${d.setting_path} in ${d.object_id}${d.host ? ` on ${d.host}` : ""}, ${d.verb} under ${d.rule_id ?? "no rule"}`,
    `Lightning (${models.lightning[0] ?? "none configured"}) selects up to ${ASK_CHECKS} catalogue checks under app ${safeAppId(d.tenant_id)}, receipt-gated, and they run through the data layer; the class's default checks run when no gated selection holds a valid one`,
    `Ultra (${models.ultra[0] ?? "none configured"}) answers the detector's claim with one refuting SELECT, receipt-gated; the probes of the object's names and the exposure line come from the pass`,
  ];
}

const safeAppId = (tenant: string): string => {
  try {
    return tenantAppId(tenant);
  } catch {
    return "(tenant id is not header-safe)";
  }
};

export async function investigate(d: Disposition, deps: InvestigateDeps): Promise<ActionOutcome> {
  const started = deps.now().toISOString();
  const red = (s: string): string => deps.redactor.text(s);
  const record: string[] = [];
  const receipts: string[] = [];
  const end = (status: "done" | "refused" | "not_judged", reason: string, verification: string[] = []): ActionOutcome =>
    outcome(d, "investigate", { status, reason: red(reason), record: record.map(red), receipts, verification, started_at: started, finished_at: deps.now().toISOString() });

  const found = await deps.findingOf(d);
  if (!found) return end("refused", `finding ${d.finding_id} is raised by no pass over the current rows, so there is nothing to investigate`);
  const f = found.finding;
  let appId: string;
  try {
    appId = tenantAppId(d.tenant_id);
  } catch (e) {
    return end("not_judged", `${(e as Error).message}; no call made`);
  }
  record.push(`finding ${found.id} (${f.class}): ${f.summary}`);

  // Lightning picks the checks; the class's defaults run when no gated selection holds a valid one.
  let picked: SelectedCheck[] = [];
  let why = "no model is configured";
  if (deps.model) {
    const model = deps.model;
    const call = async ({ nonce }: { nonce: string }): Promise<{ chat: ChatResult; prompt: string[] }> => {
      const [system, user] = selectionPrompt(f);
      const messages: ChatMessage[] = [system, { ...user, content: `[request ${nonce}]\n${user.content}` }];
      const chat = await model.chatWithFallback({ models: [...deps.lightning], messages, maxTokens: SELECT_MAX_TOKENS, temperature: 0, appId, agent: "actor", tracer: deps.tracer });
      return { chat, prompt: messages.map((m) => m.content) };
    };
    try {
      const out = await gateWithCustody(call, "lightning", deps.receipts, appId, deps.tracer, "actor");
      for (const x of [...out.discarded.map((y) => y.chat), out.chat]) if (x.receiptId) receipts.push(x.receiptId);
      if (out.gate.ok) {
        const sel = validateSelection(out.chat.content);
        picked = sel.valid.slice(0, ASK_CHECKS);
        record.push(`Lightning selection (receipt ${out.gate.receiptId}, ${out.gate.servedModel}, cache ${out.gate.custody?.cacheStatus ?? "unknown"}, route ${out.chat.modelRequested}): ${plural(picked.length, "valid check")}${sel.rejected.length ? `, ${sel.rejected.length} rejected` : ""}${picked.length ? `: ${picked.map((c) => c.template).join(", ")}` : ""}`);
        why = picked.length ? "" : "Lightning's gated selection holds no valid check";
      } else {
        why = `the receipt gate refused Lightning's selection: ${out.gate.reason}`;
      }
    } catch (e) {
      why = `Lightning did not answer: ${(e as Error).message}`;
    }
  }
  if (!picked.length) {
    picked = defaultChecks(f).valid;
    record.push(`${why}; the ${f.class} default checks ran: ${picked.map((c) => c.template).join(", ") || "none"}`);
  }
  let holds = 0;
  let fails = 0;
  for (const c of picked) {
    try {
      const res = await runCheck(deps.layer, c.template, c.params, { tracer: deps.tracer, agent: "actor" });
      if (res.holds) holds++;
      else fails++;
      record.push(`check ${res.template} (query ${res.result.queryId}): ${res.holds ? "holds" : "fails"}, ${plural(res.rowCount, "row")}: ${res.explanation}`);
    } catch (e) {
      if (!(e instanceof DataLayerError) && !(e instanceof CatalogueError)) throw e;
      record.push(`check ${c.template} refused before it ran: ${e.message}`);
    }
  }

  // Ultra answers the claim; the verdict counts only on a receipt that passes the gate.
  const verdict = deps.model
    ? await judgeClaim({ claim: f.summary, evidenceRows: evidenceOf(f), layer: deps.layer, nightshift: deps.model, receipts: deps.receipts, tracer: deps.tracer, requestedModels: [...deps.ultra], tenantId: d.tenant_id })
    : null;
  if (verdict?.receiptId) receipts.push(verdict.receiptId);
  record.push(verdict
    ? `judge ${verdict.status} (receipt ${verdict.receiptId ?? "none"}, ${verdict.servedModel ?? "no model"}${verdict.custody ? `, cache ${verdict.custody.cacheStatus ?? "unknown"}` : ""}${verdict.route ? `, route ${verdict.route}` : ""}): ${verdict.reason}${verdict.rowCount !== null ? `, ${plural(verdict.rowCount, "row")}` : ""}`
    : "judge not called: no model is configured");

  // The pass's evidence: the probes of the object's names and the exposure line.
  const names = await findingNames(f, deps.reads);
  const probes = await passProbes(deps.layer, d, names, deps.tracer);
  if (probes.run_id === null) record.push(`no passing probe run within six hours of run ${d.run_id}; production is unknown from the probes`);
  else if (!probes.rows.length) record.push(`probe run ${probes.run_id} holds no probe of ${names.join(", ") || "a name the object serves"}`);
  for (const p of probes.rows) record.push(probeSentence({ probe_id: p.probe_id, kind: p.kind, target: p.target, status: p.status, observed: p.observed }));
  if (found.exposure) record.push(`exposure: in this state since ${found.exposure.since} (${found.exposure.days} days, ${found.exposure.bound}), from ${found.exposure.source}`);
  const verification = probes.rows.map((p) => p.probe_id);

  if (!verdict || verdict.status === "not_judged") return end("not_judged", verdict ? verdict.reason : "no model is configured, so no verdict was asked for", verification);
  return end("done", `investigated: ${plural(holds + fails, "check")} ran (${holds} hold, ${fails} fail); the judge's verdict counted: ${verdict.status}`, verification);
}
