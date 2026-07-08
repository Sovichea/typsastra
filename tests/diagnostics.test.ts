import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { looksLikeStalePrefixDiagnostic } from "../src/editor/diagnostics";
import { duplicatesStructuredDiagnostic } from "../src/diagnostics/logConsoleController";

describe("editor diagnostics", () => {
  test("rejects stale LSP diagnostics for a boolean literal prefix", () => {
    const doc = Text.of(['#set par(hyphenate: true)']);
    const from = '#set par(hyphenate: '.length;
    const to = from + 'tr'.length;

    expect(looksLikeStalePrefixDiagnostic(doc, from, to, '"tr" is an invalid argument'))
      .toBe(true);
  });

  test("rejects stale diagnostics left behind after accepting a completion", () => {
    const doc = Text.of(['#set par(hyphenate: false)']);
    const from = '#set par(hyphenate: '.length;
    const to = from + 'fa'.length;

    expect(looksLikeStalePrefixDiagnostic(doc, from, to, '`fa` is an invalid argument'))
      .toBe(true);
  });

  test("keeps diagnostics that still cover the current source text", () => {
    const doc = Text.of(['#set par(hyphenate: fals)']);
    const from = '#set par(hyphenate: '.length;
    const to = from + 'fals'.length;

    expect(looksLikeStalePrefixDiagnostic(doc, from, to, '"fals" is an invalid argument'))
      .toBe(false);
  });

  test("keeps diagnostics that do not quote the ranged source", () => {
    const doc = Text.of(['#set par(hyphenate: false)']);
    const from = '#set par(hyphenate: '.length;
    const to = from + 'fa'.length;

    expect(looksLikeStalePrefixDiagnostic(doc, from, to, 'expected a boolean value'))
      .toBe(false);
  });

  test("never treats an invalid import path as a stale typing prefix", () => {
    const doc = Text.of(['#import "missing-file.typ"']);
    const from = '#import "'.length;
    const to = from + 'missing'.length;

    expect(looksLikeStalePrefixDiagnostic(doc, from, to, 'file not found: missing-file.typ'))
      .toBe(false);
  });
});

describe("diagnostic log deduplication", () => {
  test("hides a plain LSP log when the structured diagnostic has the same message", () => {
    const message = "file not found (searched at C:\\project\\missing.typ)";
    expect(duplicatesStructuredDiagnostic(
      { message: `\u001b[31m${message.replace("searched at", "searched\u200B  at")}\u001b[0m\n` },
      [{ message }]
    )).toBe(true);
  });

  test("keeps distinct and developer log messages", () => {
    const diagnostics = [{ message: "file not found" }];
    expect(duplicatesStructuredDiagnostic(
      { channel: "lsp", message: "compiler restarted" },
      diagnostics
    )).toBe(false);
    expect(duplicatesStructuredDiagnostic(
      { channel: "dev", message: "file not found" },
      diagnostics
    )).toBe(false);
  });
});
