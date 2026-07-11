import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Text } from "@codemirror/state";
import { expandSpellcheckRange } from "../src/editor/spellcheck";
import { PERFORMANCE_BUDGETS } from "../src/performance/diagnostics";

const root = process.cwd();
const output = join(root, "artifacts", "performance");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const fixtures = ["01-page", "30-pages", "100-pages"];
const compile: Record<string, number> = {};
const warmup = Bun.spawn([
  "typst", "compile",
  join(root, "benchmarks", "fixtures", "01-page.typ"),
  join(output, "warmup.pdf")
], { stdout: "ignore", stderr: "inherit" });
if (await warmup.exited !== 0) throw new Error("Typst warmup failed.");
await rm(join(output, "warmup.pdf"), { force: true });
for (const fixture of fixtures) {
  const startedAt = performance.now();
  const child = Bun.spawn([
    "typst", "compile",
    join(root, "benchmarks", "fixtures", `${fixture}.typ`),
    join(output, `${fixture}.pdf`)
  ], { stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Typst failed to compile ${fixture}.`);
  compile[fixture] = performance.now() - startedAt;
}

const paragraph = "Technical writing ភាសាខ្មែរ with mixed scripts and repeatable content.\n";
const largeSource = paragraph.repeat(Math.ceil(100_000 / paragraph.length)).slice(0, 100_000);
await writeFile(join(output, "100000-characters.typ"), largeSource);
const doc = Text.of(largeSource.split("\n"));
const incrementalStartedAt = performance.now();
let maximumSubmittedRange = 0;
for (let index = 0; index < 1_000; index += 1) {
  const position = (index * 97) % Math.max(1, doc.length - 1);
  const range = expandSpellcheckRange(doc, position, position + 1, [/[A-Za-z]/u, /[\u1780-\u17ff]/u]);
  maximumSubmittedRange = Math.max(maximumSubmittedRange, range.to - range.from);
}
const repeatedEditsMs = performance.now() - incrementalStartedAt;

const report = {
  schemaVersion: 1,
  platform: process.platform,
  generatedAt: new Date().toISOString(),
  budgets: PERFORMANCE_BUDGETS,
  compileMs: compile,
  incrementalSpellcheck: {
    documentUtf16: doc.length,
    edits: 1_000,
    totalMs: repeatedEditsMs,
    maximumSubmittedUtf16: maximumSubmittedRange
  }
};
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (doc.length < 100_000) throw new Error("Large-source fixture is too small.");
if (maximumSubmittedRange >= doc.length) throw new Error("Incremental spellcheck resent the full document.");
