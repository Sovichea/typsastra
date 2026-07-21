import { afterAll, beforeAll, describe, expect, mock, test, afterEach } from "bun:test";
import { EditorState, Text } from "@codemirror/state";
import { typstLanguage } from "../src/editor/typstLanguage";

type Invocation = { command: string; resolve: (value: unknown) => void; reject: (error: unknown) => void; args?: any };
const invocations: Invocation[] = [];
const providerCapability = (overrides: Record<string, unknown>) => ({
  schemaVersion: 1,
  id: "test",
  pattern: "[A-Za-z]+",
  displayName: "Test",
  languageTag: "en-US",
  scripts: ["Latn"],
  engine: "test",
  providerType: "dictionary-plus-tokenizer",
  version: "test-1",
  license: "MIT",
  supportLevel: "enhanced",
  stability: "stable",
  boundaryMode: "unicode-word",
  boundaryQuality: "tested",
  correctionQuality: "dictionary",
  supportsSpellcheck: true,
  supportsCorrections: true,
  supportsCompletion: true,
  supportsSegmentation: false,
  supportsCustomDictionary: true,
  hasEditingPolicy: false,
  ...overrides
});

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: any) => {
    if (command === "get_provider_capabilities") {
      return Promise.resolve([
        providerCapability({
          id: "khmer-segmenter",
          pattern: "[\\u1780-\\u17ff]+",
          displayName: "Khmer",
          languageTag: "km",
          scripts: ["Khmr"],
          engine: "khmer_segmenter",
          providerType: "deep",
          supportLevel: "deep",
          stability: "experimental",
          boundaryMode: "custom-segmenter",
          boundaryQuality: "dedicated",
          correctionQuality: "none",
          supportsCorrections: false,
          supportsSegmentation: true,
          hasEditingPolicy: true
        }),
        providerCapability({ id: "test-corrections" })
      ]);
    }
    if (command === "list_hunspell_catalog") return Promise.resolve([]);
    return new Promise((resolve, reject) => invocations.push({ command, resolve, reject, args }));
  }
}));

const elementStub = () => ({
  className: "",
  classList: { add() {}, remove() {} },
  style: {},
  replaceChildren() {},
  appendChild() {}
});

const originalDocument = globalThis.document;
beforeAll(() => {
  Object.assign(globalThis, {
    document: {
      createElement: elementStub,
      body: { appendChild() {}, style: {} },
      documentElement: { style: {} }
    },
    window: Object.assign(globalThis, { innerWidth: 1200, innerHeight: 800 })
  });
});
afterAll(() => {
  Object.assign(globalThis, { document: originalDocument });
});

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const analysis = (text: string, knownPrefix = false) => ({
  tokens: [{
    provider: "khmer-segmenter",
    sourceFromUtf16: 0,
    sourceToUtf16: text.length,
    sourceText: text,
    normalizedText: text,
    known: false,
    knownPrefix
  }],
  failures: []
});

let activeController: any = null;

async function controllerFor(text: string) {
  const state = { doc: Text.of([text]), selection: { main: { head: text.length } } };
  let replacementCount = 0;
  const visibleIssueSnapshots: unknown[][] = [];
  const editor = {
    state,
    dispatch(spec: { changes?: { from: number; to: number; insert: string } }) {
      if (!spec.changes) return;
      replacementCount++;
      const change = spec.changes;
      state.doc = Text.of([state.doc.sliceString(0, change.from) + change.insert + state.doc.sliceString(change.to)]);
    },
    focus() {},
    coordsAtPos() { return null; }
  };
  const { SpellcheckController } = await import("../src/editor/spellcheck");
  const controller = new SpellcheckController(
    () => editor as never,
    issues => visibleIssueSnapshots.push([...issues])
  );
  await controller.initialize();
  controller.setDocumentScripts([
    { script: "latin", family: "Test Latin", scale: 1, language: "en-US" },
    { script: "khmer", family: "Test Khmer", scale: 1, language: "km" },
  ]);
  controller.activateDocument("a.typ");
  activeController = controller;
  return { controller, state, visibleIssueSnapshots, get replacementCount() { return replacementCount; } };
}

async function startAnalysis(controller: { schedule(): void }): Promise<Invocation> {
  controller.schedule();
  await wait(180);
  const request = invocations.shift();
  if (!request) throw new Error("analysis request was not started");
  expect(request.command).toBe("analyze_language_ranges");
  return request;
}

describe("spellcheck request safety", () => {
  afterEach(() => {
    if (activeController) {
      activeController.clear();
      activeController = null;
    }
    invocations.length = 0;
  });

  test("treats personal dictionary entries as known", async () => {
    const fixture = await controllerFor("ខុស");
    fixture.controller.setUserDictionary(["ខុស"]);
    const request = await startAnalysis(fixture.controller);
    request.resolve(analysis("ខុស"));
    await wait(20);
    expect(fixture.controller.issues).toEqual([]);
  });

  test("discards a response invalidated immediately by an edit", async () => {
    const fixture = await controllerFor("ខុស");
    const request = await startAnalysis(fixture.controller);
    fixture.state.doc = Text.of(["ខុសទៀត"]);
    const update = {
      state: fixture.state,
      docChanged: true,
      changes: {
        mapPos: (pos: number) => pos,
        iterChanges: (callback: any) => callback(0, 0, 0, 0)
      }
    };
    fixture.controller.documentChanged(update as any);
    request.resolve(analysis("ខុស"));
    await wait(20);
    expect(fixture.controller.issues).toEqual([]);
  });

  test("keeps existing issues visible while an unrelated edit is reanalyzed", async () => {
    const fixture = await controllerFor("wrong text");
    const request = await startAnalysis(fixture.controller);
    request.resolve({
      tokens: [{
        provider: "test-corrections",
        sourceFromUtf16: 0,
        sourceToUtf16: 5,
        sourceText: "wrong",
        normalizedText: "wrong",
        known: false,
        knownPrefix: false
      }]
    });
    await wait(20);
    expect(fixture.controller.issues).toHaveLength(1);

    fixture.state.doc = Text.of(["wrong text!"]);
    fixture.state.selection.main.head = fixture.state.doc.length;
    const update = {
      state: fixture.state,
      docChanged: true,
      transactions: [],
      changes: {
        mapPos: (position: number) => position,
        iterChanges: (callback: any) => callback(10, 10, 10, 11)
      }
    };
    fixture.controller.documentChanged(update as any);

    expect(fixture.controller.issues).toHaveLength(1);
    expect(fixture.visibleIssueSnapshots.at(-1)).toHaveLength(1);
  });

  test("preserves a failed provider's issues while applying successful provider results", async () => {
    const fixture = await controllerFor("wrong ខុស");
    const first = await startAnalysis(fixture.controller);
    first.resolve({
      tokens: [{
        provider: "test-corrections",
        sourceFromUtf16: 0,
        sourceToUtf16: 5,
        sourceText: "wrong",
        normalizedText: "wrong",
        known: false,
        knownPrefix: false
      }],
      failures: []
    });
    await wait(20);
    expect(fixture.controller.issues).toHaveLength(1);

    fixture.controller.pendingRanges = [{ from: 0, to: fixture.state.doc.length }];
    const second = await startAnalysis(fixture.controller);
    second.resolve({
      tokens: [{
        provider: "khmer-segmenter",
        sourceFromUtf16: 6,
        sourceToUtf16: 9,
        sourceText: "ខុស",
        normalizedText: "ខុស",
        known: false,
        knownPrefix: false
      }],
      failures: [{
        provider: "test-corrections",
        operation: "analyze",
        sourceFromUtf16: 0,
        sourceToUtf16: 10,
        message: "provider offline"
      }]
    });
    await wait(20);

    expect(fixture.controller.issues.map((issue: any) => issue.provider).sort()).toEqual([
      "khmer-segmenter",
      "test-corrections"
    ]);
  });

  test("discards a response after tab activation", async () => {
    const fixture = await controllerFor("ខុស");
    const request = await startAnalysis(fixture.controller);
    fixture.controller.activateDocument("b.typ");
    fixture.state.doc = Text.of(["ថ្មី"]);
    request.resolve(analysis("ខុស"));
    await wait(20);
    expect(fixture.controller.issues).toEqual([]);
  });

  test("discards a response after the active tab closes", async () => {
    const fixture = await controllerFor("ខុស");
    const request = await startAnalysis(fixture.controller);
    fixture.controller.activateDocument("");
    request.resolve(analysis("ខុស"));
    await wait(20);
    expect(fixture.controller.issues).toEqual([]);
  });

  test("uses half-open ranges and rejects replacement against a changed document", async () => {
    const fixture = await controllerFor("ខុស");
    const request = await startAnalysis(fixture.controller);
    request.resolve(analysis("ខុស"));
    await wait(20);
    const issue = fixture.controller.issues[0];
    expect(fixture.controller.issueAt(issue.to)).toBeNull();
    fixture.state.doc = Text.of(["ផ្សេង"]);
    fixture.controller.replace(issue, "ត្រូវ");
    expect(fixture.replacementCount).toBe(0);
  });

  test("discards a correction response after cursor movement", async () => {
    const fixture = await controllerFor("ខុស");
    const analyzeRequest = await startAnalysis(fixture.controller);
    analyzeRequest.resolve(analysis("ខុស"));
    await wait(20);
    const issue = { ...fixture.controller.issues[0], provider: "test-corrections" };
    const suggestions = fixture.controller.suggestions(issue);
    const suggestionRequest = invocations.shift();
    if (!suggestionRequest) throw new Error("suggestion request was not started");
    expect(suggestionRequest.command).toBe("language_suggestions");
    fixture.controller.selectionChanged();
    suggestionRequest.resolve({ suggestions: ["ត្រូវ"] });
    expect(await suggestions).toEqual([]);
  });

  test("keeps Khmer corrections disabled until reliable word spans are available", async () => {
    const fixture = await controllerFor("ខុស");
    const analyzeRequest = await startAnalysis(fixture.controller);
    analyzeRequest.resolve(analysis("ខុស"));
    await wait(20);

    expect(await fixture.controller.suggestions(fixture.controller.issues[0])).toEqual([]);
    expect(invocations).toEqual([]);
  });

  test("shows a known-prefix squiggle after the cursor moves away", async () => {
    const fixture = await controllerFor("ខ្មេ");
    fixture.controller.completionStateChanged(true);
    const analyzeRequest = await startAnalysis(fixture.controller);
    analyzeRequest.resolve(analysis("ខ្មេ", true));
    await wait(20);
    expect(fixture.visibleIssueSnapshots.at(-1)).toEqual([]);

    fixture.state.selection.main.head = 0;
    fixture.controller.selectionChanged();
    await Promise.resolve();
    expect(fixture.visibleIssueSnapshots.at(-1)).toHaveLength(1);
  });

  test("shows a known-prefix squiggle when completion is dismissed", async () => {
    const fixture = await controllerFor("ខ្មេ");
    fixture.controller.completionStateChanged(true);
    const analyzeRequest = await startAnalysis(fixture.controller);
    analyzeRequest.resolve(analysis("ខ្មេ", true));
    await wait(20);
    expect(fixture.visibleIssueSnapshots.at(-1)).toEqual([]);

    fixture.controller.completionStateChanged(false);
    await Promise.resolve();
    expect(fixture.visibleIssueSnapshots.at(-1)).toHaveLength(1);
  });

  test("keeps ignored words visible as informational issues", async () => {
    const fixture = await controllerFor("ខ្មេ");
    fixture.controller.setIgnoredWords(["ខ្មេ"]);
    const analyzeRequest = await startAnalysis(fixture.controller);
    analyzeRequest.resolve(analysis("ខ្មេ"));
    await wait(20);

    expect(fixture.controller.issues[0].ignored).toBe(true);
    expect((fixture.visibleIssueSnapshots.at(-1) as any[])[0].ignored).toBe(true);
  });

  test("hides an unknown Hunspell token while typing until dismissed", async () => {
    const fixture = await controllerFor("mispell");
    fixture.controller.typingStarted("mispell".length);
    const analyzeRequest = await startAnalysis(fixture.controller);
    analyzeRequest.resolve({
      tokens: [{
        ...analysis("mispell").tokens[0],
        provider: "test-corrections",
      }],
      failures: [],
    });
    await wait(20);
    expect(fixture.visibleIssueSnapshots.at(-1)).toEqual([]);

    fixture.controller.dismissActiveTyping();
    await Promise.resolve();
    expect(fixture.visibleIssueSnapshots.at(-1)).toHaveLength(1);
  });

  test("classifies Typst prose separately from syntax and quoted paths", async () => {
    const { isTypstProseRange } = await import("../src/editor/spellcheck");
    const doc = '#let syntaxName = typo\n#include "wrong-file.typ"\nThis paragraf is visible\n#text[Content misspel]';
    const state = EditorState.create({ doc, extensions: [typstLanguage] });
    const range = (word: string) => {
      const from = doc.indexOf(word);
      return isTypstProseRange(state, from, from + word.length);
    };

    expect(range("syntaxName")).toBe(false);
    expect(range("wrong-file")).toBe(false);
    expect(range("paragraf")).toBe(true);
    expect(range("misspel")).toBe(true);
  });

  test("turns rejected native analysis into controlled state", async () => {
    const fixture = await controllerFor("ខុស");
    const request = await startAnalysis(fixture.controller);
    request.reject(new Error("offline"));
    await wait(20);
    expect(fixture.controller.issues).toEqual([]);
  });
});
