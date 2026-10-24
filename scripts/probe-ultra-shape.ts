// What does Ultra actually return? Print the message object's keys and content so the JSON
// extractor is written against the real shape, not a guess.
import { Nightshift } from "../src/adapters/nightshift.ts";
import { config } from "../src/config.ts";

const ns = new Nightshift();
const r = await ns.chat({
  model: config.nightshift.modelJudge,
  messages: [{ role: "user", content: 'Reply with only this JSON and nothing else: {"ok":true,"who":"<your model family in two words>"}' }],
  maxTokens: 2048,
  agent: "probe",
});
const msg = (r.raw as any)?.choices?.[0]?.message ?? {};
console.log("message keys:", Object.keys(msg));
console.log("finish_reason:", (r.raw as any)?.choices?.[0]?.finish_reason);
console.log("tokens out:", r.tokensOut);
console.log("content:\n---\n" + (msg.content ?? "").slice(0, 1500) + "\n---");
if (msg.reasoning_content) console.log("reasoning_content (first 400):\n" + String(msg.reasoning_content).slice(0, 400));
if (msg.reasoning) console.log("reasoning (first 400):\n" + String(msg.reasoning).slice(0, 400));
console.log("extracted:", JSON.stringify(Nightshift.extractJson(msg.content ?? "")));
