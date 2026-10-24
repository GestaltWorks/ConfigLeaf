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

import { WorldModel, type Provenance } from "../../vendor/world-model/src/index.ts";

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
}
