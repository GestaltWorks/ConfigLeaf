// The export deny-list probe: the one check a file the operator publishes passes before it is written. Every label of
// the deny-list (REDACT_WORDS and EXPORT_DENY_WORDS, src/redactor.ts countLabels) is counted over each text the export
// writes; one match anywhere refuses the whole export, nothing written, and the refusal names the count and the text,
// never the label. scripts/examples.ts (the owner's report and the executive report), scripts/executive.ts and
// scripts/document.ts probe through it, so the gate behaves the same in each: probeExport throws ExportRefused, and the
// script's own catch prints it and exits 1.

import { config } from "../config.ts";
import { countLabels } from "../redactor.ts";

/** An export the deny-list probe refused: nothing of it was written. */
export class ExportRefused extends Error {
  override name = "ExportRefused";
}

/** The operator's deny-list: REDACT_WORDS and EXPORT_DENY_WORDS, each label once. */
export const exportLabels = (): string[] => [...new Set([...config.redactWords, ...config.exportDenyWords])];

/**
 * Probe each text an export writes, in order, before any of it is written. Throws ExportRefused on the first that holds
 * a label ("deny-list probe: 2 of 49 configured label(s) appear in the report; nothing written"); returns the number of
 * labels probed, for the line the script prints.
 */
export function probeExport(texts: readonly (readonly [what: string, text: string])[], labels: readonly string[] = exportLabels()): number {
  for (const [what, text] of texts) {
    const hits = Object.keys(countLabels(text, labels)).length;
    if (hits) throw new ExportRefused(`deny-list probe: ${hits} of ${labels.length} configured label(s) appear in the ${what}; nothing written`);
  }
  return labels.length;
}
