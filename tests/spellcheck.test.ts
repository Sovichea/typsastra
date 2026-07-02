import { afterAll, beforeAll, describe, expect, mock, test, afterEach } from "bun:test";
import { Text } from "@codemirror/state";

type Invocation = { command: string; resolve: (value: unknown) => void; reject: (error: unknown) => void; args?: any };
const invocations: Invocation[] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: any) => {
    if (command === "get_provider_capabilities") {
      return Promise.resolve([{ id: "khmer-segmenter", pattern: "[\\u1780-\\u17ff]+" }]);
    }
    return new Promise((resolve, reject) => invocations.push({ command, resolve, reject, args }));
  }
}));

const popup = () => ({
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
      createElement: popup,
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
const analysis = (text: string) => ({
  tokens: [{
    provider: "khmer-segmenter",
    sourceFromUtf16: 0,
    sourceToUtf16: text.length,
    sourceText: text,
    normalizedText: text,
    known: false,
    knownPrefix: false
  }]
});

let activeController: any = null;

async function controllerFor(text: string) {
  const state = { doc: Text.of([text]), selection: { main: { head: text.length } } };
  let replacementCount = 0;
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
  const controller = new SpellcheckController(() => editor as never);
  await controller.initialize();
  controller.activateDocument("a.typ");
  activeController = controller;
  return { controller, state, get replacementCount() { return replacementCount; } };
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

  test("discards a popup response after cursor movement", async () => {
    const fixture = await controllerFor("ខុស");
    const analyzeRequest = await startAnalysis(fixture.controller);
    analyzeRequest.resolve(analysis("ខុស"));
    await wait(20);
    const suggestions = fixture.controller.suggestions(fixture.controller.issues[0]);
    const popupRequest = invocations.shift();
    if (!popupRequest) throw new Error("suggestion request was not started");
    expect(popupRequest.command).toBe("language_suggestions");
    fixture.controller.selectionChanged();
    popupRequest.resolve({ suggestions: ["ត្រូវ"] });
    expect(await suggestions).toEqual([]);
  });

  test("turns rejected native analysis into controlled state", async () => {
    const fixture = await controllerFor("ខុស");
    const request = await startAnalysis(fixture.controller);
    request.reject(new Error("offline"));
    await wait(20);
    expect(fixture.controller.issues).toEqual([]);
  });
});
