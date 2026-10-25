// npm run sources
//
// Prints the body of "Where each answer comes from" (src/document/render.ts sourcesMarkdown): for each finding class
// the pass raises, its question, the tables its detector SQL and its default checks name, and the source each table
// comes from. The README carries this output under that heading, and test/document.test.ts holds the two equal.
// Runs no query and writes nothing; exit 0.

import { sourcesMarkdown } from "../src/document/render.ts";

process.stdout.write(sourcesMarkdown());
