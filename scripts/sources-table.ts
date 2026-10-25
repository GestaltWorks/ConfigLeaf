// npm run sources [-- --usl]
//
// Prints the body of "Where each answer comes from" (src/document/render.ts sourcesMarkdown): for each finding class
// the pass raises, its question, the tables its detector SQL and its default checks name, and the source each table
// comes from. The README carries this output under that heading, and test/document.test.ts holds the two equal.
// With --usl it prints the body of "The semantic layer" (src/zetaris/setup.ts uslMarkdown): each drift_usl entity, the
// DRIFT tables its activation SELECT reads, its keys and its DQ rule with the rule's expression, which the README
// carries under that heading, held equal by the same test file. Runs no query and writes nothing; exit 0.

import { sourcesMarkdown } from "../src/document/render.ts";
import { uslMarkdown } from "../src/zetaris/setup.ts";

process.stdout.write(process.argv.slice(2).includes("--usl") ? uslMarkdown() : sourcesMarkdown());
