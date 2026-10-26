// Meterless Nightshift: the only model provider. OpenAI-compatible chat, plus the runtime's
// own endpoints for jobs, the per-job event stream and signed receipts.
//
// Measured on the build machine, 23 Oct 2026:
//   - explicit nvidia/* model ids are honoured and named in the receipt;
//   - meterless/fast|deep|judge all route to the race lane first;
//   - a "/no_think" system message with a small max_tokens makes Lightning return an empty
//     response (502 provider_error); plain prompts work;
//   - Ultra puts its reasoning in content, so JSON must be parsed tolerant of a preamble;
//   - receipts are Ed25519 over the compact, key-sorted UTF-8 JSON of `body`, numbers spelled as the Rust signer
//     prints them (5.47e-6, not 0.00000547: canonicalReceiptBody);
//   - chat_template_kwargs.enable_thinking (Nemotron's documented switch) is accepted but has no
//     observable effect through the OpenRouter routes: 3+3 calls per model on one small-JSON prompt
//     (scripts/probe-thinking.ts), </think> absent in all 12, tokens_out 11/11 for Lightning and
//     71/72 for Ultra with false/true. On that Ultra route the message carries only role and content
//     (no reasoning field, no </think>) while tokens_out runs 70 to 101 for a 12-token answer, so the
//     reasoning is billed but not returned. The judge sets it true anyway: harmless here, honoured
//     wherever the flag is forwarded.
//
// Failover, measured 25 Oct 2026 in the eval run of 03:09 UTC: five C2 judge calls walked openrouter > nvidia >
// local-runtime and ended on "503 local_runtime_not_ready" (the machine holds no local weights); 2 judge calls
// answered on the nvidia route. A route that answers 5xx (or 429) or an empty body is tried once more after
// RETRY_DELAY_MS before the ladder moves on; every model_call trace line names its attempt ("attempt 2 of 2"); the
// result names the route that answered (modelRequested, hop) and its attempts there (retries + 1).
//
// Memory, measured 25 Oct 2026 (a read of the installed engine and six test calls): Nightshift 1.2.7 stores an answer
// it judges confident (24+ characters, confidence 0.6+) with its prompt and, before a later request that shares the
// same meterless-scope, across apps, prepends up to three similar stored answers as a system message; the signed
// receipt records it as hmem {ids, injected, reason, strategy, top_score}, or hmem null when nothing was injected. No
// request header or body field switches it off; the scope is the only wall (one probe call injected 3 records under
// scope "user" and 0 under each of two fresh scopes). So every request goes out under a fresh meterless-scope,
// "<meterless-app>-<16 hex>" (drift-agent-<tenant>-<call id> under a tenant's app id), unless the caller pins one
// (opts.scope); the result returns the scope that answer's request used, and the response's own copy of hmem.injected.
// The gate (src/gate.ts) reads hmem from the signed receipt, never from the response.

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import { config, redact } from "../config.ts";
import type { Tracer } from "../trace.ts";

/** The wait before a route's one retry, in ms. */
export const RETRY_DELAY_MS = 2_000;
/** Attempts per route of the ladder: the first and one retry. */
export const ROUTE_ATTEMPTS = 2;

/** A status worth one more attempt on the same route: any 5xx, and 429. */
const retryable = (status: number): boolean => status >= 500 || status === 429;

/** A meterless-scope no earlier request used: "<app id>-<16 hex>", so the runtime has no stored answer to inject. */
export function freshScope(appId: string = config.nightshift.appId): string {
  return `${appId}-${randomBytes(8).toString("hex")}`;
}

/** hmem.injected as a response's own copy of its receipt states it; null when the response carries no copy. Never trusted by the gate. */
function claimedInjected(meter: any): number | null {
  const rc = meter?.receipt;
  if (!rc || typeof rc !== "object" || !("hmem" in rc)) return null;
  const h = rc.hmem;
  if (h === null || typeof h !== "object") return 0;
  return typeof h.injected === "number" ? h.injected : Array.isArray(h.ids) ? h.ids.length : 0;
}

export interface NightshiftOptions {
  /** The runtime token; default the configured one (METERLESS_RUNTIME_TOKEN, else the runtime's token file). */
  token?: string;
  /** The wait before a route's retry; default RETRY_DELAY_MS. */
  retryDelayMs?: number;
}

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

export interface ChatResult {
  content: string;
  modelRequested: string;
  modelRouted: string | null;
  receiptId: string | null;
  requestId: string | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  retries: number;
  /** The meterless-scope this answer's request went out under; the adapter always sets it (optional for test stubs). */
  scope?: string;
  /** hmem.injected as the response's own receipt copy states it (0 for hmem null), null when it carries none; the gate reads the signed receipt instead. */
  memoryInjected?: number | null;
  raw: unknown;
}

export class NightshiftError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) {
    super(redact(message));
  }
}

export class Nightshift {
  private readonly base = config.nightshift.baseUrl;
  private readonly root = config.nightshift.baseUrl.replace(/\/v1$/, "");
  private readonly token: string;
  private readonly retryDelayMs: number;

  constructor(opts: NightshiftOptions = {}) {
    this.token = opts.token ?? config.nightshift.token;
    this.retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  }

  /** `appId` overrides the meterless-app header for one call (per client, "drift-agent-<tenant>", see gate.ts tenantAppId), so the receipt is filed under it and the gate can verify it. */
  private headers(extra: Record<string, string> = {}, appId: string = config.nightshift.appId): Record<string, string> {
    if (!this.token) throw new NightshiftError("no Nightshift runtime token", 0);
    return {
      Authorization: `Bearer ${this.token}`,
      "meterless-app": appId,
      ...extra,
    };
  }

  async models(): Promise<string[]> {
    const r = await fetch(`${this.base}/models`, { headers: this.headers() });
    if (!r.ok) throw new NightshiftError(`GET /v1/models -> ${r.status}`, r.status);
    const j = (await r.json()) as { data: { id: string }[] };
    return j.data.map((m) => m.id);
  }

  /**
   * One chat call on one route, in at most ROUTE_ATTEMPTS attempts: a 5xx or 429, an empty body (or a reply with
   * no content), a timeout or a network error is tried once more after retryDelayMs; any other status throws at
   * once. The caller names the model explicitly; `meterless/*` modes are allowed but the receipt's routed_model is
   * what we trust. Each attempt is one model_call trace line whose output_summary names it ("attempt 1 of 2");
   * the result's retries is the attempts made less one. Each attempt goes out under its own fresh meterless-scope
   * (freshScope of the app id) unless `scope` pins one for every attempt; the trace line and the result name it.
   */
  async chat(
    opts: { model: string; messages: ChatMessage[]; maxTokens?: number; temperature?: number; enableThinking?: boolean; appId?: string; scope?: string; agent: string; tracer?: Tracer },
  ): Promise<ChatResult> {
    const body = JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0,
      // Nemotron's documented reasoning switch. Sent only when the caller sets it; see scripts/probe-thinking.ts for what Nightshift does with it.
      ...(opts.enableThinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: opts.enableThinking } }),
    });
    let lastErr: NightshiftError | null = null;
    for (let attempt = 1; attempt <= ROUTE_ATTEMPTS; attempt++) {
      if (attempt > 1 && this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs));
      const t0 = Date.now();
      const nth = `attempt ${attempt} of ${ROUTE_ATTEMPTS}`;
      const scope = opts.scope ?? freshScope(opts.appId);
      const failed = (err: NightshiftError, routed?: string): NightshiftError => {
        opts.tracer?.emit({ agent: opts.agent, action: "model_call", model_requested: opts.model, ...(routed ? { model_routed: routed } : {}), status: "failed", retry_count: attempt - 1, latency_ms: Date.now() - t0, scope, output_summary: nth, detail: err.detail ?? err.message });
        return err;
      };
      let r: Response;
      let text: string;
      try {
        r = await fetch(`${this.base}/chat/completions`, {
          method: "POST",
          headers: this.headers({ "Content-Type": "application/json", "meterless-scope": scope }, opts.appId),
          body,
          signal: AbortSignal.timeout(180_000),
        });
        text = await r.text();
      } catch (err) {
        if (err instanceof NightshiftError) throw err; // no token: no attempt can succeed
        const msg = (err as Error).name === "TimeoutError" ? "timeout after 180 s" : (err as Error).message;
        lastErr = failed(new NightshiftError(`chat ${opts.model}: ${msg}`, 0, msg));
        continue;
      }
      let j: any = {};
      try { j = JSON.parse(text); } catch { /* non-JSON error body */ }
      const meter = j.meterless ?? {};
      if (!r.ok) {
        const detail = j.error?.meterless_detail ?? j.error?.message ?? text.slice(0, 200);
        lastErr = failed(new NightshiftError(`chat ${opts.model} -> ${r.status}: ${detail}`, r.status, detail), meter.provider_model ?? undefined);
        if (retryable(r.status)) continue;
        throw lastErr;
      }
      const content: unknown = j.choices?.[0]?.message?.content;
      if (!text.trim() || typeof content !== "string" || !content.trim()) {
        const detail = !text.trim() ? "empty body" : "empty content";
        lastErr = failed(new NightshiftError(`chat ${opts.model} -> ${r.status}: ${detail}`, r.status, detail), meter.routed_model ?? undefined);
        continue;
      }
      const result: ChatResult = {
        content,
        modelRequested: opts.model,
        modelRouted: meter.routed_model ?? meter.winning_route?.model ?? j.model ?? null,
        receiptId: meter.receipt_id ?? null,
        requestId: j.id ?? null,
        tokensIn: j.usage?.prompt_tokens ?? meter.usage?.input_tokens ?? 0,
        tokensOut: j.usage?.completion_tokens ?? meter.usage?.output_tokens ?? 0,
        latencyMs: Date.now() - t0,
        retries: attempt - 1,
        scope,
        memoryInjected: claimedInjected(meter),
        raw: j,
      };
      opts.tracer?.emit({ agent: opts.agent, action: "model_call", model_requested: opts.model, model_routed: result.modelRouted ?? undefined, receipt_id: result.receiptId ?? undefined, tokens_in: result.tokensIn, tokens_out: result.tokensOut, latency_ms: result.latencyMs, retry_count: attempt - 1, status: "ok", scope, memory_injected: result.memoryInjected, output_summary: nth });
      return result;
    }
    throw lastErr ?? new NightshiftError("chat failed", 0);
  }

  /**
   * Chat with a failover ladder: the primary model, then each fallback in order, each in chat()'s attempts.
   * Every hop is a Nemotron route through Nightshift, so the award evidence holds whichever answered; the
   * result names the route (modelRequested, hop) and the receipt's routed_model the model that served. A
   * `fallback` trace event records each hop that failed. Every hop failing throws the last hop's error. A pinned
   * `scope` goes out on every hop and attempt; without one each attempt draws a fresh scope.
   */
  async chatWithFallback(
    opts: { models: string[]; messages: ChatMessage[]; maxTokens?: number; temperature?: number; enableThinking?: boolean; appId?: string; scope?: string; agent: string; tracer?: Tracer },
  ): Promise<ChatResult & { hop: number }> {
    let lastErr: unknown;
    for (let hop = 0; hop < opts.models.length; hop++) {
      const model = opts.models[hop];
      try {
        const r = await this.chat({ ...opts, model });
        return { ...r, hop };
      } catch (err) {
        lastErr = err;
        const next = opts.models[hop + 1];
        opts.tracer?.emit({ agent: opts.agent, action: "fallback", model_requested: model, status: next ? "ok" : "failed", detail: next ? `${model} failed, trying ${next}` : `${model} failed, no fallback left` });
      }
    }
    throw lastErr;
  }

  /**
   * Pull a JSON object out of a reply that may carry reasoning or prose around it.
   * Measured on 23 Oct: Nemotron 3 Ultra through Nightshift puts its reasoning in `content`
   * terminated by a `</think>` tag, with the answer after it. So: drop everything through the
   * last `</think>`, then prefer a fenced block, then the first balanced object in what remains.
   */
  static extractJson<T = unknown>(content: string): T | null {
    const afterThink = content.includes("</think>") ? content.slice(content.lastIndexOf("</think>") + 8) : content;
    const fenced = afterThink.match(/```(?:json)?\s*([\s\S]*?)```/);
    for (const c of [fenced?.[1], afterThink, content]) {
      if (!c) continue;
      const obj = Nightshift.firstBalancedObject(c);
      if (obj !== null) return obj as T;
    }
    return null;
  }

  /** The first `{...}` whose braces balance and that parses; skips objects embedded in prose that do not. */
  private static firstBalancedObject(s: string): unknown | null {
    for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------- runtime endpoints

  async jobs(): Promise<any[]> {
    const r = await fetch(`${this.base}/jobs`, { headers: this.headers() });
    if (!r.ok) throw new NightshiftError(`GET /v1/jobs -> ${r.status}`, r.status);
    return ((await r.json()) as { data: any[] }).data;
  }

  /** The app's own job: Nightshift keeps one app_stream job per meterless-app id. */
  async ownJob(): Promise<any | null> {
    const all = await this.jobs();
    return all.find((j) => j.app === config.nightshift.appId) ?? null;
  }

  /** Read the per-job SSE stream for `ms` milliseconds and return the parsed events. */
  async jobEvents(jobId: string, ms = 10_000): Promise<any[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const events: any[] = [];
    try {
      const r = await fetch(`${this.base}/jobs/${jobId}/events`, { headers: this.headers({ Accept: "text/event-stream" }), signal: ctrl.signal });
      if (!r.ok || !r.body) throw new NightshiftError(`GET /v1/jobs/${jobId}/events -> ${r.status}`, r.status);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* keepalive or partial */ }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    } finally {
      clearTimeout(timer);
    }
    return events;
  }

  async receipts(): Promise<SignedReceipt[]> {
    const r = await fetch(`${this.root}/v1/meterless/receipts`, { headers: this.headers() });
    if (!r.ok) throw new NightshiftError(`GET /v1/meterless/receipts -> ${r.status}`, r.status);
    return ((await r.json()) as { data: SignedReceipt[] }).data;
  }
}

export interface SignedReceipt {
  body: { llama_cpp_ref?: string; manifest_hash?: string; receipt: Record<string, any> };
  pubkey_b64: string;
  sig_b64: string;
}

const U64_MAX = 2n ** 64n - 1n;
const I64_MIN = -(2n ** 63n);

/**
 * A number as the runtime's signer prints it. meterlessd (Rust, serde_json) parses the engine's receipt and signs its
 * own serialisation: an integer that fits i64 or u64 is its digits, any other number ryu's shortest form, which turns
 * to an exponent below 1e-5 where JavaScript stays decimal down to 1e-6. A $0.00000547 cost is signed as 5.47e-6 while
 * GET /v1/meterless/receipts serves the same value as 0.00000547 (25 Oct 2026: a 30-token Lightning call with no
 * injected memory; this form reproduces all 815 stored bodies of receipts.jsonl byte for byte, JSON.stringify 810).
 */
function signerNumber(n: number): string {
  if (!Number.isFinite(n)) return "null";
  const js = String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e21) {
    const b = BigInt(js);
    if (b >= I64_MIN && b <= U64_MAX) return js;
  }
  const [m, e] = Math.abs(n).toExponential().split("e"); // the shortest round-trip digits, as ryu picks them
  const d = m.replace(".", ""), len = d.length, kk = Number(e) + 1, k = kk - len;
  const s = 0 <= k && kk <= 16 ? `${d}${"0".repeat(k)}.0`
    : 0 < kk && kk <= 16 ? `${d.slice(0, kk)}.${d.slice(kk)}`
    : -5 < kk && kk <= 0 ? `0.${"0".repeat(-kk)}${d}`
    : `${d[0]}${len > 1 ? `.${d.slice(1)}` : ""}e${kk - 1}`;
  return n < 0 ? `-${s}` : s;
}

/** Canonical form the runtime signs: compact JSON, keys sorted recursively, UTF-8 as-is, numbers as its signer prints them (signerNumber). */
export function canonicalReceiptBody(body: unknown): string {
  const ser = (v: any): string =>
    typeof v === "number" ? signerNumber(v)
    : Array.isArray(v) ? `[${v.map((x) => (x === undefined ? "null" : ser(x))).join(",")}]`
    : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${ser(v[k])}`).join(",")}}`
    : JSON.stringify(v);
  return ser(body);
}

/** A signing key as the receipt check names it: "sha256:<64 hex>", the sha256 of the raw 32-byte Ed25519 public key `pubkey_b64` carries. */
export function receiptKeyFingerprint(pubkeyB64: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(pubkeyB64, "base64")).digest("hex")}`;
}

/**
 * The pinned receipt signing key: the fingerprint (receiptKeyFingerprint) of the Ed25519 key the build machine's
 * Nightshift runtime signs with. Every committed receipt verifies under it, 26 Oct 2026: 908 receipts, the two probe
 * receipts of 23 Oct in test/fixtures/ and those of every receipts.json under eval/ and lab/.
 */
export const RECEIPT_KEY = "sha256:6ee50b5d11fdd693e1ee80635ea1868bb1addefb5823768192849709928ff8c1";

/**
 * Verify a receipt offline: true only when its key's fingerprint is one of `trusted` and its Ed25519 signature over
 * the canonical body verifies under that key. Verified 9/9 against the build machine's runtime on 23 Oct.
 */
export function verifyReceipt(r: SignedReceipt, trusted: readonly string[] = [RECEIPT_KEY]): boolean {
  try {
    if (!trusted.includes(receiptKeyFingerprint(r.pubkey_b64))) return false;
    const raw = Buffer.from(r.pubkey_b64, "base64");
    // Ed25519 raw public key -> SPKI DER (12-byte prefix)
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(canonicalReceiptBody(r.body), "utf8"), key, Buffer.from(r.sig_b64, "base64"));
  } catch {
    return false;
  }
}
