// Runtime configuration. Every value comes from the environment; .env is loaded
// by Node itself (process.loadEnvFile) so there is no dotenv dependency.
// Secrets are never logged and never returned to callers as strings to print.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

try {
  process.loadEnvFile?.();
} catch {
  // no .env file; the environment is already set or sample mode is on
}

const Schema = z.object({
  SAMPLE_MODE: z.enum(["true", "false"]).default("false"),
  METERLESS_BASE_URL: z.string().default("http://127.0.0.1:8088/v1"),
  METERLESS_RUNTIME_TOKEN: z.string().default(""),
  METERLESS_APP_ID: z.string().default("drift-agent"),
  // Nemotron through Nightshift, three providers, one endpoint. Measured 23 Oct: OpenRouter
  // Nemotron answered 12/12 at 1 to 2 s median; NVIDIA's free endpoint 4/6 at 7.5 s with empty
  // responses. The agent requests the primary; on failure the adapter walks the fallback list.
  METERLESS_MODEL_FAST: z.string().default("openrouter/nvidia/nemotron-3.5-lightning"),
  METERLESS_MODEL_JUDGE: z.string().default("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"),
  METERLESS_FALLBACK_FAST: z.string().default("nvidia/nemotron-3.5-lightning-30b-a3b,local-runtime/nemotron-3.5-lightning-30b-a3b"),
  METERLESS_FALLBACK_JUDGE: z.string().default("nvidia/nemotron-3-ultra-550b-a55b"),
  ZETARIS_REST_URL: z.string().default("http://localhost:8888/api/v1.0"),
  ZETARIS_ORG_ID: z.string().default("1"),
  ZETARIS_API_KEY: z.string().default(""),
  LOG_DIR: z.string().default("logs"),
});

const raw = Schema.parse(process.env);

/** The Nightshift runtime writes its bearer token to a file; fall back to it when the env var is blank. */
function runtimeToken(): string {
  if (raw.METERLESS_RUNTIME_TOKEN) return raw.METERLESS_RUNTIME_TOKEN;
  const local = process.env.LOCALAPPDATA;
  if (!local) return "";
  const p = path.join(local, "ai.meterless.runtime", "proxy-token");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

export const config = {
  sampleMode: raw.SAMPLE_MODE === "true",
  nightshift: {
    baseUrl: raw.METERLESS_BASE_URL.replace(/\/+$/, "").replace(/(\/v1)+$/, "/v1"),
    token: runtimeToken(),
    appId: raw.METERLESS_APP_ID,
    modelFast: raw.METERLESS_MODEL_FAST,
    modelJudge: raw.METERLESS_MODEL_JUDGE,
    fallbackFast: raw.METERLESS_FALLBACK_FAST.split(",").map((s) => s.trim()).filter(Boolean),
    fallbackJudge: raw.METERLESS_FALLBACK_JUDGE.split(",").map((s) => s.trim()).filter(Boolean),
  },
  zetaris: {
    restUrl: raw.ZETARIS_REST_URL.replace(/\/+$/, ""),
    orgId: raw.ZETARIS_ORG_ID,
    apiKey: raw.ZETARIS_API_KEY,
  },
  logDir: raw.LOG_DIR,
} as const;

/** Redact anything that looks like a secret before it reaches a log line or an error message. */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer <redacted>")
    .replace(/nvapi-[A-Za-z0-9_\-]+/g, "nvapi-<redacted>")
    .replace(/rt-[A-Za-z0-9_\-]{8,}/g, "rt-<redacted>");
}
