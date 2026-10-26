// The Scout guard: the injection check of Meterless Scout Intent (engines/scout-intent/docs/risk-and-policy.md, example
// prompt-injection-block) as a local, deterministic function. The spec ships no reference implementation; this is
// ConfigLeaf's, and its rules are listed here and nowhere else.
//
// ConfigLeaf hands Nemotron configuration text and ticket text (src/agents/judge.ts, src/actions/investigate.ts,
// src/eval/models.ts). A comment in a config file, a DNS record's content or a ticket body can carry a directive meant
// for the model. decide() reads text before a model does and answers with a risk level and a reason.
//
// Contract:
//   - Levels: allow, review, block. Block withholds the text from the prompt (src/guard/withhold.ts does that). Review
//     lets the text through and leaves a trace line and a record line. Allow leaves nothing. A false block costs the
//     model one snippet and nothing else, because rules decide every verb; the rules below favour that side.
//   - Classes, as the spec names them: instruction_override, role_confusion, data_exfiltration and tool_abuse on the
//     raw input; context_poisoning (a directive hidden in a comment, a markup comment or invisible characters of a
//     retrieved document) and indirect_injection (a directive in untrusted file, ticket or record content) on
//     retrieved snippets.
//   - Two passes, in the spec's order. decide() scans the raw input first; a block there is final and the snippet pass
//     is not made, because a poisoned snippet must not disable the check that catches it. The snippet pass scans each
//     retrieved snippet on its own, so one decision names which snippets to withhold.
//   - The rules (RULES) are anchored on directives addressed to a model: an imperative over instructions, a role
//     assumption, a request for the prompt or for secrets, a destructive or privileged tool instruction, text addressed
//     to an AI, a steer of the verdict. Text is read as NFKC with invisible and bidirectional control characters removed
//     and Unicode tag characters decoded, so fullwidth letters and zero-width splits read as the plain phrase.
//   - A decision carries a class, a rule id, a line number and a fixed sentence per hit. It never carries the text it
//     read, so a trace line or a record line built from it leaks nothing.
//   - Limits: the rules are patterns. A paraphrase that avoids every pattern passes, and so does a homoglyph spelling
//     or a payload encoded in base64. The guard narrows what a model reads; the Decider, the receipts gate, the
//     execution contract (src/guard/contract.ts) and --apply bound what a model can cause.
//
// Measured 26 Oct 2026 on the 32-example Meterless v1 smoke set (vendor/scout-intent, src/guard/smoke.ts): 7 of 7
// injection examples blocked, 0 of 25 benign examples blocked. The set is a smoke test of 32 examples.

export const GUARD_VERSION = "scout-guard-1";

export type Level = "allow" | "review" | "block";
export const THREAT_CLASSES = ["instruction_override", "role_confusion", "data_exfiltration", "tool_abuse", "context_poisoning", "indirect_injection"] as const;
export type ThreatClass = (typeof THREAT_CLASSES)[number];
export type Pass = "input" | "snippet";

/** A retrieved text and where it came from: a label the code chose ("finding.summary", "evidence row 2 value_redacted"), never data. */
export interface Snippet { source: string; text: string }

export interface GuardInput {
  /** The raw input: the text the prompt is about, as a string (source "input") or with the label of where it came from. */
  prompt?: string | Snippet;
  /** Retrieved snippets, scanned one by one before they enter a prompt. */
  snippets?: readonly Snippet[];
}

export interface Hit {
  pass: Pass;
  source: string;
  class: ThreatClass;
  rule: string;
  level: "review" | "block";
  /** The 1-based line of the first match in the text. */
  line: number;
  /** The rule's fixed sentence. */
  reason: string;
}

/** The decision over one text. */
export interface TextDecision {
  pass: Pass;
  source: string;
  level: Level;
  reason: string;
  /** Block hits first, then review, each group in line order. */
  hits: Hit[];
}

export interface Decision {
  level: Level;
  reason: string;
  /** The class of the first hit of the worst decision; null for allow. */
  class: ThreatClass | null;
  /** Where that hit sits; null for allow. */
  location: { source: string; line: number } | null;
  /** The raw-input pass; null when no prompt was given. */
  input: TextDecision | null;
  /** The snippet pass, in the order given; empty when the input pass blocked. */
  snippets: TextDecision[];
}

interface Rule {
  id: string;
  cls: ThreatClass;
  level: "review" | "block";
  reason: string;
  re: RegExp;
}

const SECRET = String.raw`(?:system\s+prompts?|hidden\s+prompts?|initial\s+prompts?|developer\s+(?:message|prompt)s?|your\s+(?:instructions|rules|prompt|configuration)|api[\s_-]?keys?|secrets?|credentials?|passwords?|passphrases?|tokens?|private\s+keys?|ssh\s+keys?|env(?:ironment)?\s+(?:var(?:iable)?s?|files?)|pii|ssns?|session\s+cookies?)`;
const SENSITIVE = String.raw`(?:${SECRET}|customer\s+(?:data|records?|details|lists?|pii)|crm\s+records?|user\s+(?:data|records?)|all\s+(?:customer|user|client|account)s?)`;
const AI = String.raw`(?:ai|a\.i\.|llm|language\s+model|ai\s+model|ai\s+assistant|assistant|chat\s?bot|nemotron|gpt|claude|ai\s+agent|llm\s+agent|automated\s+reviewer)`;

const rule = (id: string, cls: ThreatClass, level: "review" | "block", reason: string, re: RegExp): Rule => ({ id, cls, level, reason, re });

export const RULES: readonly Rule[] = [
  // instruction_override
  rule("override.ignore_instructions", "instruction_override", "block", "tells the model to ignore its instructions or rules",
    /\b(?:ignore|disregard|forget)(?:\s+(?:all|any|the|your|these|those|my|every|of|previous|prior|above|earlier|preceding|former|original|system|safety)){0,5}\s+(?:instructions?|prompts?|rules?|directives?|directions?|guidelines?|polic(?:y|ies)|constraints?|restrictions?|safeguards?|guardrails?|programming)\b/i),
  rule("override.ignore_previous", "instruction_override", "block", "tells the model to ignore what came before",
    /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|everything)\s+)*(?:previous|prior|above|earlier|preceding)\b/i),
  rule("override.disregard_user", "instruction_override", "block", "tells the model to disregard the person it serves",
    /\bdisregard\s+(?:the\s+)?(?:user|operator|technician|human|developer)\b(?![-_\w])/i),
  rule("override.new_instructions", "instruction_override", "block", "announces replacement instructions",
    /\b(?:new|updated|revised|real|actual|true|additional|secret)\s+(?:system\s+)?(?:instructions?|directives?|orders?)\s*:/i),
  rule("override.from_now_on", "instruction_override", "block", "sets standing orders for the model from now on",
    /\bfrom\s+now\s+on\b[^.]{0,30}\byou\b/i),
  rule("override.refuse_prior", "instruction_override", "block", "tells the model to stop following its rules",
    /\b(?:do\s+not|don't|never|stop)\s+(?:follow|following|obey|obeying|listen\s+to|comply\s+with|adhere\s+to)\s+(?:(?:the|your|any|those|these)\s+)*(?:previous|prior|above|earlier|original|system|safety|instructions?|rules?)\b/i),
  rule("override.supersede", "instruction_override", "block", "claims to override or replace the model's instructions",
    /\b(?:these|this|the\s+following)\s+(?:instructions?|rules?|directives?)\s+(?:override|supersede|replace|take\s+precedence\s+over)\b|\boverrid(?:e|es|ing)\s+(?:(?:all|any|the|your)\s+)*(?:previous|prior|system|safety|earlier)\s+(?:instructions?|rules?|prompts?|polic(?:y|ies))\b/i),

  // role_confusion
  rule("role.control_token", "role_confusion", "block", "carries a chat-template control token",
    /\[\/?INST\]|<<\/?SYS>>|<\|(?:im_start|im_end|system|assistant|user|endoftext|eot_id|begin_of_text|start_header_id)\|>/i),
  rule("role.close_tag", "role_confusion", "block", "closes a chat role tag to break out of the text",
    /<\/(?:system|assistant|user|human|developer)\s*>/i),
  rule("role.chat_tag", "role_confusion", "review", "carries a chat role tag",
    /<(?:system|assistant|developer|human|user)\s*>/i),
  rule("role.assume", "role_confusion", "block", "tells the model it is now a privileged or unrestricted role",
    /\byou\s+are\s+(?:now|no\s+longer|hereby)\b[^.]{0,40}\b(?:root|admin|administrator|developer|dba|database\s+admin\w*|unrestricted|unfiltered|jailbroken|dan|god|superuser|the\s+system|without\s+(?:any\s+)?(?:restrictions?|limits?|rules?|filters?))\b/i),
  rule("role.assume_mode", "role_confusion", "block", "tells the model it is in an unrestricted mode",
    /\byou\s+are\s+(?:now\s+)?in\s+(?:dev|developer|admin|root|sudo|unrestricted|unfiltered|god)\s+mode\b/i),
  rule("role.you_are_admin", "role_confusion", "review", "tells the model it is an administrator",
    /\byou\s+are\s+(?:an?\s+|the\s+)?(?:database\s+admin\w*|system\s+admin\w*|root(?:\s+user)?|superuser|dba)\b/i),
  rule("role.pretend", "role_confusion", "block", "asks the model to pretend to be the system or an administrator",
    /\b(?:pretend|imagine|behave|roleplay|role-play)\b[^.]{0,20}\b(?:to\s+be|that\s+you\s+are|you\s+are|as(?:\s+if)?|like)\b[^.]{0,15}\b(?:the\s+|an?\s+)?(?:system|root|admin|administrator|developer|operator|superuser|unrestricted|jailbroken|unfiltered)\b/i),
  rule("role.act_as", "role_confusion", "block", "tells the model to act as the system or an administrator",
    /\byou\s+(?:will\s+|must\s+|should\s+|can\s+|shall\s+)?(?:now\s+)?act\s+as\s+(?:the\s+|an?\s+)?(?:system|root|admin\w*|developer|operator|superuser|unrestricted|dan)\b/i),
  rule("role.mode", "role_confusion", "block", "names a jailbreak mode",
    /\b(?:unrestricted|unfiltered|jailbroken|god|dan)\s+mode\b|\bdo\s+anything\s+now\b/i),
  rule("role.jailbreak", "role_confusion", "review", "mentions a jailbreak",
    /\bjailbreak\w*\b/i),
  rule("role.chat_marker", "role_confusion", "review", "opens a line like a chat role",
    /(?:^|[\s>*#-])(?:SYSTEM|ASSISTANT|DEVELOPER)\s*:\s+\S/),

  // data_exfiltration
  rule("exfil.reveal_secret", "data_exfiltration", "block", "asks the model to reveal a secret, credential or its prompt",
    new RegExp(String.raw`(?<!\b(?:not|never|avoid|prevent|without)\s+)\b(?:reveal|leak|exfiltrate|disclose|divulge|steal|harvest)\b[^.]{0,60}\b${SECRET}\b`, "i")),
  rule("exfil.print_prompt", "data_exfiltration", "block", "asks the model to print its system prompt or instructions",
    /\b(?:print|show|display|repeat|reveal|output|recite|echo|tell\s+me|give\s+me)\b[^.]{0,30}\b(?:system|hidden|initial|original|developer)\s+(?:prompt|message|instructions)\b|\b(?:print|show|display|repeat|reveal|output|recite|tell\s+me)\b[^.]{0,20}\byour\s+(?:instructions|rules|prompt|guidelines)\b/i),
  rule("exfil.dump_store", "data_exfiltration", "block", "asks the model to print stored secrets or environment variables",
    /\b(?:print|show|display|dump|list|output|reveal|give\s+me|tell\s+me)\b[^.]{0,15}\b(?:all|every|stored|saved|your|my)\s+(?:\w+\s+){0,2}(?:env(?:ironment)?\s+var(?:iable)?s?|secrets?|api[\s_-]?keys?|credentials|passwords|private\s+keys?)\b|\b(?:print|dump|reveal|leak|exfiltrate)\s+(?:the\s+)?(?:env(?:ironment)?\s+var(?:iable)?s?|secrets)\b/i),
  rule("exfil.send_external", "data_exfiltration", "block", "asks the model to send sensitive data to an outside address",
    new RegExp(String.raw`\b(?:send|email|mail|forward|post|upload|transmit|exfiltrate|leak|copy)\b[^.]{0,80}\b${SENSITIVE}\b[^.]{0,60}\bto\s+(?:https?:\/\/|ftp:\/\/|[^\s@]+@[\w.-]+\.\w+|an?\s+external|the\s+attacker)`, "i")),
  rule("exfil.secret_path", "data_exfiltration", "block", "asks the model to read a credential file",
    /\b(?:cat|type|less|more|head|tail|print|read|show|dump|send|upload|curl|scp|copy|exfiltrate)\b[^.]{0,20}(?:\/etc\/(?:passwd|shadow|sudoers)\b|\.ssh\/id_\w+|\.aws\/credentials|\/proc\/self\/environ|(?:^|\s)\.env\b)/i),

  // tool_abuse
  rule("tool.shell_tool", "tool_abuse", "block", "tells the model to use a shell",
    /\b(?:use|run|invoke|call|launch|open|start|execute)\s+(?:the\s+|a\s+|your\s+)?(?:shell|bash|powershell|terminal|command[\s-]line|cmd)\s+(?:tool|command|session|access|prompt|plugin)\b/i),
  rule("tool.destructive", "tool_abuse", "block", "tells the model to destroy data",
    /\bdrop\s+the\s+(?:\w+\s+){0,2}(?:table|database|schema)\b|\b(?:wipe|erase|destroy)\s+(?:the\s+|all\s+|every\s+)+(?:\w+\s+){0,2}(?:database|tables|accounts|customer\s+records)\b|\brm\s+-[a-z]*[rf][a-z]*\s+(?:--no-preserve-root\s+)?\/(?:\s|$|\*)/i),
  rule("tool.privilege_grant", "tool_abuse", "block", "asks the model to grant someone administrative access",
    /\b(?:grant|give|assign|elevate)\s+(?:me|myself|us|this\s+user|the\s+user|that\s+account)\s+(?:\w+\s+){0,2}(?:admin\w*|root|superuser|sudo|full\s+access|elevated|owner|access)\b/i),
  rule("tool.pipe_shell", "tool_abuse", "review", "pipes a download into a shell",
    /\b(?:curl|wget)\b[^|]{0,100}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i),
  rule("tool.admin_ref", "tool_abuse", "review", "points at an administrative tool",
    /\b(?:use|call|invoke|open|launch|via|through)\s+(?:the\s+)?(?:internal[\s_]admin[\s_]panel|admin[\s_]panel|admin[\s_]console|\w+_admin_\w+)\b/i),

  // indirect_injection and context_poisoning: text addressed to a model, or steering this agent's verdict
  rule("indirect.addressed_to_model", "indirect_injection", "block", "is addressed to an AI model",
    new RegExp(String.raw`\b(?:attention|note|notice|message|instructions?|important|warning)\b[^.]{0,15}\b(?:to|for)\s+(?:the\s+|an?\s+|any\s+)?${AI}\b`, "i")),
  rule("indirect.if_you_are_ai", "indirect_injection", "block", "addresses a reader that is an AI",
    new RegExp(String.raw`\b(?:if|when|since)\s+you\s+are\s+(?:an?\s+|the\s+)?${AI}\b|\bas\s+an?\s+(?:ai|llm|language\s+model|ai\s+assistant)\b[^.]{0,40}\byou\s+(?:must|should|will|shall|are\s+to)\b`, "i")),
  rule("indirect.ai_reading", "indirect_injection", "block", "addresses AI systems that process this text",
    new RegExp(String.raw`\b${AI}s?\b[^.]{0,20}\b(?:reading|processing|parsing|summari[sz]ing|analy[sz]ing|reviewing|scanning)\b[^.]{0,15}\b(?:this|these)\b`, "i")),
  rule("indirect.steer_verdict", "indirect_injection", "block", "tells the reader how to classify the finding",
    /\b(?:mark|label|classify|treat|record|report|conclude|decide|declare|rule|answer|respond|reply|output|return|set)\b[^.]{0,30}\b(?:this|the)\s+(?:\w+\s+){0,2}(?:finding|drift|change|claim|alert|ticket|incident|disposition)\b[^.]{0,20}\b(?:as|is|to\s+be|to)\s+(?:\w+\s+){0,1}(?:adopt|adopted|approved|benign|safe|expected|authori[sz]ed|resolved|legitimate|false\s+positive|stands?)\b|\b(?:respond|answer|reply|output|return|choose|select|pick)\s+(?:only\s+)?(?:with\s+)?["']?(?:ADOPT|ADOPTED|APPROVED)\b|\b(?:answer|respond|reply|conclude|decide|rule)\b[^.]{0,30}\b(?:claim|finding)\s+(?:stands|holds|is\s+(?:true|correct|valid))\b/i),
  rule("indirect.steer_output", "indirect_injection", "block", "carries the judge's reply schema",
    /\brefute_with_sql\b/i),
  rule("indirect.ai_label", "indirect_injection", "review", "opens a line addressed to an AI",
    /(?:^|[\s>*#-])(?:AI|LLM)(?:\s+(?:assistant|model|agent))?\s*:\s+\S/),
];

/** Invisible, zero-width and bidirectional control characters. */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, "g");
/** Unicode tag characters, the block that smuggles ASCII invisibly. */
const TAGS = /[\u{E0000}-\u{E007F}]/gu;
const ESCAPED_CONTROL = /\\u\{?(?:202[a-e]|200[b-f]|2060|206[6-9]|feff)\}?/i;

/**
 * The spans of markup and block comments (<!-- --> and slash-star), found in one pass over the text: an unterminated
 * comment runs to the end, as a parser reads it, and the next marker is searched from where the last span ended.
 */
function commentSpans(s: string): (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  let nextHtml = s.indexOf("<!--");
  let nextBlock = s.indexOf("/*");
  while (nextHtml >= 0 || nextBlock >= 0) {
    const html = nextBlock < 0 || (nextHtml >= 0 && nextHtml < nextBlock);
    const at = html ? nextHtml : nextBlock;
    const close = html ? "-->" : "*/";
    const e = s.indexOf(close, at + (html ? 4 : 2));
    const end = e < 0 ? s.length : e + close.length;
    out.push([at, end]);
    if (e < 0) break;
    if (nextHtml >= 0 && nextHtml < end) nextHtml = s.indexOf("<!--", end);
    if (nextBlock >= 0 && nextBlock < end) nextBlock = s.indexOf("/*", end);
  }
  return out;
}
const COMMENT_LINE = /^\s*(?:#|\/\/|;|--|\*|<!--|\/\*)/;

interface Prepared {
  flat: string;
  controls: boolean;
  lineAt(index: number): number;
  hiddenAt(index: number): boolean;
}

/** The text as the rules read it: NFKC, controls removed, tag characters decoded and appended, newlines as spaces. */
function prepare(text: string): Prepared {
  const controls = INVISIBLE.test(text) || /[\u{E0000}-\u{E007F}]/u.test(text);
  const tagText = [...text.matchAll(TAGS)].map((m) => m[0].codePointAt(0)! - 0xe0000).filter((c) => c >= 0x20 && c < 0x7f).map((c) => String.fromCharCode(c)).join("");
  let cleaned = text.normalize("NFKC").replace(INVISIBLE_ALL, "").replace(TAGS, "");
  const tagStart = cleaned.length + 1;
  if (tagText.trim()) cleaned += `\n${tagText}`;
  const lines = cleaned.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) { starts.push(at); at += l.length + 1; }
  const commentLine = lines.map((l) => COMMENT_LINE.test(l));
  const spans = commentSpans(cleaned);
  const lineIndex = (i: number): number => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; }
    return lo;
  };
  return {
    flat: cleaned.replace(/\n/g, " "),
    controls,
    lineAt: (i) => lineIndex(i) + 1,
    hiddenAt: (i) => i >= tagStart || commentLine[lineIndex(i)] || spans.some(([a, b]) => i >= a && i < b),
  };
}

const WORSE: Record<Level, number> = { allow: 0, review: 1, block: 2 };
const worst = (a: Level, b: Level): Level => (WORSE[b] > WORSE[a] ? b : a);

/** The class a hit carries: the rule's own on the raw input; on a retrieved snippet, context_poisoning when the text hides in a comment or in invisible characters, else indirect_injection. */
const classOf = (r: Pick<Rule, "cls">, pass: Pass, hidden: boolean): ThreatClass => (pass === "input" ? r.cls : hidden ? "context_poisoning" : "indirect_injection");

/** One text through every rule. */
export function scanText(text: string, pass: Pass, source: string): TextDecision {
  const p = prepare(text);
  const hits: Hit[] = [];
  for (const r of RULES) {
    const m = r.re.exec(p.flat);
    if (m) hits.push({ pass, source, class: classOf(r, pass, p.hiddenAt(m.index)), rule: r.id, level: r.level, line: p.lineAt(m.index), reason: r.reason });
  }
  if (p.controls) {
    hits.push({ pass, source, class: classOf({ cls: "role_confusion" }, pass, true), rule: "hidden.control_chars", level: "review", line: 1, reason: "carries invisible, zero-width or bidirectional control characters" });
  }
  const esc = ESCAPED_CONTROL.exec(p.flat);
  if (esc) hits.push({ pass, source, class: classOf({ cls: "role_confusion" }, pass, true), rule: "hidden.escaped_control", level: "review", line: p.lineAt(esc.index), reason: "spells out an escaped control character" });
  hits.sort((a, b) => WORSE[b.level] - WORSE[a.level] || a.line - b.line);
  const first = hits[0];
  return {
    pass, source, hits,
    level: first ? first.level : "allow",
    reason: first ? `${first.class}: ${first.reason}` : "no injection pattern found",
  };
}

const where = (d: TextDecision): string => `${d.source}${d.hits[0] ? ` line ${d.hits[0].line}` : ""}`;

function finish(input: TextDecision | null, snippets: TextDecision[]): Decision {
  const all = [...(input ? [input] : []), ...snippets];
  const level = all.reduce<Level>((l, d) => worst(l, d.level), "allow");
  const top = all.find((d) => d.level === level && d.hits[0]);
  if (!top || level === "allow") {
    return { level: "allow", reason: `no injection pattern in ${input ? "the input" : "no input"} or in ${snippets.length} ${snippets.length === 1 ? "snippet" : "snippets"}`, class: null, location: null, input, snippets };
  }
  return { level, reason: `${level}: ${top.reason} (${where(top)})`, class: top.hits[0].class, location: { source: top.source, line: top.hits[0].line }, input, snippets };
}

/**
 * The guard over a raw input and the snippets retrieved for it. The input pass comes first and a block there is final:
 * the snippet pass is not made. Each snippet gets its own decision.
 */
export function decide(input: GuardInput): Decision {
  const p = typeof input.prompt === "string" ? { source: "input", text: input.prompt } : input.prompt;
  const first = p === undefined ? null : scanText(p.text, "input", p.source);
  if (first?.level === "block") return finish(first, []);
  return finish(first, (input.snippets ?? []).map((s) => scanText(s.text, "snippet", s.source)));
}
