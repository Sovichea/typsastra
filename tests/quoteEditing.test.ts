import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { doubleQuoteAction, insertContextualDoubleQuote } from "../src/editor/quoteEditing";

function applyQuote(doc: string, anchor: number, head = anchor): EditorState {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.range(anchor, head),
  });
  const view = {
    get state() { return state; },
    dispatch(transaction: ReturnType<EditorState["update"]>) { state = transaction.state; },
  } as unknown as EditorView;
  expect(insertContextualDoubleQuote(view)).toBe(true);
  return state;
}

describe("contextual double-quote editing", () => {
  test("pairs a quote only in an empty boundary context", () => {
    expect(doubleQuoteAction("", "")).toBe("pair");
    expect(doubleQuoteAction("Start: ", "")).toBe("pair");
    const state = applyQuote("Start: ", 7);
    expect(state.doc.toString()).toBe('Start: ""');
    expect(state.selection.main.head).toBe(8);
  });

  test("inserts only an opener before existing Latin or Khmer text", () => {
    expect(doubleQuoteAction("", "Hello")).toBe("single");
    expect(doubleQuoteAction("", "\u1781\u17D2\u1798\u17C2\u179A")).toBe("single");
    expect(applyQuote("Hello", 0).doc.toString()).toBe('"Hello');
    expect(applyQuote("\u1781\u17D2\u1798\u17C2\u179A", 0).doc.toString()).toBe('"\u1781\u17D2\u1798\u17C2\u179A');
  });

  test("inserts only a closer after existing text", () => {
    expect(doubleQuoteAction("Hello", " ")).toBe("single");
    expect(applyQuote("Hello world", 5).doc.toString()).toBe('Hello" world');
  });

  test("wraps selected text and keeps the complete result selected", () => {
    const state = applyQuote("Hello Khmer", 0, 5);
    expect(state.doc.toString()).toBe('"Hello" Khmer');
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('"Hello"');
  });

  test("replaces content brackets when changing the selected delimiter to quotes", () => {
    const state = applyQuote("[Hello] Khmer", 0, 7);
    expect(state.doc.toString()).toBe('"Hello" Khmer');
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('"Hello"');
  });

  test("removes quotes when the selected text already uses quotes", () => {
    const state = applyQuote('"Hello" Khmer', 0, 7);
    expect(state.doc.toString()).toBe("Hello Khmer");
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("Hello");
  });

  test("replaces parentheses and braces when changing the selected delimiter to quotes", () => {
    expect(applyQuote("(Hello)", 0, 7).doc.toString()).toBe('"Hello"');
    expect(applyQuote("{Hello}", 0, 7).doc.toString()).toBe('"Hello"');
  });

  test("preserves a backward selection when replacing content brackets", () => {
    const state = applyQuote("[Hello] Khmer", 7, 0);
    expect(state.doc.toString()).toBe('"Hello" Khmer');
    expect(state.selection.main.anchor).toBe(7);
    expect(state.selection.main.head).toBe(0);
  });

  test("steps over a closer only when the caret is inside a string", () => {
    // Inside a string the following quote closes it, so the caret moves over it
    // and the pair is left untouched.
    expect(doubleQuoteAction('"abc', '"')).toBe("skip");
    expect(applyQuote('""', 1).doc.toString()).toBe('""');
    expect(applyQuote('"abc"', 4).doc.toString()).toBe('"abc"');
    expect(applyQuote("\\", 1).doc.toString()).toBe('\\"');
  });

  test("inserts the quote before an opener instead of swallowing it", () => {
    // The caret is not inside a string yet, so the following quote is an
    // opener and the typed quote must still be inserted.
    expect(doubleQuoteAction("", '"')).toBe("pair");
    const state = applyQuote('test"', 4);
    expect(state.doc.toString()).toBe('test""');
    expect(state.selection.main.head).toBe(5);

    // The same holds when an escaped quote precedes the caret.
    expect(doubleQuoteAction('\\"', '"')).not.toBe("skip");
  });

  test("never leaves three quotes next to an existing one", () => {
    // A quote already before the caret closes the string instead of opening a
    // nested pair.
    expect(doubleQuoteAction('"', "")).toBe("single");
    expect(doubleQuoteAction('font: "', "")).toBe("single");
    const closed = applyQuote('"', 1);
    expect(closed.doc.toString()).toBe('""');
    expect(closed.selection.main.head).toBe(2);

    // A quote already after the caret is stepped over, leaving the pair.
    const skipped = applyQuote('""', 1);
    expect(skipped.doc.toString()).toBe('""');
    expect(skipped.selection.main.head).toBe(2);
  });
});
