// Our module boundary over the vendored Meterless World Model reference.
//
// The conformance runner loads THIS file (WORLD_MODEL_IMPL) and requires the exports
// WorldModel, entityIdFromName, normalizeName and decide. We re-export the reference's
// implementations unchanged and add the domain layer the agent needs on top:
// settings, the objects they reference, and a fingerprint of what each reference
// resolved to at observation time. That fingerprint is what makes FOUND-BUT-DIFFERENT
// detectable: a setting whose bytes never changed, pointing at a target that did.

export { WorldModel, entityIdFromName, normalizeName, decide, canonicalJson, sha256Hex } from "../../vendor/world-model/src/index.ts";
export type { Entity, Fact, Provenance, Relationship, WorldEvent } from "../../vendor/world-model/src/index.ts";

import { WorldModel, type Provenance, type Relationship } from "../../vendor/world-model/src/index.ts";
import type { FindingSummary } from "../catalogue/select.ts";
import type { FindingClass } from "../catalogue/templates.ts";
import type { DataLayer, RunOptions } from "../data/layer.ts";
import { objects } from "../data/queries.ts";
import type { Tracer } from "../trace.ts";

export const SYSTEM = "drift";

export interface Observation {
  tenantId: string;
  surface: string;          // "linux.nginx.vhost", "cloudflare.waf.rule"
  objectId: string;         // stable id of the containing object (file path, rule id)
  settingPath: string;      // dotted path within the object
  valueHash: string;        // sha256 of the canonical value
  refersTo?: { targetType: string; targetId: string; fingerprint: string | null };
  observedAt: string;       // ISO 8601
  source: string;           // "ssh" | "cloudflare" | "backup" | "golden"
  authority: number;        // 100 live vendor API, 40 backup artifact, 20 golden/expectation
  collectionId: string;
}

export class DriftWorld {
  readonly world: WorldModel;

  constructor(namespace = "drift", storage: "memory" | "local" = "memory", directory?: string) {
    this.world = new WorldModel({ namespace, storage, directory });
  }

  private prov(o: Pick<Observation, "observedAt" | "source" | "collectionId">): Provenance {
    return { kind: o.source, at: o.observedAt, runId: o.collectionId, by: "collector" };
  }

  settingId(o: Pick<Observation, "tenantId" | "surface" | "objectId" | "settingPath">): string {
    return `setting:${SYSTEM}:${o.tenantId}|${o.surface}|${o.objectId}|${o.settingPath}`;
  }

  targetId(t: { targetType: string; targetId: string }, tenantId: string): string {
    return `${t.targetType}:${SYSTEM}:${tenantId}|${t.targetId}`;
  }

  /** Record one observation: the setting's value as a fact, and its reference as a bitemporal edge plus a fingerprint fact on the target. */
  async observe(o: Observation): Promise<void> {
    const prov = this.prov(o);
    const sid = this.settingId(o);
    await this.world.upsertEntity({
      type: "setting",
      externalKey: { system: SYSTEM, id: sid.slice("setting:drift:".length) },
      attrs: { tenantId: o.tenantId, surface: o.surface, objectId: o.objectId, settingPath: o.settingPath },
      source: prov,
    });
    await this.world.assertFact({ about: sid, predicate: `value_hash:${o.source}`, value: o.valueHash, confidence: 1, source: prov });
    if (o.refersTo) {
      const tid = this.targetId(o.refersTo, o.tenantId);
      await this.world.upsertEntity({
        type: o.refersTo.targetType,
        externalKey: { system: SYSTEM, id: `${o.tenantId}|${o.refersTo.targetId}` },
        attrs: { tenantId: o.tenantId },
        source: prov,
      });
      await this.world.relate({ from: sid, type: "refers_to", to: tid, validFrom: o.observedAt, source: prov });
      await this.world.assertFact({ about: tid, predicate: "fingerprint", value: o.refersTo.fingerprint, confidence: 1, source: prov });
    }
  }

  /**
   * What did the target of this setting's reference look like at `at`?
   * Facts are the time-stamped record (the reference writes attrs only as a live cache and
   * does not replay them into snapshots), so the answer is the latest `fingerprint` fact
   * asserted about the target at or before `at`. Null when none existed yet.
   */
  fingerprintAt(settingId: string, at: string): string | null {
    const targets = this.world.view("graph").neighborsOf(settingId, { via: "refers_to", at });
    if (!targets.length) return null;
    const facts = this.world.view("facts").about(targets[0].id)
      .filter((f) => f.predicate === "fingerprint" && f.assertedAt <= at);
    const latest = facts.at(-1);
    return latest && typeof latest.value === "string" ? latest.value : null;
  }

  /** Current fingerprint of the target this setting refers to now (the unsuperseded fact). */
  fingerprintNow(settingId: string): string | null {
    const targets = this.world.view("graph").neighborsOf(settingId, { via: "refers_to" });
    if (!targets.length) return null;
    const live = this.world.view("facts").about(targets[0].id)
      .filter((f) => f.predicate === "fingerprint" && !f.supersededBy).at(-1);
    return live && typeof live.value === "string" ? live.value : null;
  }

  /**
   * FOUND-BUT-DIFFERENT: the setting's own value hash is unchanged between two observations,
   * but the fingerprint of what its reference resolved to is not.
   */
  foundButDifferent(settingId: string, before: string, after: string): { changed: boolean; before: string | null; after: string | null } {
    const b = this.fingerprintAt(settingId, before);
    const a = this.fingerprintAt(settingId, after);
    return { changed: b !== a, before: b, after: a };
  }

  // ---- exposure edges (additive; see "The exposure line" below) ----

  /** A finding's stable id: the same deviation found by a later pass is the same entity. */
  findingId(f: Pick<FindingSummary, "tenant_id" | "class" | "host" | "object_id" | "setting_path" | "resource_id">): string {
    return `${FINDING_PREFIX}${f.tenant_id}|${f.class}|${f.host ?? ""}|${f.object_id}|${f.setting_path}|${f.resource_id ?? ""}`;
  }

  /** A DNS record's id, by the record id Cloudflare gives it (stable across DNS runs). */
  recordId(tenantId: string, recordId: string): string {
    return `${RECORD_PREFIX}${tenantId}|${recordId}`;
  }

  /**
   * Record that `findingId` has been exposed through `recordId` since `since`, as the DNS observation
   * at `until` still shows: an open bitemporal edge finding -> record, validFrom = since, no validTo,
   * attrs { since, exposure_days, until, ... }. Re-running the pass supersedes it.
   *
   * How, given the vendored reference: an edge's id is content-addressed on (from, type, to, context,
   * validFrom), and the fold closes an open edge only when a new one of the same (from, type, context)
   * points at a DIFFERENT target. So the target is the record as observed in one state over one span,
   * `<record>@<since>..<until>`, an entity whose attrs name the plain record: the same measurement
   * again is the same edge (a no-op, idempotent), and a later DNS run or a moved audit event is a new
   * edge that closes the previous one (validTo = the new since, supersededBy = the new edge id). When
   * `since` is unchanged the closed edge's interval is empty: the reference's way of saying the newer
   * reading replaces it over the whole span; it stays in the log with its own exposure_days.
   * Re-running an OLDER measurement after a newer one does not reopen it (its id already exists).
   */
  async exposure(findingId: string, recordId: string, since: string, until: string, meta: ExposureMeta = {}): Promise<Relationship> {
    if (!findingId.startsWith(FINDING_PREFIX)) throw new Error(`exposure: not a finding id: ${findingId}`);
    if (!recordId.startsWith(RECORD_PREFIX)) throw new Error(`exposure: not a dns_record id: ${recordId}`);
    const exposure_days = exposureDays(since, until);
    const source: Provenance = { kind: "pipeline", at: until, runId: meta.dnsRunId, by: "decider" };
    const span = `${recordId.slice(RECORD_PREFIX.length)}@${since}..${until}`;
    await this.world.upsertEntity({ type: "finding", externalKey: { system: SYSTEM, id: findingId.slice(FINDING_PREFIX.length) }, attrs: {}, source });
    await this.world.upsertEntity({ type: "dns_record", externalKey: { system: SYSTEM, id: span }, attrs: { record: recordId, since, observed_at: until, dns_run_id: meta.dnsRunId ?? null }, source });
    return this.world.relate({
      from: findingId, type: EXPOSURE_EDGE, to: `${RECORD_PREFIX}${span}`, validFrom: since,
      attrs: { since, exposure_days, until, record: recordId, event_id: meta.eventId ?? null, dns_run_id: meta.dnsRunId ?? null, bound: meta.bound ?? null },
      source,
    });
  }

  /** Every exposure edge from this finding, closed ones included, oldest first. */
  exposureEdges(findingId: string): Relationship[] {
    const { relationships } = this.world.stateShape() as { relationships: Relationship[] };
    return relationships.filter((r) => r.from === findingId && r.type === EXPOSURE_EDGE)
      .map((r) => structuredClone(r))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** The open exposure edge from this finding, or null. */
  exposureNow(findingId: string): Relationship | null {
    return this.exposureEdges(findingId).find((r) => !r.validTo) ?? null;
  }
}

const FINDING_PREFIX = `finding:${SYSTEM}:`;
const RECORD_PREFIX = `dns_record:${SYSTEM}:`;
export const EXPOSURE_EDGE = "exposure";

export interface ExposureMeta { eventId?: string; dnsRunId?: string; bound?: ExposureBound }

/** Whole days from `since` to `until` (ISO 8601 text), rounded down: computed here, never by a SQL date function. */
export function exposureDays(since: string, until: string): number {
  // ISO 8601 UTC only, the form every *_at column holds; Date.parse alone would also read "16 April" as some year's date.
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
  const a = iso.test(since) ? Date.parse(since) : NaN;
  const b = iso.test(until) ? Date.parse(until) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new RangeError(`exposureDays: not ISO 8601 UTC: ${since} .. ${until}`);
  if (b < a) throw new RangeError(`exposureDays: until ${until} is before since ${since}`);
  return Math.floor((b - a) / 86_400_000);
}

// ---- the exposure line ---------------------------------------------------------------------------------
//
// For a finding whose referent is a DNS record: since when has the record been in the state the finding
// rests on, and for how many whole days up to the DNS run that still shows it. The state is `proxied` for
// the two proxy classes (the finding exists because the record is proxied) and the record's `content` for
// the classes about where it lands. Three SELECTs through the DataLayer, in the portable subset:
//   1. the record's row in the finding's DNS run (the latest passing one for a survey finding): it must
//      still be there, and its observed_at is `until`;
//   2. the first event of the current state: the earliest audit event on the record, at or before
//      `until`, whose body sets that state and after which no event (up to `until`) sets another or
//      deletes the record. Cloudflare logs a record update's request body as new_value (JSON, keys
//      unspaced), so the state is matched with LIKE on `"proxied":true` or `"content":"<content>"`; a log
//      that carries the plain value (old_value/new_value) is matched by equality. The pattern is a
//      parameter: its double quotes are data inside a rendered literal, never SQL text;
//   3. only when 2 says neither "create" nor "came from another value" (old_value), and old_value does not
//      already carry the SAME state (then the state predates the event and `since` is a bound, never
//      upgraded): whether any earlier body that sets ANOTHER state of this field, or a delete, exists. The
//      predicate is field-aware: a body counts only when it names the field (`"proxied":` or `"content":"`,
//      the pattern a parameter) and does not match the current state, so a prior TTL, comment or content
//      edit that says nothing about the field never makes `since` "exact". With one, the first event is a
//      real transition and `since` is exact; with none, the record may have been in this state before the
//      log begins and `since` is a bound: at least that many days. A plain-value log (old_value/new_value
//      bare) dates a transition through old_value alone; its bare values name no field and are not counted.
// No date function anywhere: timestamps compare as ISO text and the days are computed in TypeScript. No
// function call in a top-level WHERE (Zetaris drops such a predicate), no correlation in a JOIN ON. LIKE
// is case-insensitive on sql.js and case-sensitive on Spark; the bodies are lowercase JSON and lowercase
// pseudonyms, so both engines agree on every row of the bundle.

export type ExposureField = "proxied" | "content";
export type ExposureBound = "exact" | "at_least";

/** Which state of the record each class's exposure is about; a class not listed has no exposure line. */
export const EXPOSURE_FIELD: Readonly<Partial<Record<FindingClass, ExposureField>>> = {
  proxy_split: "proxied",
  proxied_without_real_ip: "proxied",
  orphan_record: "content",
  found_but_different: "content",
  dns_change: "content",
};

export const EXPOSURE_RECORD_SQL = `SELECT record_id, run_id, name, type, content, proxied, observed_at
FROM {{t:dns_record}}
WHERE tenant_id = {{p:tenant_id}} AND run_id = {{p:dns_run_id}} AND record_id = {{p:record_id}}
ORDER BY record_id, content`;

export const EXPOSURE_SINCE_SQL = `SELECT e.event_id, e.action, e.actor, e.occurred_at,
       CASE WHEN e.old_value IS NOT NULL AND e.old_value <> '' AND e.old_value <> {{p:state_exact}} AND e.old_value NOT LIKE {{p:state_like}} THEN 1 ELSE 0 END AS from_other,
       CASE WHEN e.old_value IS NOT NULL AND e.old_value <> '' AND (e.old_value = {{p:state_exact}} OR e.old_value LIKE {{p:state_like}}) THEN 1 ELSE 0 END AS from_same
FROM {{t:audit_event}} e
WHERE e.tenant_id = {{p:tenant_id}} AND e.resource_id = {{p:record_id}} AND e.action <> 'view'
  AND e.occurred_at <= {{p:until}}
  AND (e.new_value = {{p:state_exact}} OR e.new_value LIKE {{p:state_like}})
  AND NOT EXISTS (SELECT 1 FROM {{t:audit_event}} x
    WHERE x.tenant_id = e.tenant_id AND x.resource_id = e.resource_id AND x.action <> 'view'
      AND x.occurred_at > e.occurred_at AND x.occurred_at <= {{p:until}}
      AND (x.action = 'delete' OR (x.new_value IS NOT NULL AND x.new_value <> '' AND x.new_value <> {{p:state_exact}} AND x.new_value NOT LIKE {{p:state_like}})))
ORDER BY e.occurred_at, e.event_id`;

/** Earlier events that set ANOTHER state of the field (a body naming the field and not matching the current state), or deleted the record. */
export const EXPOSURE_BEFORE_SQL = `SELECT COUNT(*) AS n
FROM {{t:audit_event}}
WHERE tenant_id = {{p:tenant_id}} AND resource_id = {{p:record_id}} AND action <> 'view' AND occurred_at < {{p:since}}
  AND (action = 'delete' OR (new_value IS NOT NULL AND new_value <> '' AND new_value LIKE {{p:field_like}} AND new_value NOT LIKE {{p:state_like}}))`;

/**
 * What the record's current state is matched as, or why it cannot be: a LIKE wildcard or a JSON escape in the
 * value would match loosely. `field_like` matches any body that names the field at all, whatever the value.
 */
export function exposureState(field: ExposureField, rec: Readonly<Record<string, string>>):{ label: string; exact: string; like: string; field_like: string } | { refused: string } {
  if (field === "proxied") {
    const v = rec.proxied === "1" ? "true" : "false";
    // No audit body equals a LIKE pattern, so the pattern doubles as an equality that never holds.
    return { label: `proxied=${v}`, exact: `%"proxied":${v}%`, like: `%"proxied":${v}%`, field_like: `%"proxied":%` };
  }
  if (rec.content === "" || /[%_\\"]/.test(rec.content)) return { refused: `content ${JSON.stringify(rec.content)} cannot be matched exactly with LIKE` };
  return { label: `content=${rec.content}`, exact: rec.content, like: `%"content":"${rec.content}"%`, field_like: `%"content":"%` };
}

export type ExposureMeasure =
  | { dated: true; record_id: string; field: ExposureField; dns_run_id: string; state: string; since: string; until: string; days: number; bound: ExposureBound; event_id: string; action: string }
  | { dated: false; record_id: string; field: ExposureField; dns_run_id: string; reason: string };

/** The line a finding carries: since, whole days, whether since is exact or a bound, the event, the run that still shows it. */
export interface ExposureLine { since: string; days: number; bound: ExposureBound; source: string; still_open_in: string }

type ExposureFinding = Pick<FindingSummary, "class" | "tenant_id" | "resource_id" | "dns_run_id">;

/**
 * One measurement per key (tenant, DNS run, record and field): `measure` takes the tracer its queries' lines go to and runs on a
 * miss. The pass's is a shared read (src/concurrency.ts SharedReads), so two findings on one record measure it once.
 */
export type ExposureCache = (key: string, measure: (tracer: Tracer | undefined) => Promise<ExposureMeasure>) => Promise<ExposureMeasure>;

/** Date one finding's exposure with SQL; null when its class has none or it names no record. `cache` keys on tenant, DNS run, record and field. */
export async function measureExposure(layer: DataLayer, f: ExposureFinding, opts: RunOptions & { cache?: ExposureCache } = {}): Promise<ExposureMeasure | null> {
  const field = EXPOSURE_FIELD[f.class];
  if (!field || !f.resource_id || !f.dns_run_id) return null;
  const { cache, ...options } = opts;
  const key = [f.tenant_id, f.dns_run_id, f.resource_id, field].join("|");
  const base = { record_id: f.resource_id, field, dns_run_id: f.dns_run_id };
  const measure = async (tracer: Tracer | undefined): Promise<ExposureMeasure> => {
    const run = { ...options, tracer };
    const rec = objects(await layer.run(EXPOSURE_RECORD_SQL, { tenant_id: f.tenant_id, dns_run_id: f.dns_run_id!, record_id: f.resource_id! }, run))[0];
    if (!rec) return { dated: false, ...base, reason: `record ${f.resource_id} is not in DNS run ${f.dns_run_id}` };
    const st = exposureState(field, rec);
    if ("refused" in st) return { dated: false, ...base, reason: st.refused };
    const until = rec.observed_at;
    const params = { tenant_id: f.tenant_id, record_id: f.resource_id!, until, state_exact: st.exact, state_like: st.like };
    const first = objects(await layer.run(EXPOSURE_SINCE_SQL, params, run))[0];
    if (!first) return { dated: false, ...base, reason: `the audit log holds no event on ${f.resource_id} that sets ${st.label} with no later different body up to ${until}` };
    // exact: the record was created in this state, or old_value says it came from another one. at_least, never
    // upgraded: old_value already carries the same state (it predates the event). Otherwise an earlier body that
    // set another state of THIS field, or a delete, makes the first event a real transition: exact.
    let bound: ExposureBound = first.action === "create" || first.from_other === "1" ? "exact" : "at_least";
    if (bound === "at_least" && first.from_same !== "1") {
      const before = objects(await layer.run(EXPOSURE_BEFORE_SQL, { tenant_id: f.tenant_id, record_id: f.resource_id!, since: first.occurred_at, field_like: st.field_like, state_like: st.like }, run))[0];
      if (Number(before?.n ?? 0) > 0) bound = "exact";
    }
    return { dated: true, ...base, state: st.label, since: first.occurred_at, until, days: exposureDays(first.occurred_at, until), bound, event_id: first.event_id, action: first.action };
  };
  return cache ? cache(key, measure) : measure(options.tracer);
}

export function exposureLine(m: Extract<ExposureMeasure, { dated: true }>): ExposureLine {
  return { since: m.since, days: m.days, bound: m.bound, source: `audit:${m.event_id}`, still_open_in: m.dns_run_id };
}

/**
 * The decide step's exposure: measure, store the edge, trace one line (agent decider, action triage: ok
 * when dated, not_checked when the log cannot date it), return the line for the finding or undefined.
 * `defer` takes the edge's store instead of running it, for a caller that writes the World Model in an order of its own:
 * the concurrent pass stores each finding's edge in finding order (src/pipeline.ts).
 */
export async function recordExposure(
  layer: DataLayer, world: DriftWorld, finding: FindingSummary, opts: RunOptions & { cache?: ExposureCache; defer?: (store: () => Promise<unknown>) => void } = {},
): Promise<ExposureLine | undefined> {
  const { defer, ...measured } = opts;
  const m = await measureExposure(layer, finding, { ...measured, agent: opts.agent ?? "decider" });
  if (!m) return undefined;
  if (!m.dated) {
    opts.tracer?.emit({ agent: "decider", action: "triage", status: "not_checked", input_summary: `exposure ${m.record_id}`, output_summary: `exposure not dated: ${m.reason}`, detail: "model: none" });
    return undefined;
  }
  const store = () => world.exposure(world.findingId(finding), world.recordId(finding.tenant_id, m.record_id), m.since, m.until, { eventId: m.event_id, dnsRunId: m.dns_run_id, bound: m.bound });
  if (defer) defer(store);
  else await store();
  opts.tracer?.emit({
    agent: "decider", action: "triage", status: "ok", input_summary: `exposure ${m.record_id}`,
    output_summary: `${m.state} since ${m.since}: ${m.bound === "exact" ? "" : "at least "}${m.days} day(s) to ${m.until}, still so in DNS run ${m.dns_run_id}`,
    detail: `first event of the current state: ${m.event_id} (${m.action}); ${m.bound === "exact" ? "a change into this state is on record" : `no earlier body on record sets another ${m.field} state, so the state may predate the log`}; model: none`,
  });
  return exposureLine(m);
}
