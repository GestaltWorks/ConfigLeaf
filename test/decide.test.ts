// The Decider (src/policy/decide.ts), pure: every branch of the design's table, over hand-built inputs. The
// pass that feeds it from the DataLayer is test/pipeline.test.ts, over test/fixtures/policy-bundle.json.
import { describe, expect, it } from "vitest";
import type { PolicyRule } from "../src/data/rows.ts";
import {
  NO_PROBE_RUN, decide, gapCount, holdUntil, production, productionText, validCopy,
  type CopyCandidate, type DecideInput, type ProbeView,
} from "../src/policy/decide.ts";

const AT = "2026-10-24T12:00:00.000Z";
const APPROVED_HASH = `sha256:${"a1b2c3d4e5f6".repeat(5)}a1b2`;
const OTHER_HASH = `sha256:${"9".repeat(64)}`;
const NAME = "shop.example.invalid";

const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({
  rule_id: "rule-00000000000000a1", tenant_id: "*", surface: "linux.nginx", object_glob: "/etc/nginx/conf.d/*.conf", setting_glob: "file",
  criticality: "critical", lock: 1, on_drift: "rollback", on_no_copy: "investigate_ticket", hold_max_hours: 24, alert: "on_fix", psa_priority: "P1",
  version: 1, author: "operator", since: "2026-10-25T00:00:00.000Z", note: null, ...over,
});

const copy = (over: Partial<CopyCandidate> = {}): CopyCandidate => ({
  copy_id: "copy-0000000000000001", run_id: "run-1020", git_commit: "5a14a89d0123456789abcdef0123456789abcdef", blob_sha256: APPROVED_HASH,
  taken_at: "2026-10-20T02:01:00.000Z", value_hash: APPROVED_HASH, validator: "nginx-t", result: "ok", missing_dependencies: "", validated_at: "2026-10-21T04:00:00.000Z", ...over,
});

const FAILING: ProbeView = { run_id: "run-probe", rows: [{ kind: "http", target: NAME, status: "fail" }, { kind: "dns", target: NAME, status: "ok" }, { kind: "tls", target: "api.example.invalid", status: "fail" }] };
const ANSWERING: ProbeView = { run_id: "run-probe", rows: [{ kind: "http", target: NAME, status: "ok" }, { kind: "dns", target: NAME, status: "ok" }, { kind: "tls", target: "api.example.invalid", status: "fail" }] };
const ELSEWHERE: ProbeView = { run_id: "run-probe", rows: [{ kind: "http", target: "api.example.invalid", status: "fail" }] };
const NONE: ProbeView = { run_id: null, rows: [] };

const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  finding: { class: "drift_vs_approved" },
  rule: rule(),
  exception: { state: "none" },
  checks: { verb: "ESCALATE", why: "2 of 4 preconditions fail: setting_matches_approved, restore_would_regress" },
  approved: { value_hash: APPROVED_HASH, approved_at: "2026-10-19T09:00:00.000Z", approved_by: "tech-4e" },
  copies: [],
  probes: ANSWERING,
  serves: [NAME],
  decidedAt: AT,
  ...over,
});

describe("decide: precedence", () => {
  it("no rule: the default, exactly the checks' verb and sentence, decided_by default, no rule, no expiry", () => {
    expect(decide(input({ rule: null }))).toEqual({ verb: "ESCALATE", reason: "2 of 4 preconditions fail: setting_matches_approved, restore_would_regress", expires_at: null, decided_by: "default", rule_id: null });
    expect(decide(input({ rule: null, checks: { verb: "ADOPT", why: "all 4 preconditions hold; candidate pending a judge" } })))
      .toEqual({ verb: "ADOPT", reason: "all 4 preconditions hold; candidate pending a judge", expires_at: null, decided_by: "default", rule_id: null });
  });

  it("an accepted exception in force outranks a locked rollback rule with a valid copy: ADOPT until the lesson's expiry, decided_by operator", () => {
    const d = decide(input({ copies: [copy()], exception: { state: "applied", lesson: "mem-1", expires_at: "2026-11-30T00:00:00.000Z", reason: "the vendor ships this file" } }));
    expect(d).toEqual({
      verb: "ADOPT", decided_by: "operator", rule_id: null, expires_at: "2026-11-30T00:00:00.000Z",
      reason: "accepted exception mem-1 holds until 2026-11-30T00:00:00.000Z (the vendor ships this file); the checks alone would say ESCALATE",
    });
  });

  it("a lapsed exception outranks the rule too: ESCALATE, decided_by operator, no expiry", () => {
    const d = decide(input({ copies: [copy()], exception: { state: "lapsed", lesson: "mem-2", expires_at: "2026-10-01T00:00:00.000Z", reason: "temporary" } }));
    expect(d).toEqual({
      verb: "ESCALATE", decided_by: "operator", rule_id: null, expires_at: null,
      reason: "exception lapsed: mem-2 expired 2026-10-01T00:00:00.000Z; re-raised to the technician, the checks alone would say ESCALATE",
    });
  });

  it("is pure: the same input gives the same decision, and the input is left as it was", () => {
    const i = input({ copies: [copy({ copy_id: "copy-b", taken_at: "2026-10-21T02:01:00.000Z" }), copy()] });
    const before = structuredClone(i);
    expect(decide(i)).toEqual(decide(structuredClone(i)));
    expect(i).toEqual(before);
  });
});

describe("decide: drift_vs_approved under a rule", () => {
  it("lock 1 with a valid copy: ROLLBACK, naming the approved hash (12 hex), the vault commit (8) and the validation with its gap count", () => {
    const d = decide(input({ copies: [copy()] }));
    expect(d).toEqual({
      verb: "ROLLBACK", decided_by: "policy", rule_id: "rule-00000000000000a1", expires_at: null,
      reason: "live value drifted from approved a1b2c3d4e5f6; vault commit 5a14a89d holds the approved copy, validated ok with 0 gaps, so rule rule-00000000000000a1 rolls it back to that copy",
    });
  });

  it("a copy validated ok_with_gaps is valid; the reason counts its gaps", () => {
    const d = decide(input({ copies: [copy({ result: "ok_with_gaps", missing_dependencies: "/etc/letsencrypt/options-ssl-nginx.conf\n/etc/letsencrypt/live/host-aaaaaa.tld/fullchain.pem\n" })] }));
    expect(d.verb).toBe("ROLLBACK");
    expect(d.reason).toContain("validated ok_with_gaps with 2 gaps");
  });

  it("on_drift rollback with lock 0 takes the same path; so does lock 1 whatever on_drift says", () => {
    expect(decide(input({ rule: rule({ lock: 0 }), copies: [copy()] })).verb).toBe("ROLLBACK");
    expect(decide(input({ rule: rule({ on_drift: "hold" }), copies: [copy()] })).verb).toBe("ROLLBACK");
    expect(decide(input({ rule: rule({ on_drift: "investigate" }), copies: [copy()] })).verb).toBe("ROLLBACK");
  });

  it("the copy is the newest valid one of the approved value: a failed, an unvalidated and another value's copy are passed over", () => {
    const older = copy({ copy_id: "copy-old", git_commit: "1111111111111111111111111111111111111111", taken_at: "2026-10-18T02:01:00.000Z" });
    const newer = copy({ copy_id: "copy-new", git_commit: "2222222222222222222222222222222222222222", taken_at: "2026-10-20T02:01:00.000Z" });
    const failed = copy({ copy_id: "copy-fail", git_commit: "3333333333333333333333333333333333333333", taken_at: "2026-10-22T02:01:00.000Z", result: "fail" });
    const unvalidated = copy({ copy_id: "copy-none", git_commit: "4444444444444444444444444444444444444444", taken_at: "2026-10-22T02:01:00.000Z", result: "", validator: "", validated_at: "" });
    const otherValue = copy({ copy_id: "copy-other", git_commit: "5555555555555555555555555555555555555555", taken_at: "2026-10-23T02:01:00.000Z", blob_sha256: OTHER_HASH, value_hash: OTHER_HASH });
    expect(validCopy([failed, newer, unvalidated, older, otherValue], APPROVED_HASH)?.copy_id).toBe("copy-new");
    expect(decide(input({ copies: [failed, newer, unvalidated, older, otherValue] })).reason).toContain("vault commit 22222222");
    expect(validCopy([failed, unvalidated, otherValue], APPROVED_HASH)).toBeNull();
  });

  it("a record field's copy is the record's JSON: its blob hash is another value, and the run's observation of the field carries the approved hash", () => {
    const record = copy({ validator: "cf-schema", blob_sha256: OTHER_HASH, value_hash: APPROVED_HASH, git_commit: "88d297bf0000000000000000000000000000000a" });
    const d = decide(input({ rule: rule({ surface: "cloudflare.dns", object_glob: "*", setting_glob: "content", hold_max_hours: 4 }), copies: [record], serves: ["mail.example.invalid"] }));
    expect(d.verb).toBe("ROLLBACK");
    expect(d.reason).toContain("vault commit 88d297bf");
  });

  it("no valid copy and production affected: on_no_copy investigate_ticket -> FIX, ticket -> ESCALATE, adopt -> ADOPT", () => {
    const failed = [copy({ result: "fail" })];
    const fix = decide(input({ copies: failed, probes: FAILING }));
    expect(fix).toEqual({
      verb: "FIX", decided_by: "policy", rule_id: "rule-00000000000000a1", expires_at: null,
      reason: `live value drifted from approved a1b2c3d4e5f6 with no valid copy (1 copy in the vault, latest validation fail) and production affected (1 failing probe in run-probe: http ${NAME}), so rule rule-00000000000000a1 investigates, fixes where allowed, documents and opens a ticket`,
    });
    const ticket = decide(input({ rule: rule({ on_no_copy: "ticket" }), probes: FAILING }));
    expect([ticket.verb, ticket.expires_at]).toEqual(["ESCALATE", null]);
    expect(ticket.reason).toBe(`live value drifted from approved a1b2c3d4e5f6 with no valid copy (none in the vault) and production affected (1 failing probe in run-probe: http ${NAME}), so rule rule-00000000000000a1 opens a ticket for a technician`);
    const adopt = decide(input({ rule: rule({ on_no_copy: "adopt" }), probes: FAILING }));
    expect([adopt.verb, adopt.decided_by]).toEqual(["ADOPT", "policy"]);
    expect(adopt.reason).toMatch(/so rule rule-00000000000000a1 adopts the live value$/);
  });

  it("no valid copy and production answering: HOLD until decided_at + hold_max_hours, saying drift from the approved value, no valid copy, production answering", () => {
    const d = decide(input({ probes: ANSWERING }));
    expect(d).toEqual({
      verb: "HOLD", decided_by: "policy", rule_id: "rule-00000000000000a1", expires_at: "2026-10-25T12:00:00.000Z",
      reason: "live value drifted from approved a1b2c3d4e5f6 with no valid copy (none in the vault) and production answering (2 probes of its names ok in run-probe), so rule rule-00000000000000a1 holds it until 2026-10-25T12:00:00.000Z",
    });
    expect(decide(input({ rule: rule({ hold_max_hours: 4 }) })).expires_at).toBe("2026-10-24T16:00:00.000Z");
  });

  it("no valid copy and production unknown (no probe run in the pass, or none of its names probed): ESCALATE, no expiry, the reason naming why production is unknown", () => {
    const none = decide(input({ probes: NONE }));
    expect(none).toEqual({
      verb: "ESCALATE", decided_by: "policy", rule_id: "rule-00000000000000a1", expires_at: null,
      reason: `live value drifted from approved a1b2c3d4e5f6 with no valid copy (none in the vault) and ${NO_PROBE_RUN}, so production is unknown and rule rule-00000000000000a1 sends it to a technician`,
    });
    const elsewhere = decide(input({ probes: ELSEWHERE, copies: [copy({ result: "fail" })] }));
    expect([elsewhere.verb, elsewhere.expires_at]).toEqual(["ESCALATE", null]);
    expect(elsewhere.reason).toBe("live value drifted from approved a1b2c3d4e5f6 with no valid copy (1 copy in the vault, latest validation fail) and no probe in run-probe targets a name it serves, so production is unknown and rule rule-00000000000000a1 sends it to a technician");
    // an object that serves no name is unknown too, whatever fails elsewhere
    expect(decide(input({ probes: FAILING, serves: [] })).verb).toBe("ESCALATE");
    // the on_no_copy term is for production affected; unknown escalates under each of them
    for (const on_no_copy of ["investigate_ticket", "ticket", "adopt"] as const) expect(decide(input({ rule: rule({ on_no_copy }), probes: NONE })).verb).toBe("ESCALATE");
    // a valid copy still rolls back with production unknown
    expect(decide(input({ probes: NONE, copies: [copy()] })).verb).toBe("ROLLBACK");
  });

  it("on_drift investigate (lock 0): FIX when production is affected, ESCALATE when it answers or is unknown", () => {
    const r = rule({ lock: 0, on_drift: "investigate" });
    const fix = decide(input({ rule: r, probes: FAILING }));
    expect([fix.verb, fix.expires_at]).toEqual(["FIX", null]);
    expect(fix.reason).toBe(`live value drifted from approved a1b2c3d4e5f6 with production affected (1 failing probe in run-probe: http ${NAME}), so rule rule-00000000000000a1 investigates and fixes where allowed`);
    expect(decide(input({ rule: r, probes: ANSWERING })).verb).toBe("ESCALATE");
    const unknown = decide(input({ rule: r, probes: NONE }));
    expect([unknown.verb, unknown.reason]).toEqual(["ESCALATE", `live value drifted from approved a1b2c3d4e5f6 with ${NO_PROBE_RUN}, so rule rule-00000000000000a1 sends it to a technician`]);
  });

  it("on_drift hold (lock 0): HOLD with the expiry; on_drift adopt: ADOPT", () => {
    const hold = decide(input({ rule: rule({ lock: 0, on_drift: "hold", hold_max_hours: 72 }) }));
    expect(hold).toEqual({ verb: "HOLD", decided_by: "policy", rule_id: "rule-00000000000000a1", expires_at: "2026-10-27T12:00:00.000Z", reason: "live value drifted from approved a1b2c3d4e5f6; rule rule-00000000000000a1 holds it until 2026-10-27T12:00:00.000Z" });
    const adopt = decide(input({ rule: rule({ lock: 0, on_drift: "adopt", criticality: "low", hold_max_hours: 0 }) }));
    expect(adopt).toEqual({ verb: "ADOPT", decided_by: "policy", rule_id: "rule-00000000000000a1", expires_at: null, reason: "live value drifted from approved a1b2c3d4e5f6; rule rule-00000000000000a1 (low) adopts the live value" });
  });
});

describe("decide: every other class under a rule", () => {
  const other = (over: Partial<DecideInput>) => input({ finding: { class: "proxied_without_real_ip" }, approved: null, ...over });

  it("adopt -> ADOPT; hold -> HOLD with the expiry", () => {
    expect(decide(other({ rule: rule({ lock: 0, on_drift: "adopt", criticality: "low", hold_max_hours: 0 }) })))
      .toEqual({ verb: "ADOPT", decided_by: "policy", rule_id: "rule-00000000000000a1", expires_at: null, reason: "rule rule-00000000000000a1 (low) adopts this proxied_without_real_ip finding" });
    expect(decide(other({ rule: rule({ lock: 0, on_drift: "hold", criticality: "high", hold_max_hours: 72 }) })))
      .toEqual({ verb: "HOLD", decided_by: "policy", rule_id: "rule-00000000000000a1", expires_at: "2026-10-27T12:00:00.000Z", reason: "rule rule-00000000000000a1 (high) holds this proxied_without_real_ip finding until 2026-10-27T12:00:00.000Z" });
  });

  it("investigate -> FIX when production is affected, else ESCALATE", () => {
    const r = rule({ lock: 0, on_drift: "investigate" });
    expect(decide(other({ rule: r, probes: FAILING }))).toMatchObject({ verb: "FIX", expires_at: null, reason: `rule rule-00000000000000a1 investigates this proxied_without_real_ip finding with production affected (1 failing probe in run-probe: http ${NAME}) and fixes where allowed` });
    expect(decide(other({ rule: r, probes: ANSWERING }))).toMatchObject({ verb: "ESCALATE", reason: "rule rule-00000000000000a1 investigates this proxied_without_real_ip finding with production answering (2 probes of its names ok in run-probe), so it goes to a technician" });
    expect(decide(other({ rule: r, probes: NONE })).verb).toBe("ESCALATE");
  });

  it("rollback (a locked rule too) -> HOLD with the expiry: the rule restores a value, the finding concerns a relation between settings; a copy in the input and production unknown change nothing", () => {
    const d = decide(other({ rule: rule({ hold_max_hours: 4 }), copies: [copy()] }));
    expect(d).toEqual({
      verb: "HOLD", decided_by: "policy", rule_id: "rule-00000000000000a1", expires_at: "2026-10-24T16:00:00.000Z",
      reason: "rule rule-00000000000000a1 restores a setting to its approved value; this proxied_without_real_ip finding concerns the setting's relation to another setting while its own value stands, so it is held until 2026-10-24T16:00:00.000Z",
    });
    expect(decide(other({ rule: rule({ hold_max_hours: 4 }), probes: NONE }))).toEqual(d);
    expect(decide(input({ finding: { class: "changed_since_backup" }, approved: null })).reason).toBe("rule rule-00000000000000a1 restores a setting to its approved value; this changed_since_backup finding concerns the setting's relation to another setting while its own value stands, so it is held until 2026-10-25T12:00:00.000Z");
    // a drift_vs_approved finding that arrives with no approval is read the same way
    expect(decide(input({ approved: null, copies: [copy()] })).verb).toBe("HOLD");
  });
});

describe("the Decider's helpers", () => {
  it("holdUntil adds whole hours to decided_at, in the millisecond form", () => {
    expect(holdUntil("2026-10-24T12:00:00.000Z", 24)).toBe("2026-10-25T12:00:00.000Z");
    expect(holdUntil("2026-10-31T23:30:00.000Z", 1)).toBe("2026-11-01T00:30:00.000Z");
  });

  it("gapCount counts the non-blank lines of missing_dependencies", () => {
    expect(gapCount({ missing_dependencies: "" })).toBe(0);
    expect(gapCount({ missing_dependencies: "/a\n\n/b\n" })).toBe(2);
  });

  it("production: affected on any failing probe of a served name, answering when they all pass, unknown otherwise", () => {
    expect(production(FAILING, [NAME])).toEqual({ state: "affected", run_id: "run-probe", failing: [`http ${NAME}`] });
    expect(production(ANSWERING, [NAME])).toEqual({ state: "answering", run_id: "run-probe", ok: 2 });
    expect(production(ELSEWHERE, [NAME])).toEqual({ state: "unknown", run_id: "run-probe", why: "no probe in run-probe targets a name it serves" });
    expect(production(NONE, [NAME])).toEqual({ state: "unknown", run_id: null, why: NO_PROBE_RUN });
    expect(productionText(production(NONE, [NAME]))).toBe("no probe run in this pass");
    const many: ProbeView = { run_id: "run-probe", rows: ["a", "b", "c", "d"].map((n) => ({ kind: "http", target: `${n}.example.invalid`, status: "fail" })) };
    expect(productionText(production(many, ["a", "b", "c", "d"].map((n) => `${n}.example.invalid`)))).toBe("production affected (4 failing probes in run-probe: http a.example.invalid, http b.example.invalid, http c.example.invalid, ...)");
  });
});
