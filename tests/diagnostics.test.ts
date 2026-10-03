import { describe, expect, test } from "bun:test";
import { EditorState, Text } from "@codemirror/state";
import { looksLikeStalePrefixDiagnostic } from "../src/editor/diagnostics";
import {
  countedLogTotals,
  duplicatesStructuredDiagnostic,
  persistentLogsAfterManualClear,
  spellcheckConsoleGroupKey
} from "../src/diagnostics/logConsoleController";
import { DiagnosticsController } from "../src/diagnostics/diagnosticsController";
import type { EditorView } from "@codemirror/view";
import type { LogConsoleController } from "../src/diagnostics/logConsoleController";

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

describe("diagnostic navigation", () => {
  test("reveals same-file locations after the selection transaction settles", async () => {
    const path = String.raw`C:\project\main.typ`;
    let state = EditorState.create({ doc: "first\nsecond\nthird" });
    const dispatches: unknown[] = [];
    let focused = false;
    const editor = {
      get state() { return state; },
      dispatch(spec: Parameters<EditorView["dispatch"]>[0]) {
        dispatches.push(spec);
        state = state.update(spec).state;
      },
      focus() { focused = true; },
    } as unknown as EditorView;
    const controller = new DiagnosticsController({} as LogConsoleController, {
      editor: () => editor,
      client: () => undefined,
      activeFilePath: () => path,
      pathKey: value => value.toLowerCase(),
      mapToOriginalPath: value => value,
      isRenderCachePath: () => false,
      previewImported: () => false,
      previewStandalone: () => false,
      latestDocumentVersion: () => 1,
      hasPendingSync: () => false,
      spellcheck: () => ({}) as never,
      recordFirstDiagnostics: () => {},
      logDeveloper: () => {},
      acceptedDiagnosticsChanged: () => {},
      openDiagnosticFile: async () => {},
      activeTabContentLoaded: () => true,
      editorPositionFromSourceLocation: () => 13,
    });

    await controller.navigateToLogEntry({
      kind: "error",
      message: "problem",
      filePath: path,
      line: 3,
      column: 1,
    });

    expect(dispatches).toHaveLength(2);
    expect(state.selection.main.head).toBe(13);
    expect(focused).toBe(true);
  });
});

describe("private render mirror diagnostics", () => {
  test("accepts an empty mirror publication to clear a corrected workspace error", async () => {
    const originalPath = String.raw`C:\project\lib.typ`;
    const accepted: unknown[] = [];
    const loggedDiagnostics: unknown[] = [];
    let editorDispatches = 0;
    const editor = {
      dispatch() {
        editorDispatches += 1;
      },
    } as unknown as EditorView;
    const logConsole = {
      setDiagnostics(path: string, diagnostics: unknown[]) {
        loggedDiagnostics.push({ path, diagnostics });
      },
    } as unknown as LogConsoleController;
    const controller = new DiagnosticsController(logConsole, {
      editor: () => editor,
      client: () => undefined,
      activeFilePath: () => originalPath,
      pathKey: path => path.toLowerCase(),
      mapToOriginalPath: () => originalPath,
      isRenderCachePath: path => path.includes(".typsastra"),
      previewImported: () => true,
      previewStandalone: () => false,
      latestDocumentVersion: () => 1,
      hasPendingSync: () => false,
      spellcheck: () => ({}) as never,
      recordFirstDiagnostics: () => {},
      logDeveloper: () => {},
      acceptedDiagnosticsChanged: diagnostics => accepted.push(diagnostics),
      openDiagnosticFile: async () => {},
      activeTabContentLoaded: () => true,
      editorPositionFromSourceLocation: () => 0,
    });

    await controller.handleLspDiagnostics(
      "file:///C:/project/.typsastra/cache/render/lib.typ",
      [],
    );

    expect(editorDispatches).toBe(1);
    expect(loggedDiagnostics).toEqual([{ path: originalPath, diagnostics: [] }]);
    expect(accepted).toEqual([[]]);
  });
});

describe("spellcheck console grouping", () => {
  test("preserves exact source spelling and case", () => {
    const keys = ["Tyst", "typst", "TyPSt"].map(word => spellcheckConsoleGroupKey(word, false));
    expect(new Set(keys).size).toBe(3);
    expect(spellcheckConsoleGroupKey("typst", true)).not.toBe(spellcheckConsoleGroupKey("typst", false));
  });
});

describe("counted console logs", () => {
  test("contribute to problem, severity, and LSP totals only when explicitly counted", () => {
    expect(countedLogTotals([
      { kind: "error", channel: "lsp", counted: true },
      { kind: "error", channel: "lsp", counted: true },
      { kind: "warning", channel: "images", counted: true },
      { kind: "error", channel: "dev" },
      { kind: "info", channel: "lsp" }
    ])).toEqual({
      errors: 2,
      warnings: 1,
      lsp: 2,
      all: 3
    });
  });

  test("survive manual clearing until their owning subsystem resolves them", () => {
    const compilerFailure = { kind: "error" as const, counted: true, message: "compile failed" };
    const relatedCallSite = {
      kind: "error" as const,
      counted: false,
      persistent: true,
      message: "while calling wrapper",
    };
    const developerLog = { kind: "info" as const, message: "render started" };

    expect(persistentLogsAfterManualClear([compilerFailure, relatedCallSite, developerLog]))
      .toEqual([compilerFailure, relatedCallSite]);
  });

  test("clears counted Dev entries so the Clear button empties the Dev tab", () => {
    // Developer entries are always counted so they render, but they must not
    // survive a manual clear or the button appears to do nothing.
    const devEntry = {
      kind: "info" as const,
      channel: "dev" as const,
      counted: true,
      message: "render started",
    };
    const countedLsp = {
      kind: "error" as const,
      channel: "lsp" as const,
      counted: true,
      message: "compile failed",
    };

    expect(persistentLogsAfterManualClear([devEntry, countedLsp])).toEqual([countedLsp]);
  });

  test("marks developer entries counted so the Dev tab can render them", async () => {
    const source = await Bun.file(
      new URL("../src/diagnostics/developerLogController.ts", import.meta.url),
    ).text();

    // Without `counted` the console filters a developer entry out of every
    // rendered list, so enabling the category would still show nothing.
    const append = source.slice(
      source.indexOf("appendDeveloper("),
      source.indexOf("appendSpellcheckDebug("),
    );
    expect(append).toContain('channel: "dev"');
    expect(append).toContain("counted: true");
  });
});
