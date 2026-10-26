// The console's read-only JSON API: GET /api/v1 and the three endpoints it lists, over the View the pages read (the
// same snapshot, the same decisions, the same objects), so a number here is the number the page shows.
//
// Contract:
//   - GET /api/v1                the index: these endpoints and the console's JSON-capable actions, one line each.
//     GET /api/v1/summary        the tenant, the instant its decisions were made, the counts of the summary bar, the last cycle and
//                                the source ("sample" or "live").
//     GET /api/v1/findings       every finding the Findings page lists, the page's order: id, class, verb, status, the Decider's
//                                reason, the object, the rule, the expiry.
//     GET /api/v1/settings       every object the Settings page lists, the page's order, with its filters as query parameters
//                                (group, lock, status, q).
//   - Every endpoint takes ?tenant=<id> as the pages do: one of the tenants the store holds runs of, else 400; none names
//     the tenant the switcher set. GET and HEAD only, any other method 405; a path under /api/ that is none of these is 404;
//     a read that fails is 500. Every answer is JSON, { status, error, message } when it is an error, and never a stack.
//   - The server sends it with the headers of every answer (no-store, the CSP, the two security headers) after the Host
//     header rule; nothing here sets a header or reads a body.
//   - Every string that comes from a row passes the backend's redactor, the one the pages pass theirs through; the filters
//     compare against the redacted strings, so a filter cannot be used to find out what a redaction replaced. The one
//     exception is `key`, the opaque object key the actions take as their form field, which is not text.
//   - Nothing is written: no pass is started, no window opened. The first read of a tenant runs its first pass, as the first
//     page of that tenant does.

import { redact } from "../config.ts";
import type { PolicyRule } from "../data/rows.ts";
import { classLabel, findingWhere, tail } from "../loop/present.ts";
import type { Verb } from "../pipeline.ts";
import { encodeKey, type View } from "./pages.ts";
import { STATUSES, STATUS_OF, objectKey, type Decision, type Lock, type SettingObject, type Status } from "./state.ts";

export interface ApiContext {
  /** The tenants the store holds runs of. */
  tenants: readonly string[];
  /** The tenant a request that names none reads: the one the switcher set. */
  tenant(): string;
  /** The page's own read of a tenant (its first pass run when it is first named). */
  view(tenant: string): Promise<View>;
  /** The backend's redactor, as every page string passes it. */
  text(s: string): string;
  print(line: string): void;
}

export interface ApiAnswer { status: number; body: string }

const ENDPOINTS = [
  { method: "GET", path: "/api/v1", description: "This index: the endpoints and the JSON-capable actions, one line each." },
  { method: "GET", path: "/api/v1/summary", description: "The tenant, when its decisions were made, the summary bar's counts, the last cycle and the source (sample or live)." },
  { method: "GET", path: "/api/v1/findings", description: "Every finding the Findings page lists: id, class, verb, status, the Decider's reason, the object, the rule and the expiry." },
  { method: "GET", path: "/api/v1/settings", description: "Every object the Settings page lists, with its live and approved value, lock, rule and status; filters group, lock (locked, open, window), status and q (text)." },
] as const;

const ACTIONS = [
  { method: "POST", path: "/do/lock", description: "Close the open change window on one object, approving nothing.", form: ["csrf", "page_tenant", "key", "confirm=yes"] },
  { method: "POST", path: "/do/unlock", description: "Open a change window on one object: who, hours (1 to 72) and why.", form: ["csrf", "page_tenant", "key", "who", "hours", "why", "confirm=yes"] },
  { method: "POST", path: "/do/approve", description: "Approve the live value of one object from the latest passing run, closing its open window.", form: ["csrf", "page_tenant", "key", "by", "note", "confirm=yes"] },
  { method: "POST", path: "/do/pass", description: "Run a pass over the store at the clock: recorded in the sample's ledger, a dry pass live; act is never run.", form: ["csrf", "page_tenant"] },
] as const;

const NOTES = [
  "Every endpoint takes ?tenant=<id>, one of `tenants`; without it the console's current tenant answers.",
  "Strings from the store are redacted as the pages redact them.",
  "An action is a form POST, application/x-www-form-urlencoded, with Accept: application/json; it answers { ok, title, lines }. `csrf` is the console's token, the hidden csrf field of any page's forms; `key` is the `key` of an object of /api/v1/settings.",
] as const;

const LOCKS: readonly Lock[] = ["locked", "open", "window"];
/** Attention first, as the Settings page orders its rows: with a technician, drifted, held, in an open window, then the rest. */
const ATTENTION: readonly Status[] = ["with a technician", "drifted", "held"];
const rank = (o: SettingObject): number => { const i = ATTENTION.indexOf(o.status); return i >= 0 ? i : o.lock === "window" ? ATTENTION.length : ATTENTION.length + 1; };
/** The Findings page's sections: needs a person, restore, held, adopted. */
const SECTION: Readonly<Record<Verb, number>> = { ESCALATE: 0, FIX: 0, ROLLBACK: 1, HOLD: 2, ADOPT: 3 };
const VERBS: readonly Verb[] = ["ESCALATE", "FIX", "ROLLBACK", "HOLD", "ADOPT"];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A rule as the Settings page names its template: its object and setting globs; a ** · ** rule is a catch-all. */
const template = (r: PolicyRule | null): string => (!r ? "none" : r.object_glob === "**" && r.setting_glob === "**" ? (r.surface === "*" ? "everything else (catch-all)" : `every ${r.surface} setting`) : `${r.object_glob} · ${r.setting_glob}`);

/** Where a decision's finding is, in the Findings page's words. */
function whereOf(v: View, d: Decision): string {
  if (d.finding) return findingWhere(d.finding.finding, true);
  if (d.surface === "cloudflare.dns") {
    const r = v.snapshot.records.find((x) => x.record_id === d.object_id);
    return `${r?.name ?? d.object_id}${d.setting_path ? ` ${d.setting_path}` : ""}`;
  }
  return `${tail(d.object_id)}${d.setting_path && d.setting_path !== "file" ? ` ${d.setting_path}` : ""}${d.host ? ` on ${d.host}` : ""}`;
}

/** The instant the current decisions were made, as the summary bar names it; null when the ledger holds none open. */
const decidedAtOf = (v: View): string | null => (v.source === "pass" && v.pass ? v.pass.decidedAt : v.snapshot.doc.data.decidedAt);

function summary(v: View): unknown {
  const n = (verb: Verb): number => v.decisions.filter((d) => d.verb === verb).length;
  return {
    tenant: v.tenant,
    decided_at: decidedAtOf(v),
    source: v.mode,
    counts: {
      findings_open: v.decisions.length, ...Object.fromEntries(VERBS.map((verb) => [verb, n(verb)])),
      locked: v.objects.filter((o) => o.lock === "locked").length, windows_open: v.objects.filter((o) => o.lock === "window").length, objects: v.objects.length,
    },
    last_cycle: v.lastCycle ? { id: v.lastCycle.id, at: v.lastCycle.first, trace: v.lastCycle.ref } : null,
  };
}

function findings(v: View): unknown {
  const sorted = v.decisions.slice().sort((a, b) => SECTION[a.verb] - SECTION[b.verb] || cmp(a.verb, b.verb) || cmp(a.class, b.class) || cmp(a.finding_id, b.finding_id));
  return {
    tenant: v.tenant,
    decided_at: decidedAtOf(v),
    count: sorted.length,
    findings: sorted.map((d) => ({
      id: d.finding_id,
      class: d.class,
      class_label: classLabel(d.class),
      verb: d.verb,
      status: STATUS_OF[d.verb],
      reason: oneLine(d.reason),
      object: { key: encodeKey(objectKey(d.surface, d.host, d.object_id)), surface: d.surface, host: d.host, id: d.object_id, setting: d.setting_path, where: whereOf(v, d) },
      rule_id: d.rule_id,
      expires_at: d.expires_at,
    })),
  };
}

interface SettingFilter { group: string; lock: Lock | ""; status: Status | ""; q: string }

function settings(v: View, f: SettingFilter, text: (s: string) => string): unknown {
  const rows = v.objects.slice().sort((a, b) => rank(a) - rank(b)).map((o) => ({
    key: encodeKey(o.key),
    id: o.object_id,
    name: o.name,
    kind: o.kind,
    surface: o.surface,
    group: o.group,
    host: o.kind === "file" ? o.host : null,
    zone: o.kind === "record" ? o.group.replace(/^zone /, "") : null,
    live: { value: o.live.text, hash: o.live.hash, absent: o.live.absent },
    approved: o.approved ? { hash: o.approved.value_hash, at: o.approved.approved_at, by: o.approved.approved_by } : null,
    differs: o.differs,
    lock: o.lock,
    rule: o.rule ? { id: o.rule.rule_id, template: template(o.rule), criticality: o.rule.criticality, locked: o.rule.lock === 1 } : null,
    window: o.window ? { id: o.window.window_id, opened_by: o.window.opened_by, opened_at: o.window.opened_at, until: o.window.until, reason: o.window.reason } : null,
    status: o.status,
  }));
  // the filters compare against what is sent: the redacted strings, so a filter never tells what a redaction replaced
  const sent = redacted(rows, text) as typeof rows;
  const term = f.q.trim().toLowerCase();
  const kept = sent.filter((o) => (!f.group || o.group === f.group) && (!f.lock || o.lock === f.lock) && (!f.status || o.status === f.status)
    && (!term || [o.id, o.name, o.group, o.rule?.id ?? "", o.rule?.template ?? "none", o.status, o.live.value].join(" ").toLowerCase().includes(term)));
  return {
    ...(redacted({ tenant: v.tenant, filter: { group: f.group || null, lock: f.lock || null, status: f.status || null, q: f.q.trim() || null } }, text) as object),
    count: kept.length,
    total: sent.length,
    windows_error: v.snapshot.windowsError === null ? null : text(v.snapshot.windowsError),
    objects: kept,
  };
}

/** A payload with every string value through `f`; the property names and the opaque `key` values (the actions' form field) stay as they are. */
function redacted(x: unknown, f: (s: string) => string, name = ""): unknown {
  if (typeof x === "string") return name === "key" ? x : f(x);
  if (Array.isArray(x)) return x.map((y) => redacted(y, f, name));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, redacted(y, f, k)]));
  return x;
}

const json = (status: number, x: unknown): ApiAnswer => ({ status, body: `${JSON.stringify(x, null, 2)}\n` });
const failure = (status: number, error: string, message: string, more: Record<string, unknown> = {}): ApiAnswer => json(status, { status, error, message, ...more });

/**
 * The answer to a request under /api/: its status and its JSON body. The method, the tenant and the path are checked in
 * that order, as nothing is read for a request that cannot be answered; a read that fails is a 500 with the message's first
 * line, never a stack.
 */
export async function apiAnswer(method: string, url: URL, ctx: ApiContext): Promise<ApiAnswer> {
  if (method !== "GET" && method !== "HEAD") return failure(405, "method_not_allowed", `${method.slice(0, 16)} is not allowed: the API is read-only, GET and HEAD only.`, { allow: ["GET", "HEAD"] });
  const asked = url.searchParams.get("tenant");
  if (asked !== null && !ctx.tenants.includes(asked)) return failure(400, "unknown_tenant", ctx.text(`No tenant ${asked.slice(0, 64)}: the store holds runs of ${ctx.tenants.join(", ")}.`));
  const tenant = asked ?? ctx.tenant();
  const route = url.pathname.replace(/\/+$/, "");
  const q = url.searchParams;
  try {
    switch (route) {
      case "/api/v1": return json(200, { name: "ConfigLeaf console API", version: "v1", read_only: true, tenant: ctx.text(tenant), tenants: ctx.tenants.map((t) => ctx.text(t)), endpoints: ENDPOINTS, actions: ACTIONS, notes: NOTES });
      case "/api/v1/summary": return json(200, redacted(summary(await ctx.view(tenant)), ctx.text));
      case "/api/v1/findings": return json(200, redacted(findings(await ctx.view(tenant)), ctx.text));
      case "/api/v1/settings": {
        const lock = q.get("lock") ?? "";
        const status = q.get("status") ?? "";
        if (lock && !LOCKS.includes(lock as Lock)) return failure(400, "bad_filter", `lock: one of ${LOCKS.join(", ")}; got ${ctx.text(lock.slice(0, 64))}.`);
        if (status && !STATUSES.includes(status as Status)) return failure(400, "bad_filter", `status: one of ${STATUSES.join(", ")}; got ${ctx.text(status.slice(0, 64))}.`);
        return json(200, settings(await ctx.view(tenant), { group: q.get("group") ?? "", lock: lock as Lock | "", status: status as Status | "", q: q.get("q") ?? "" }, ctx.text));
      }
      default: return failure(404, "not_found", ctx.text(`No endpoint ${url.pathname.slice(0, 100)}: GET /api/v1 lists them.`));
    }
  } catch (e) {
    const message = ctx.text(redact(String((e as Error)?.message ?? e).split("\n")[0])).slice(0, 300);
    ctx.print(`console: ${method} ${url.pathname}: ${message}`);
    return failure(500, "internal_error", message);
  }
}
