// The refuting judge. A detector's claim comes in with the rows that support it; Nemotron Ultra is
// asked for ONE SELECT that returns rows if and only if the claim is false, and the data layer runs
// it. Rows refute the claim; no rows and it stands. The judge never confirms by assertion: its only
// output is SQL that we execute ourselves, under the same guard as the catalogue queries.
//
// A verdict counts only when the receipt gate (src/gate.ts) says a signed receipt names the tier requested
// (JudgeInput.requestedTier: Ultra by default, Lightning for the eval's C2) and, when the claim belongs to a
// tenant, that the receipt is ours: filed under that tenant's app id
// ("drift-agent-<tenant>") for the request we made. The gate runs before the reply is read, because a
// receipt that is not ours means the answer is discarded and the call made once more as a fresh request
// (a new nonce in the prompt); a second custody failure fails closed. Gate failure, a receipt lookup
// that fails (Nightshift unreachable after the model answered) or an unreachable model files the finding
// not_judged, which escalates. A reply that is not one guarded SELECT is invalid_output, which the eval
// counts. Neither is retried silently. A reply the gate refused is still parsed for the record (its SQL
// is reported) and never run.

import { z } from "zod";
import { Nightshift, type ChatMessage, type ChatResult } from "../adapters/nightshift.ts";
import { config } from "../config.ts";
import { DataLayerError, assertSelectOnly, stripLiterals, type DataLayer } from "../data/layer.ts";
import { SCHEMA_SQL, TABLE_NAMES } from "../data/schema.ts";
import { ReceiptStore, gateChatResult, gateWithCustody, tenantAppId, type CustodyCheck, type GateResult, type ReceiptFinder } from "../gate.ts";
import type { Tracer } from "../trace.ts";

export const MAX_EVIDENCE_ROWS = 20;
export const MAX_LIMIT = 50;
/** max_tokens of a judge call: Ultra used up to 4,087 output tokens in the 24 Oct 2026 EVAL_LIVE smoke under a cap of 4,096. */
export const JUDGE_MAX_TOKENS = 8192;

export interface Evidence { columns: string[]; rows: string[][] }

/** The one method the judge needs from Nightshift, so a test can hand it canned replies. */
export type JudgeModel = Pick<Nightshift, "chatWithFallback">;

export type JudgeStatus = "stands" | "refuted" | "not_judged" | "invalid_output";

export interface JudgeVerdict {
  status: JudgeStatus;
  reason: string;
  /** The guarded SQL as run (LIMIT applied), or the model's text when the guard refused it. */
  sql: string | null;
  rowCount: number | null;
  rationale: string | null;
  receiptId: string | null;
  servedModel: string | null;
  latencyMs: number;
  /** The gate's signature result when a receipt was looked up: true verified, false altered, null none found. Absent when the model never answered. */
  signatureOk?: boolean | null;
  /** The custody check on the receipt that passed, or the last one that failed, when the call went out under a tenant's app id. */
  custody?: CustodyCheck;
  /** Model calls made under custody: 2 when a receipt not ours was discarded and the call repeated. */
  attempts?: number;
}

export interface JudgeInput {
  claim: string;
  evidenceRows: Evidence;
  layer: DataLayer;
  nightshift: JudgeModel;
  receipts?: ReceiptFinder;
  tracer?: Tracer;
  /** The model ladder, first id first; default [model] when a model is named, else the judge model and its fallbacks. */
  requestedModels?: string[];
  /** The tier the receipt gate expects of the served model: ultra by default; lightning for the eval's C2. */
  requestedTier?: "lightning" | "ultra";
  /** The id to call; default the judge model (config.nightshift.modelJudge). */
  model?: string;
  /**
   * The client the claim belongs to. Given, the call goes out under tenantAppId(tenantId) with a request
   * nonce first in the user message, and the receipt must pass custody (request_id ours, app ours); a
   * receipt that is not ours is discarded and the call made once more. Absent, the gate checks the
   * signature and the served tier only, as before.
   */
  tenantId?: string;
}

const Reply = z.object({ refute_with_sql: z.string(), rationale: z.string().default("") });

export const SYSTEM_PROMPT = `You are the refuting judge for a config-drift agent. A detector made a claim from rows of the database below. Your job is to try to prove the claim FALSE with one SQL query over that database.

Schema:
${SCHEMA_SQL.trim()}

Rules for the SQL:
- Exactly one SELECT. No semicolon, no comments, no INSERT/UPDATE/DELETE/DROP/CREATE/ALTER. No WITH clauses; write subqueries inline.
- Reference tables ONLY as {{t:table_name}}, for example {{t:observation}} o. Never a bare table name.
- Literal values only: strings in single quotes with ' doubled, numbers plain. No double quotes anywhere. No parameters, nothing like {{p:name}}.
- Portable subset: lowercase unquoted identifiers, no casts, no ILIKE, no date or time functions, no boolean literals. Timestamps are ISO 8601 text and compare as text.
- Allowed: JOIN, LEFT JOIN, NOT EXISTS, IN, CASE, COALESCE, COUNT, MAX, MIN, ORDER BY, LIMIT.
- The query must return one or more rows IF AND ONLY IF the claim is false, and zero rows when the claim is true.

Answer ONLY with this JSON object and nothing else:
{"refute_with_sql": "<the one SELECT>", "rationale": "<one sentence: why rows from it falsify the claim>"}`;

/**
 * System prompt plus the claim and at most MAX_EVIDENCE_ROWS supporting rows, one JSON object per row.
 * With a nonce, the user message opens with `[request <nonce>]`, so the same claim asked again is a new
 * request to the runtime (new request_id, no cache hit) and a truncated prompt_preview still carries it.
 */
export function buildMessages(claim: string, evidence: Evidence, nonce?: string): ChatMessage[] {
  const shown = evidence.rows.slice(0, MAX_EVIDENCE_ROWS);
  const lines = shown.map((row) => JSON.stringify(Object.fromEntries(evidence.columns.map((c, i) => [c, row[i] ?? ""]))));
  const head = nonce ? `[request ${nonce}]\n` : "";
  const user = `${head}Claim: ${claim}\n\nSupporting rows (${shown.length} of ${evidence.rows.length}; columns: ${evidence.columns.join(", ")}):\n${lines.join("\n") || "(none)"}`;
  return [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }];
}

/**
 * The guard on the model's SQL, in the order a reader can follow: a string; no {{p:}} parameters;
 * with literals stripped, no double quote (a "x'" token would hide the rest of the text from the
 * strip and so from every rule after it) and no bare schema table after FROM/JOIN; at least one
 * {{t:table}} and every one known; then assertSelectOnly (one SELECT, no semicolon, no double quote,
 * no comment, no DML/DDL token); then LIMIT capped at MAX_LIMIT, appended when absent. One trailing
 * semicolon is formatting and is stripped first. Throws DataLayerError with the reason; the caller
 * files invalid_output.
 */
export function guardRefutation(sql: unknown, tables: readonly string[] = TABLE_NAMES): string {
  if (typeof sql !== "string" || !sql.trim()) throw new DataLayerError("refute_with_sql must be a non-empty string");
  let s = sql.trim().replace(/;\s*$/, "");
  if (/\{\{p:/.test(s)) throw new DataLayerError("parameters are not allowed; write literal values, not {{p:name}}");
  const bare = stripLiterals(s).replace(/\{\{t:\w+\}\}/g, "T");
  if (bare.includes('"')) throw new DataLayerError("double quotes are not allowed; identifiers are unquoted, strings single-quoted");
  const bareRef = bare.match(new RegExp(`\\b(?:from|join)\\s+(${tables.join("|")})\\b`, "i"));
  if (bareRef) throw new DataLayerError(`bare table reference: ${bareRef[1]}; write {{t:${bareRef[1]}}}`);
  const refs = [...s.matchAll(/\{\{t:(\w+)\}\}/g)].map((m) => m[1]);
  if (!refs.length) throw new DataLayerError("no {{t:table}} reference; the query must read the database");
  for (const t of refs) if (!tables.includes(t)) throw new DataLayerError(`unknown table: ${t}`);
  assertSelectOnly(s);
  if (/\blimit\s+\d+/i.test(s)) s = s.replace(/\blimit\s+(\d+)/gi, (m, n: string) => (Number(n) > MAX_LIMIT ? `LIMIT ${MAX_LIMIT}` : m));
  else s = `${s} LIMIT ${MAX_LIMIT}`;
  return s;
}

type ParsedReply =
  | { ok: true; sql: string; rationale: string }
  | { ok: false; kind: "no_json" | "shape" | "refused"; reason: string; sql: string | null; rationale: string | null };

/** The reply as JSON, then its SELECT through the guard. Never runs anything. */
function parseReply(chat: ChatResult, layer: DataLayer): ParsedReply {
  const extracted = Nightshift.extractJson(chat.content);
  const parsed = Reply.safeParse(extracted);
  if (!parsed.success) {
    return extracted === null
      ? { ok: false, kind: "no_json", reason: "no JSON object in the reply", sql: null, rationale: null }
      : { ok: false, kind: "shape", reason: `reply is not {refute_with_sql, rationale}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, sql: null, rationale: null };
  }
  const { rationale } = parsed.data;
  try {
    return { ok: true, sql: guardRefutation(parsed.data.refute_with_sql, layer.tables), rationale };
  } catch (err) {
    return { ok: false, kind: "refused", reason: `refutation SQL refused: ${(err as Error).message}`, sql: parsed.data.refute_with_sql, rationale };
  }
}

/** Every judge route failed; distinguished from a receipt lookup failure, which happens after the model answered. */
class ModelUnavailable extends Error {}

/**
 * Ask Ultra for a refuting SELECT, gate the receipt (custody included when the claim names a tenant),
 * then guard the reply, run it and map rows to a verdict. Every step leaves a trace event with agent
 * "judge"; the model call, the gate and the query add their own.
 */
export async function judgeClaim(input: JudgeInput): Promise<JudgeVerdict> {
  const { claim, evidenceRows, layer, nightshift, tracer } = input;
  const tier = input.requestedTier ?? "ultra";
  const requestedModels = input.requestedModels ?? (input.model ? [input.model] : [config.nightshift.modelJudge, ...config.nightshift.fallbackJudge]);
  const receipts = input.receipts ?? new ReceiptStore();
  const t0 = Date.now();
  const done = (v: Omit<JudgeVerdict, "latencyMs">): JudgeVerdict => ({ ...v, latencyMs: Date.now() - t0 });
  const none = { sql: null, rowCount: null, rationale: null, receiptId: null, servedModel: null };
  const summary = claim.slice(0, 160);

  // 0. The tenant's app id. A tenant id that is not a header-safe token cannot go out as meterless-app, so no
  //    call is made: not_judged with the reason, never a throw out of a pass or a live pre-flight.
  let appId: string | null = null;
  if (input.tenantId !== undefined) {
    try {
      appId = tenantAppId(input.tenantId);
    } catch (err) {
      const reason = `${(err as Error).message}; no call made`;
      tracer?.emit({ agent: "judge", action: "check", status: "not_judged", input_summary: summary, output_summary: "tenant id is not a header-safe token; not judged", detail: reason });
      return done({ status: "not_judged", reason, ...none });
    }
  }

  // 1. Call, then gate. Under a tenant: its app id, a fresh nonce per call, custody checked, one retry on a
  //    receipt that is not ours (gateWithCustody). Without one: one call, signature and tier only.
  let lastChat: ChatResult | undefined;
  const call = async (nonce?: string): Promise<{ chat: ChatResult; prompt: string[] }> => {
    const messages = buildMessages(claim, evidenceRows, nonce);
    try {
      // max_tokens is sized for a route that honours enable_thinking: the reasoning comes back in content before the JSON and must not truncate it.
      const chat = await nightshift.chatWithFallback({ models: requestedModels, messages, maxTokens: JUDGE_MAX_TOKENS, temperature: 0, enableThinking: true, ...(appId ? { appId } : {}), agent: "judge", tracer });
      lastChat = chat;
      return { chat, prompt: messages.map((m) => m.content) };
    } catch (err) {
      throw new ModelUnavailable((err as Error).message);
    }
  };
  let chat: ChatResult;
  let gate: GateResult;
  let attempts = 1;
  try {
    if (appId) {
      const out = await gateWithCustody(({ nonce }) => call(nonce), tier, receipts, appId, tracer, "judge");
      chat = out.chat;
      gate = out.gate;
      attempts = out.attempts;
    } else {
      chat = (await call()).chat;
      gate = await gateChatResult(chat, tier, receipts, tracer, "judge");
    }
  } catch (err) {
    if (err instanceof ModelUnavailable || !lastChat) {
      const reason = `judge model unavailable: ${(err as Error).message}`;
      tracer?.emit({ agent: "judge", action: "hypothesise", status: "not_judged", model_requested: requestedModels[0], input_summary: summary, detail: reason });
      return done({ status: "not_judged", reason, ...none });
    }
    // The receipt list could not be fetched (network, 5xx) after the model answered: no verdict, never a throw out of a pass. The reply is parsed for the record and never run.
    const reason = `receipt lookup failed: ${(err as Error).message}`;
    tracer?.emit({ agent: "judge", action: "check", status: "not_judged", receipt_id: lastChat.receiptId ?? undefined, model_routed: lastChat.modelRouted ?? undefined, input_summary: summary, detail: reason });
    const p = parseReply(lastChat, layer);
    return done({ status: "not_judged", reason, sql: p.sql, rowCount: null, rationale: p.rationale, receiptId: lastChat.receiptId, servedModel: lastChat.modelRouted });
  }
  const served = { receiptId: gate.receiptId, servedModel: gate.servedModel, signatureOk: gate.signatureOk, ...(gate.custody ? { custody: gate.custody } : {}), ...(appId ? { attempts } : {}) };

  // 2. The reply, parsed and guarded. A reply the gate refused is recorded (its SQL shown) and never run.
  const p = parseReply(chat, layer);
  if (!gate.ok) return done({ status: "not_judged", reason: `receipt gate: ${gate.reason}`, sql: p.sql, rowCount: null, rationale: p.rationale, ...served });
  if (!p.ok) {
    if (p.kind === "refused") tracer?.emit({ agent: "judge", action: "check", status: "failed", model_routed: gate.servedModel ?? undefined, receipt_id: gate.receiptId ?? undefined, input_summary: (p.sql ?? "").slice(0, 160), detail: p.reason });
    else tracer?.emit({ agent: "judge", action: "hypothesise", status: "failed", model_routed: gate.servedModel ?? undefined, receipt_id: gate.receiptId ?? undefined, input_summary: summary, detail: p.reason });
    return done({ status: "invalid_output", reason: p.reason, sql: p.sql, rowCount: null, rationale: p.rationale, ...served });
  }
  const { sql, rationale } = p;
  tracer?.emit({ agent: "judge", action: "hypothesise", status: "ok", model_routed: gate.servedModel ?? undefined, receipt_id: gate.receiptId ?? undefined, tokens_in: chat.tokensIn, tokens_out: chat.tokensOut, latency_ms: chat.latencyMs, input_summary: summary, output_summary: sql.slice(0, 160), detail: rationale.slice(0, 300) });

  // 3. Run it ourselves; rows refute.
  let rowCount: number;
  try {
    rowCount = (await layer.run(sql, {}, { agent: "judge", tracer, limit: MAX_LIMIT })).rowCount;
  } catch (err) {
    const reason = `refutation SQL failed to run: ${(err as Error).message}`;
    return done({ status: "invalid_output", reason, sql, rowCount: null, rationale, ...served });
  }
  const status: JudgeStatus = rowCount > 0 ? "refuted" : "stands";
  const reason = rowCount > 0 ? `${rowCount} row(s) satisfy the refuting SELECT` : "the refuting SELECT returned no rows";
  tracer?.emit({ agent: "judge", action: "judge", status: "ok", model_routed: gate.servedModel ?? undefined, receipt_id: gate.receiptId ?? undefined, signature_ok: gate.signatureOk ?? undefined, input_summary: summary, output_summary: `${status}: ${reason}`, detail: rationale.slice(0, 300) });
  return done({ status, reason, sql, rowCount, rationale, ...served });
}
