import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { typstLanguage } from "../src/editor/typstLanguage";
import {
  buildTypstScaleDocument,
  TYPST_SCALE_LINE_COUNT,
} from "./typst-lezer-fixture";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function parseFully(state: EditorState): Tree {
  const tree = ensureSyntaxTree(state, state.doc.length, 30_000);
  if (!tree || tree.length !== state.doc.length) {
    throw new Error(`Parser stopped at ${tree?.length ?? 0} of ${state.doc.length} characters.`);
  }
  return tree;
}

function countErrors(tree: Tree): number {
  const cursor = tree.cursor();
  let errors = 0;
  do {
    if (cursor.type.isError) errors += 1;
  } while (cursor.next());
  return errors;
}

const doc = buildTypstScaleDocument();
const coldRuns: number[] = [];

for (let run = 0; run < 3; run += 1) {
  const state = EditorState.create({ doc, extensions: [typstLanguage] });
  const started = performance.now();
  const tree = parseFully(state);
  coldRuns.push(performance.now() - started);
  if (countErrors(tree) !== 0) throw new Error("Cold parse produced syntax errors.");
}

const baseState = EditorState.create({ doc, extensions: [typstLanguage] });
parseFully(baseState);

const incrementalRuns: number[] = [];
let state = baseState;
for (let run = 0; run < 5; run += 1) {
  const line = state.doc.line(10_000);
  const started = performance.now();
  state = state.update({
    changes: { from: line.to, insert: ` edit${run}` },
  }).state;
  const tree = parseFully(state);
  incrementalRuns.push(performance.now() - started);
  if (countErrors(tree) !== 0) throw new Error("Incremental parse produced syntax errors.");
}

const report = {
  benchmark: "typst-lezer-20k",
  lines: TYPST_SCALE_LINE_COUNT,
  chars: doc.length,
  bytes: new TextEncoder().encode(doc).length,
  coldMs: coldRuns.map(value => Number(value.toFixed(2))),
  coldMedianMs: Number(median(coldRuns).toFixed(2)),
  incrementalMs: incrementalRuns.map(value => Number(value.toFixed(2))),
  incrementalMedianMs: Number(median(incrementalRuns).toFixed(2)),
};

console.log(JSON.stringify(report, null, 2));
