// The eval runner's records: what one configuration run says about one item, the run as a whole, the planted
// claims, and the counts eval/PROTOCOL.md "What is counted" names. Data only; src/eval/run.ts fills them,
// src/eval/measures.ts counts them, src/eval/report.ts renders them.

import type { JudgeStatus } from "../agents/judge.ts";
import type { DecidedBy } from "../data/rows.ts";
import type { Verb } from "../pipeline.ts";
import type { LabelValue } from "./items.ts";
import type { CallRecord } from "./models.ts";
import type { ConfigSpec, ModelTier } from "./protocol.ts";

export type SetName = "dev" | "heldout";

/** One finding of an item under one configuration run. */
export interface SubjectOutcome {
  finding_id: string;
  class: string;
  summary: string;
  /** The verb this configuration gives the finding; null when it is filed not judged. */
  verb: Verb | null;
  reason: string;
  /** Who decided the verb (the exception, a policy rule, or the default over the configuration's checks) and under which rule; null when not judged or for C4. */
  decided_by: DecidedBy | null;
  rule_id: string | null;
  not_judged: string | null;
  checks: { template: string; holds: boolean; rows: number }[];
  rejected: string[];
  /** The model's selection, for a configuration whose checks a model chooses. */
  selection: { selected: number; valid: number; invalid: string[]; other: string | null } | null;
  /** Valid selected checks that ran as selected (no guard or engine refusal, no gated audit template). */
  ran_unmodified: number;
  early_stops: number;
  /** The judge: its verdict, or why its call was withheld; null for a configuration with no judge. */
  judge:
    | { withheld: string }
    | {
      status: JudgeStatus; reason: string; sql: string | null; rows: number | null; receipt_id: string | null; served_model: string | null; attempts: number | null; cache_status: string | null;
      /** The ladder's route that answered and its attempts on it; null when no route answered. */
      route: string | null; route_attempts: number | null;
    }
    | null;
}

export interface ItemOutcome {
  id: string;
  class: string;
  set: SetName;
  label: LabelValue;
  kind: "pass" | "history" | "other";
  /** How the item met its findings; null when it is not raised. */
  matched: { via: "facts" | "refs" | "history"; findings: string[] } | null;
  not_raised: string | null;
  /** The item's verdict: its findings' most severe verb; null when not raised or not judged. */
  verdict: Verb | null;
  reading: "yes" | "no" | null;
  /** The verdict's reading against the label; null for an unsure label or no verdict. */
  agree: boolean | null;
  not_judged: string | null;
  subjects: SubjectOutcome[];
  /** The C4 baseline's own answer for the item. */
  direct: { verb: Verb; reason: string } | null;
  strikes: number;
}

export interface Counts {
  items: number;
  scored: number;
  not_raised: number;
  with_verdict: number;
  not_judged: number;
  agree: number;
  disagree: number;
  unsure: number;
  /** Labelled no and read yes (ESCALATE or FIX), and the items labelled no. */
  false_positives: number;
  labelled_no: number;
  checks_selected: number;
  checks_valid: number;
  checks_invalid: number;
  checks_ran_unmodified: number;
  checks_run: number;
  falsifier_ran: number;
  falsifier_struck: number;
  agreed_strikes: number;
  wrong_strikes: number;
  early_stops: number;
  judge_withheld: number;
  findings_assessed: number;
  findings_with_disposition: number;
  calls: number;
  cache_hits: number;
  substitutions: number;
  /** Calls whose receipt says Nightshift's memory injected stored answers in front of them (hmem.injected above 0). */
  memory_injected: number;
  tokens_in: number;
  tokens_out: number;
  latency_ms_median: number | null;
}

export interface RunResult {
  config: ConfigSpec;
  run: number;
  started_at: string;
  finished_at: string;
  /** false when any call's verified receipt names a tier other than the one requested, or any call's receipt shows injected memory. */
  valid: boolean;
  invalid_reason: string | null;
  items: ItemOutcome[];
  calls: CallRecord[];
  counts: Counts;
  /** C0: what this run's pass raised and decided, every finding (findings, verbs and reasons). */
  pass: { id: string; class: string; verb: Verb; reason: string }[] | null;
}

export interface PlantedOutcome {
  config: string;
  run: number;
  judge_tier: ModelTier;
  id: string;
  kind: string;
  status: JudgeStatus;
  struck: boolean;
  reason: string;
  sql: string | null;
  rows: number | null;
  receipt_id: string | null;
  served_model: string | null;
  /** The ladder's route that answered; null when no route answered. */
  route: string | null;
  cache_status: string | null;
  calls: CallRecord[];
}
