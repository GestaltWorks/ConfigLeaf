// Runtime configuration. Every value comes from the environment; .env is loaded
// by Node itself (process.loadEnvFile) so there is no dotenv dependency.
// Secrets are never logged and never returned to callers as strings to print.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  // Nemotron through Nightshift, one endpoint. Measured 23 Oct: OpenRouter Nemotron answered 12/12
  // at 1 to 2 s median; NVIDIA's free endpoint 4/6 at 7.5 s with empty responses
  // (scripts/probe-openrouter-nemotron.ts). The agent requests
  // the primary; on failure the adapter walks the fallback list. A local lane
  // (local-runtime/nemotron-3.5-lightning-30b-a3b) joins the list when its weights are installed: on
  // 25 Oct it answered 503 local_runtime_not_ready on this machine, which holds none.
  METERLESS_MODEL_FAST: z.string().default("openrouter/nvidia/nemotron-3.5-lightning"),
  METERLESS_MODEL_JUDGE: z.string().default("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"),
  METERLESS_FALLBACK_FAST: z.string().default("nvidia/nemotron-3.5-lightning-30b-a3b"),
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
  // The ssh_config file the LINUX_HOSTS aliases are read from, passed to every ssh session as -F <file>
  // (lab/ssh_config.local for the lab estate). Blank = the user's own (~/.ssh/config).
  LINUX_SSH_CONFIG: z.string().default(""),
  // The vault: one git repository per tenant and host alias (and one per tenant for Cloudflare) holding the
  // collected bytes under their real names, outside the repository. Blank = the vault is off.
  DRIFT_VAULT_DIR: z.string().default(""),
  // The MSP's policy as data, read by npm run policy:load and the Decider: a JSON file in the shape of
  // policy/hackathon.json, the default.
  DRIFT_POLICY_FILE: z.string().default("policy/hackathon.json"),
  // The directory of the technician's lessons, the H-MEM store (state.json, ledger.jsonl): npm run answer writes it,
  // every pass reads it. Blank = .world/memory, gitignored (examples/memory, the committed store, in sample mode and for
  // npm run examples and npm run site); a committed directory makes a clean clone and CI decide with the same lessons.
  DRIFT_MEMORY_DIR: z.string().default(""),
  // The command that runs nginx -t over a vault commit materialised in a temp directory, with {dir} for that
  // directory. Blank = the platform default (NGINX_T_DEFAULT below: docker, through WSL on Windows).
  DRIFT_NGINX_T: z.string().default(""),
  // A lab aid (lab/README.md): the probe population as <name>=<address>[:<port>], comma-separated, in place of the
  // Cloudflare account's records. Each name is asked at its address over plain http with the name as Host, its dns
  // probe holds the override's address, and its tls probe is recorded skipped. Blank = the account's records.
  PROBE_TARGETS_OVERRIDE: z.string().default(""),
  LOG_DIR: z.string().default("logs"),
});

const raw = Schema.parse(process.env);

const EXPORT_DIR = /^\/[A-Za-z0-9._\/-]+$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** "web-01=/var/backups/export,other=/home/x/backup-export" -> alias -> export dir. Throws on a shape the read script would not accept. */
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

/** One PROBE_TARGETS_OVERRIDE entry: a served name, and the address and port its plain-http probe connects to. */
export interface ProbeOverride { name: string; host: string; port: number }

const OVERRIDE_ENTRY = /^([^=\s]+)=(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/;
const OVERRIDE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** "lab.example=127.0.0.1:8080,www.lab.test=127.0.0.1" -> the entries, port 80 when absent, names lower-cased. Throws on any other shape or a name given twice. */
export function parseProbeOverride(s: string): ProbeOverride[] {
  const out: ProbeOverride[] = [];
  for (const entry of s.split(",").map((e) => e.trim()).filter(Boolean)) {
    const m = OVERRIDE_ENTRY.exec(entry);
    if (!m) throw new Error(`PROBE_TARGETS_OVERRIDE: an entry is <name>=<address>[:<port>], got ${JSON.stringify(entry)}`);
    const name = m[1].toLowerCase().replace(/\.$/, "");
    if (!OVERRIDE_NAME.test(name)) throw new Error(`PROBE_TARGETS_OVERRIDE: ${JSON.stringify(m[1])} is a name of letters, digits, dashes and dots, without a wildcard`);
    const port = m[3] === undefined ? 80 : Number(m[3]);
    if (port < 1 || port > 65535) throw new Error(`PROBE_TARGETS_OVERRIDE: ${name}: the port is 1 to 65535, got ${m[3]}`);
    if (out.some((o) => o.name === name)) throw new Error(`PROBE_TARGETS_OVERRIDE: ${name} is named twice`);
    out.push({ name, host: m[2].replace(/^\[|\]$/g, ""), port });
  }
  return out;
}

/**
 * The nginx -t validator command per platform, {dir} the materialised tree (on win32 the validator turns it
 * into its /mnt/<drive>/ form). nginx:1.27 is Debian-based and carries both the nginx and the www-data users,
 * so either host's "user" directive resolves.
 */
export const NGINX_T_DEFAULT = {
  win32: "wsl.exe -d Ubuntu-24.04 -- docker run --rm -v {dir}:/etc/nginx:ro nginx:1.27 nginx -t -c /etc/nginx/nginx.conf",
  other: "docker run --rm -v {dir}:/etc/nginx:ro nginx:1.27 nginx -t -c /etc/nginx/nginx.conf",
} as const;

/** DRIFT_NGINX_T when set, else the default for the platform. */
export function nginxTCommand(platform: NodeJS.Platform = process.platform, configured: string = raw.DRIFT_NGINX_T): string {
  return configured.trim() || (platform === "win32" ? NGINX_T_DEFAULT.win32 : NGINX_T_DEFAULT.other);
}

/** Where the technician's lessons live when DRIFT_MEMORY_DIR is blank: under .world/, which .gitignore keeps out of the repository. */
export const DEFAULT_MEMORY_DIR = ".world/memory";

/**
 * Where they live in sample mode when DRIFT_MEMORY_DIR is blank: the committed store, examples/memory under the
 * repository root (this file's parent's parent), so a clean clone with no .env decides with the lessons the
 * committed examples and docs/ were built with.
 */
export const SAMPLE_MEMORY_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "examples", "memory");

/**
 * DRIFT_MEMORY_DIR trimmed, else SAMPLE_MEMORY_DIR in sample mode and DEFAULT_MEMORY_DIR otherwise; a relative value
 * resolves against the working directory, as every npm script runs from the repository root.
 */
export function memoryDir(configured: string = raw.DRIFT_MEMORY_DIR, sample: boolean = raw.SAMPLE_MODE === "true"): string {
  return configured.trim() || (sample ? SAMPLE_MEMORY_DIR : DEFAULT_MEMORY_DIR);
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
  /** LINUX_SSH_CONFIG; "" = the user's own ssh_config. */
  linuxSshConfig: raw.LINUX_SSH_CONFIG.trim(),
  /** DRIFT_VAULT_DIR; "" = the vault is off. */
  vaultDir: raw.DRIFT_VAULT_DIR.trim(),
  /** DRIFT_POLICY_FILE, default policy/hackathon.json. */
  policyFile: raw.DRIFT_POLICY_FILE.trim() || "policy/hackathon.json",
  /** DRIFT_MEMORY_DIR, default .world/memory (examples/memory in sample mode): the store TechnicianMemory opens (src/engine/memory.ts). */
  memoryDir: memoryDir(),
  /** DRIFT_NGINX_T as configured; "" = the platform default (nginxTCommand). */
  nginxT: raw.DRIFT_NGINX_T.trim(),
  /** PROBE_TARGETS_OVERRIDE, parsed; [] = the probe population is the Cloudflare account's records. */
  probeOverride: parseProbeOverride(raw.PROBE_TARGETS_OVERRIDE),
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
