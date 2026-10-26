// A stub Nightshift for the investigation: chatWithFallback answers a Lightning request with a check selection built
// from the finding in the prompt (two catalogue checks and one unknown template) and an Ultra request with one
// refuting SELECT, and files a receipt per call, signed with the test key (test/fixtures/signed-receipt.ts), under
// the app id and the request id of that call; its finder names TEST_KEY, so the receipt gate and custody pass. `ultraServedBy: "lightning"` files
// the Ultra call's receipt under a Lightning model: a substitution the gate refuses.
import type { ChatMessage, ChatResult, SignedReceipt } from "../../../src/adapters/nightshift.ts";
import type { JudgeModel } from "../../../src/agents/judge.ts";
import { tierOf, type ReceiptFinder } from "../../../src/gate.ts";
import { TEST_KEY, ULTRA_MODEL, signed } from "../signed-receipt.ts";

export const LIGHTNING_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
type ChatOpts = Parameters<JudgeModel["chatWithFallback"]>[0];

export class FakeModel implements JudgeModel {
  readonly calls: ChatOpts[] = [];
  private readonly filed = new Map<string, SignedReceipt>();
  readonly receipts: ReceiptFinder = { keys: [TEST_KEY], find: async (id) => this.filed.get(id) ?? null };
  constructor(private readonly opts: { ultraServedBy?: "ultra" | "lightning" } = {}) {}

  async chatWithFallback(o: ChatOpts): Promise<ChatResult & { hop: number }> {
    const n = this.calls.push(o);
    const lightning = tierOf(o.models[0]) === "lightning";
    const served = lightning || this.opts.ultraServedBy === "lightning" ? LIGHTNING_MODEL : ULTRA_MODEL;
    const receiptId = `rcpt_test_${n}`;
    const requestId = `chatcmpl-test-${n}`;
    this.filed.set(receiptId, signed({
      receipt_id: receiptId, request_id: requestId, app: o.appId, app_policy: { app: o.appId }, routing: { winner: served },
      phases: [{ model: served, phase: "final_synthesis" }], winning_route: { model: served }, cache: { status: "miss" }, requested_mode: "meterless/auto", status: "ok",
    }));
    const content = lightning ? selection(o.messages) : JSON.stringify({ refute_with_sql: "SELECT approval_id FROM {{t:approved_setting}} WHERE approval_id = 'appr-none'", rationale: "a row would show an approval the claim says is absent" });
    return { content, modelRequested: o.models[0], modelRouted: served, receiptId, requestId, tokensIn: 100, tokensOut: 20, latencyMs: 5, retries: 0, raw: {}, hop: 0 };
  }
}

/** Two checks bound from the finding in the user message, and one unknown template the validator drops. */
function selection(messages: readonly ChatMessage[]): string {
  const user = messages.at(-1)!.content;
  const f = JSON.parse(user.match(/Finding \(redacted\):\n([\s\S]*?)\n\nSelect the checks\./)![1]) as Record<string, string | null>;
  const second = f.host
    ? { template: "setting_matches_approved", params: { tenant_id: f.tenant_id, host: f.host, object_id: f.object_id, setting_path: f.setting_path, run_id: f.run_id }, why: "is the live value the approved one" }
    : { template: "actor_attributed", params: { tenant_id: f.tenant_id, resource_id: f.resource_id, since: f.since, until: f.until }, why: "who changed the record" };
  return JSON.stringify({ checks: [{ template: "run_complete", params: { run_id: f.run_id }, why: "the run is whole" }, second, { template: "no_such_template", params: {}, why: "x" }] });
}
