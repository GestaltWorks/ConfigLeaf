// The export deny-list probe: the one check a file the operator publishes passes before it is written. Every label of
// the deny-list (REDACT_WORDS and EXPORT_DENY_WORDS) is counted over each text the export writes; one match anywhere
// refuses the whole export, nothing written, and the refusal names the count and the text, never the label.
// scripts/examples.ts (the owner's report and the executive report), scripts/executive.ts and scripts/document.ts
// probe through it, so the gate behaves the same in each: probeExport throws ExportRefused, and the script's own catch
// prints it and exits 1.
//
// What counts as a match is src/redactor.ts countLabels's rule: the label, trimmed, standing on its own (no letter or
// digit on either side), in any case. A label inside a longer word ("acme" in "acmecorp") is not one, by that rule.
// The exports are HTML and markdown, so each label is also looked for as the files would carry it: HTML-escaped
// (& < > " ' as entities, the way the reports escape every string) and URL-encoded (as a link would carry it). A
// blank label is no label: it is dropped, never matched against everything or nothing.

import { config } from "../config.ts";
import { countLabels } from "../redactor.ts";

/** An export the deny-list probe refused: nothing of it was written. */
export class ExportRefused extends Error {
  override name = "ExportRefused";
}

/** The operator's deny-list: REDACT_WORDS and EXPORT_DENY_WORDS, trimmed, blank ones dropped, each label once. */
export const exportLabels = (words: readonly string[] = [...config.redactWords, ...config.exportDenyWords]): string[] =>
  [...new Set(words.map((w) => (typeof w === "string" ? w.trim() : "")).filter((w) => w.length > 0))];

const ENTITY: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** A label as the exports could carry it: as given, HTML-escaped, and URL-encoded; each form once. */
export function labelForms(label: string): string[] {
  return [...new Set([label, label.replace(/[&<>"']/g, (c) => ENTITY[c]), encodeURIComponent(label)])];
}

/** How many of `labels` appear in `text` in any of their forms (labelForms), by countLabels's rule. */
export function labelsIn(text: string, labels: readonly string[]): number {
  return labels.filter((l) => Object.keys(countLabels(text, labelForms(l))).length > 0).length;
}

/**
 * Probe each text an export writes, in order, before any of it is written. Throws ExportRefused on the first that holds
 * a label ("deny-list probe: 2 of 31 configured label(s) appear in the report; nothing written"); returns the number of
 * labels probed, for the line the script prints.
 */
export function probeExport(texts: readonly (readonly [what: string, text: string])[], labels: readonly string[] = exportLabels()): number {
  const list = exportLabels(labels);
  for (const [what, text] of texts) {
    const hits = labelsIn(text, list);
    if (hits) throw new ExportRefused(`deny-list probe: ${hits} of ${list.length} configured label(s) appear in the ${what}; nothing written`);
  }
  return list.length;
}
