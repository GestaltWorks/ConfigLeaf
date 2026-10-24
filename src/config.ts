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
  ZETARIS_DATASOURCE: z.string().default("DRIFT"),
  // The app Postgres as the Zetaris driver container reaches it, host[:port] (port 5432 when absent):
  // the container name on zetaris_default, not DATABASE_URL's host. Measured 24 Oct: drift-pg:5432 from
  // Zetaris, 127.0.0.1:15432 from Windows; host.docker.internal does not resolve in the driver.
  ZETARIS_PG_HOST: z.string().default("drift-pg"),
  // Cloudflare API token with Zone:Read, DNS:Read and Account:Audit Logs:Read; the collector only GETs.
  CLOUDFLARE_API_TOKEN: z.string().default(""),
  // Salt behind the redactor's pseudonyms. Secret-like: with it a published fixture re-identifies.
  REDACT_SALT: z.string().default(""),
  // The tenant's own labels (zone labels, product names), comma-separated, pseudonymised wherever they stand
  // alone (redactor pass e): a vhost file named <brand>-prod.conf is not a hostname and survived passes a-d.
  REDACT_WORDS: z.string().default(""),
  // Tokens that must never appear in an exported bundle or the committed tree, beyond REDACT_WORDS: the
  // operator's mailbox local part, real addresses or their prefixes. The export fails when one matches.
  EXPORT_DENY_WORDS: z.string().default(""),
  // The hosts the Linux collector may reach, as <ssh alias>=<backup export dir>, comma-separated. The
  // aliases are the operator's own ssh_config entries; the export dir is where the host's nightly
  // server-config tarball lands (a login's home path belongs here, not in source).
  LINUX_HOSTS: z.string().default(""),
  LOG_DIR: z.string().default("logs"),
});

const raw = Schema.parse(process.env);

const EXPORT_DIR = /^\/[A-Za-z0-9._\/-]+$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** "host-redacted=/var/backups/export,other=/home/x/backup-export" -> alias -> export dir. Throws on a shape the read script would not accept. */
export function parseLinuxHosts(s: string): Record<string, { exportDir: string }> {
  const out: Record<string, { exportDir: string }> = {};
  for (const entry of s.split(",").map((e) => e.trim()).filter(Boolean)) {
    const i = entry.indexOf("=");
    const alias = i >= 0 ? entry.slice(0, i).trim() : "";
    const exportDir = i >= 0 ? entry.slice(i + 1).trim() : "";
    if (!ALIAS.test(alias)) throw new Error(`LINUX_HOSTS: alias must be a plain ssh_config alias, got ${JSON.stringify(alias)}`);
    if (!EXPORT_DIR.test(exportDir)) throw new Error(`LINUX_HOSTS: ${alias}: export dir must be an absolute path of [A-Za-z0-9._/-], got ${JSON.stringify(exportDir)}`);
    out[alias] = { exportDir };
  }
  return out;
}

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
    datasource: raw.ZETARIS_DATASOURCE,
    pgHost: raw.ZETARIS_PG_HOST,
  },
  cloudflare: {
    token: raw.CLOUDFLARE_API_TOKEN,
  },
  redactSalt: raw.REDACT_SALT,
  redactWords: raw.REDACT_WORDS.split(",").map((s) => s.trim()).filter(Boolean),
  exportDenyWords: raw.EXPORT_DENY_WORDS.split(",").map((s) => s.trim()).filter(Boolean),
  linuxHosts: parseLinuxHosts(raw.LINUX_HOSTS),
  logDir: raw.LOG_DIR,
} as const;

/**
 * Redact anything that looks like a secret before it reaches a log line or an error message.
 * Passwords: the Zetaris option form (CREATE DATASOURCE ... password "x") and its JSON and key=value
 * cousins, quoted with " or ', backslash escapes honoured, and still caught when a slice cut the value
 * before its closing quote; an unquoted password=x; and URL userinfo (postgresql://user:x@host).
 * Idempotent: redacted text redacts to itself.
 */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer <redacted>")
    .replace(/nvapi-[A-Za-z0-9_\-]+/g, "nvapi-<redacted>")
    .replace(/rt-[A-Za-z0-9_\-]{8,}/g, "rt-<redacted>")
    .replace(/(\bpassword["']?\s*[:=]?\s*)(["'])(?:\\[\s\S]|(?!\2)[^\\])*\2?/gi, "$1$2<redacted>$2")
    .replace(/(\bpassword=)(?!["'<])[^\s&;"']+/gi, "$1<redacted>")
    .replace(/(\/\/[^\s:/@]+:)(?!<redacted>@)[^\s/@]+@/g, "$1<redacted>@");
}
