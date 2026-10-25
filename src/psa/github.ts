// GitHub Issues as the ticket adapter's backend: one issue per ticket row in the repository DRIFT_TICKETS_REPO
// names (<owner>/<name>, private), through the REST API with the token `gh auth token` prints.
//
// Contract:
//   - The token is read once, on the first request, from spawnSync("gh", ["auth", "token"]), and held in memory.
//     It goes into the Authorization header and nowhere else: no trace line, no error text, no printed line. A
//     blank token refuses the request with one plain sentence.
//   - create: the title, the body and every label pass outgoing() (src/psa/index.ts: the redactor, then the
//     deny-list probe) before any request; then the labels: the repository's labels are listed once per
//     instance and every missing one of FIXED_LABELS and the draft's is created (POST /labels; a 422
//     already_exists counts as present), each later draft creating only its own new class:<class> and
//     verb:<verb>; then POST /issues. Returns the issue number as external_id and its html_url.
//   - comment: outgoing() over the body before any request, then POST /issues/<n>/comments.
//   - close: PATCH /issues/<n> with state closed, state_reason completed. status: GET /issues/<n>, open or closed.
//   - Every request carries the API version header and a 30 s timeout; `requests` records each as method and
//     path with the repository left out. A failing response throws PsaError with the status, the method, the
//     path template and GitHub's message, redacted.
//
// Measured 24 Oct 2026, TICKETS_LIVE=true (test/psa.test.ts) at 22:42 UTC: issue #1 of DRIFT_TICKETS_REPO,
// "drift-agent smoke: <UTC>", created with the label drift-agent, commented on once and closed within 2 s, in 12
// requests: the label listing, the seven FIXED_LABELS the repository lacked, the issue, the comment, the close and
// the status read back as closed. The fake-fetch suite in the same file holds every route and refusal.

import { spawnSync } from "node:child_process";
import type { FetchLike } from "../collectors/cloudflare.ts";
import { redact } from "../config.ts";
import type { Redactor } from "../redactor.ts";
import { FIXED_LABELS, PsaError, outgoing, screenDraft, type IssueDraft, type IssueRef, type TicketAdapter, type TicketStatus } from "./index.ts";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const ISSUE = /^[1-9]\d{0,9}$/;
const PER_PAGE = 100;
const MAX_LABEL_PAGES = 50;

/**
 * The token `gh auth token` prints, trimmed; "" when gh is absent, signed out or fails. On win32 a spawn that
 * finds no gh on PATH runs the same fixed command line through the shell, which resolves gh.exe the way a
 * terminal does. Measured 24 Oct 2026 on the build machine: spawnSync("gh") answered ENOENT from vitest and from
 * node under Git Bash; the shell form and the absolute path each ran gh and printed a 40-character token.
 */
export function ghToken(): string {
  const opts = { encoding: "utf8" as const, windowsHide: true, timeout: 15_000 };
  let r = spawnSync("gh", ["auth", "token"], opts);
  if (process.platform === "win32" && (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") r = spawnSync("gh auth token", { ...opts, shell: true });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : "";
}

/** A label's colour: the type, priority and kind families each have their own. */
export function labelColor(name: string): string {
  if (name === "drift-agent") return "5319e7";
  if (name === "type:change") return "1d76db";
  if (name === "type:incident") return "d93f0b";
  const p: Record<string, string> = { P1: "b60205", P2: "d93f0b", P3: "fbca04", P4: "0e8a16" };
  if (p[name]) return p[name];
  return name.startsWith("class:") ? "c5def5" : "bfdadc";
}

/** A label's description, under GitHub's 100 characters. */
export function labelDescription(name: string): string {
  if (name === "drift-agent") return "Opened by drift-agent from a disposition of its ledger";
  if (name.startsWith("type:")) return `A drift-agent ticket of type ${name.slice(5)}`;
  if (/^P[1-4]$/.test(name)) return `Priority ${name} from the policy rule that governs the setting`;
  if (name.startsWith("class:")) return `Finding class ${name.slice(6)}`.slice(0, 100);
  return `The verb the ticket opened under: ${name.slice(5)}`.slice(0, 100);
}

export interface GithubOptions {
  /** <owner>/<name>; DRIFT_TICKETS_REPO when absent. */
  repo?: string;
  /** Where the token comes from, read once on the first request; ghToken when absent. */
  token?: () => string;
  fetch?: FetchLike;
  baseUrl?: string;
  redactor: Redactor;
  /** The deny-list (REDACT_WORDS and EXPORT_DENY_WORDS). */
  deny: readonly string[];
}

interface Reply<T> { ok: boolean; status: number; json: T | null }

export class GithubIssues implements TicketAdapter {
  readonly psa = "github" as const;
  /** Every request made, as "<METHOD> <path>" with the repository left out, in order. */
  readonly requests: string[] = [];
  private readonly repo: string;
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private tokenValue: string | undefined;
  private labels: Set<string> | null = null;

  constructor(private readonly opts: GithubOptions) {
    const repo = (opts.repo ?? process.env.DRIFT_TICKETS_REPO ?? "").trim();
    if (!REPO.test(repo)) throw new PsaError("DRIFT_TICKETS_REPO must name the tickets repository as <owner>/<name>; it is blank or malformed");
    this.repo = repo;
    this.base = (opts.baseUrl ?? GITHUB_API).replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  async create(draft: IssueDraft): Promise<IssueRef> {
    const d = screenDraft(this.opts.redactor, this.opts.deny, draft);
    await this.ensureLabels(d.labels);
    const r = await this.call<{ number?: unknown; html_url?: unknown }>("POST", "/issues", { title: d.title, body: d.body, labels: d.labels });
    if (!r.ok || typeof r.json?.number !== "number" || typeof r.json.html_url !== "string") this.fail("POST", "/issues", r);
    return { external_id: String(r.json.number), url: r.json.html_url };
  }

  async comment(externalId: string, body: string): Promise<void> {
    const text = outgoing(this.opts.redactor, this.opts.deny, body, "comment");
    const n = this.issue(externalId);
    const r = await this.call("POST", `/issues/${n}/comments`, { body: text });
    if (!r.ok) this.fail("POST", "/issues/<n>/comments", r);
  }

  async close(externalId: string): Promise<void> {
    const n = this.issue(externalId);
    const r = await this.call("PATCH", `/issues/${n}`, { state: "closed", state_reason: "completed" });
    if (!r.ok) this.fail("PATCH", "/issues/<n>", r);
  }

  async status(externalId: string): Promise<TicketStatus> {
    const n = this.issue(externalId);
    const r = await this.call<{ state?: unknown }>("GET", `/issues/${n}`);
    if (!r.ok) this.fail("GET", "/issues/<n>", r);
    return r.json?.state === "closed" ? "closed" : "open";
  }

  /** The repository's labels, listed once; every missing one of FIXED_LABELS (on the first call) and of `names` created. */
  private async ensureLabels(names: readonly string[]): Promise<void> {
    let wanted = [...names];
    if (this.labels === null) {
      const have = new Set<string>();
      for (let page = 1; page <= MAX_LABEL_PAGES; page++) {
        const r = await this.call<{ name?: unknown }[]>("GET", `/labels?per_page=${PER_PAGE}&page=${page}`);
        if (!r.ok) this.fail("GET", "/labels", r);
        const list = Array.isArray(r.json) ? r.json : [];
        for (const l of list) if (typeof l?.name === "string") have.add(l.name.toLowerCase());
        if (list.length < PER_PAGE) break;
      }
      this.labels = have;
      wanted = [...FIXED_LABELS, ...wanted];
    }
    for (const name of [...new Set(wanted)]) {
      if (this.labels.has(name.toLowerCase())) continue;
      const label = outgoing(this.opts.redactor, this.opts.deny, name, "labels");
      const r = await this.call<{ errors?: { code?: unknown }[] }>("POST", "/labels", { name: label, color: labelColor(label), description: labelDescription(label) });
      const exists = r.status === 422 && (r.json?.errors ?? []).some((e) => e?.code === "already_exists");
      if (!r.ok && !exists) this.fail("POST", "/labels", r);
      this.labels.add(label.toLowerCase());
    }
  }

  private issue(externalId: string): string {
    if (!ISSUE.test(externalId)) throw new PsaError(`an issue number is digits, got ${this.opts.redactor.text(externalId).slice(0, 40)}`);
    return externalId;
  }

  private token(): string {
    if (this.tokenValue === undefined) this.tokenValue = (this.opts.token ?? ghToken)().trim();
    if (!this.tokenValue) throw new PsaError("the GitHub token is blank: `gh auth token` printed nothing; sign in with `gh auth login` and run again");
    return this.tokenValue;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const token = this.token();
    this.requests.push(`${method} ${path}`);
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}/repos/${this.repo}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "drift-agent",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new PsaError(this.opts.redactor.text(redact(`GitHub ${method} ${path.replace(/\d+/g, "<n>").split("?")[0]}: ${(e as Error).message}`)));
    }
    const text = await r.text();
    let json: T | null = null;
    try { json = text ? (JSON.parse(text) as T) : null; } catch { /* not JSON: the status speaks */ }
    return { ok: r.ok, status: r.status, json };
  }

  private fail(method: string, template: string, r: Reply<unknown>): never {
    const msg = typeof (r.json as { message?: unknown } | null)?.message === "string" ? (r.json as { message: string }).message : "";
    throw new PsaError(this.opts.redactor.text(redact(`GitHub ${r.status} ${method} ${template}: ${msg || "no message"}`)).slice(0, 300));
  }
}
