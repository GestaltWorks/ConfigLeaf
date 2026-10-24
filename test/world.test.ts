import { describe, expect, it } from "vitest";
import { DriftWorld, type Observation } from "../src/engine/world.ts";

const base: Omit<Observation, "observedAt" | "collectionId" | "refersTo"> = {
  tenantId: "t1",
  surface: "linux.nginx.vhost",
  objectId: "/etc/nginx/sites-enabled/app.conf",
  settingPath: "server.location./.proxy_pass",
  valueHash: "sha256:vhost-unchanged",
  source: "ssh",
  authority: 100,
};

describe("FOUND-BUT-DIFFERENT primitive", () => {
  it("detects a byte-identical setting whose referenced target changed underneath it", async () => {
    const w = new DriftWorld("test");
    const t1 = "2026-10-20T02:00:00.000Z";
    const t2 = "2026-10-23T02:00:00.000Z";

    await w.observe({ ...base, observedAt: t1, collectionId: "c1", refersTo: { targetType: "upstream", targetId: "app_backend", fingerprint: "sha256:10.0.0.5:8080" } });
    await w.observe({ ...base, observedAt: t2, collectionId: "c2", refersTo: { targetType: "upstream", targetId: "app_backend", fingerprint: "sha256:203.0.113.9:8080" } });

    const sid = w.settingId(base);
    const result = w.foundButDifferent(sid, t1, t2);
    expect(result.before).toBe("sha256:10.0.0.5:8080");
    expect(result.after).toBe("sha256:203.0.113.9:8080");
    expect(result.changed).toBe(true);
    expect(w.fingerprintNow(sid)).toBe("sha256:203.0.113.9:8080");
  });

  it("reports no change when the target fingerprint is stable", async () => {
    const w = new DriftWorld("test2");
    const t1 = "2026-10-20T02:00:00.000Z";
    const t2 = "2026-10-23T02:00:00.000Z";
    await w.observe({ ...base, observedAt: t1, collectionId: "c1", refersTo: { targetType: "upstream", targetId: "app_backend", fingerprint: "sha256:same" } });
    await w.observe({ ...base, observedAt: t2, collectionId: "c2", refersTo: { targetType: "upstream", targetId: "app_backend", fingerprint: "sha256:same" } });
    expect(w.foundButDifferent(w.settingId(base), t1, t2).changed).toBe(false);
  });

  it("refuses a write without provenance (engine contract)", async () => {
    const w = new DriftWorld("test3");
    await expect(w.world.upsertEntity({ type: "x", name: "no prov", source: undefined as never })).rejects.toThrow(/provenance/);
  });
});
