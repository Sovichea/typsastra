import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { readFileSync } from "node:fs";
import { runScopeHandlers, type EditorView, type KeyBinding } from "@codemirror/view";
import { configuredEditorKeymap } from "../src/editor/extensions";
import {
  ApplicationShortcutSequence,
  applicationShortcutForEvent,
  captureShortcut,
  canonicalShortcut,
  normalizeShortcutOverrides,
  shortcutCollision,
  shortcutDefinitions,
  shortcutFor,
  shortcutFromEvent,
  shortcutStrokes,
  validShortcutForCommand,
} from "../src/platform/shortcutRegistry";

function key(code: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    code, key: code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    isComposing: false, getModifierState: () => false,
    ...modifiers,
  } as KeyboardEvent;
}

describe("programmable shortcuts", () => {
  test("registers stable unique commands from the built-in and application keymaps", () => {
    const ids = shortcutDefinitions.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of ["Application", "Editor", "Editing", "History", "Search", "Folding", "Completion"]) {
      expect(shortcutDefinitions.some(entry => entry.group === group)).toBe(true);
    }
  });

  test("matches the physical key across layouts and preserves macOS Ctrl versus Cmd", () => {
    const event = key("KeyF", { ctrlKey: true, shiftKey: true });
    expect(shortcutFromEvent(event, false)).toBe("Mod-Shift-F");
    expect(canonicalShortcut("Shift-Mod-F", false)).toBe(canonicalShortcut("Mod-Shift-F", false));
    expect(canonicalShortcut("Ctrl-F", true)).not.toBe(canonicalShortcut("Mod-F", true));
    expect(applicationShortcutForEvent(event, {}, false)).toBe("action-format-document");
    expect(applicationShortcutForEvent(key("Comma", { ctrlKey: true }), {}, false)).toBe("action-open-settings");
  });

  test("rejects collisions with other commands and preserves the previous binding", () => {
    expect(shortcutCollision("editor.unindent", "Mod-S", {}, false)?.id).toBe("action-save-file");
    expect(normalizeShortcutOverrides({ "editor.unindent": "Mod-S" })).toEqual({});
    const settings = normalizeShortcutOverrides({ "editor.unindent": "Alt-Tab" });
    expect(shortcutFor("editor.unindent", settings, false)).toBe("Alt-Tab");
    expect(shortcutFor("editor.unindent", {}, false)).toBe("Shift-Tab");
    expect(applicationShortcutForEvent(key("KeyS", { ctrlKey: true }), {}, false)).toBe("action-save-file");
  });

  test("does not treat deliberate built-in popup overlaps as user collisions", () => {
    for (const mac of [false, true]) {
      for (const entry of shortcutDefinitions) {
        const original = shortcutFor(entry.id, {}, mac);
        if (original) expect(shortcutCollision(entry.id, original, {}, mac)).toBeNull();
      }
    }
    expect(shortcutCollision("editor.unindent", "Mod-F", {}, false)?.group).toBe("Search");
  });

  test("ignores IME composition and AltGraph when recording shortcuts", () => {
    expect(shortcutFromEvent(key("KeyA", { isComposing: true }), false)).toBeNull();
    expect(shortcutFromEvent(key("KeyA", { getModifierState: name => name === "AltGraph" }), false)).toBeNull();
  });

  test("waits for a full combination, then rejects collisions or accepts a free key", () => {
    expect(captureShortcut("editor.unindent", key("ShiftLeft", { key: "Shift", shiftKey: true }), {}, false)).toEqual({ kind: "waiting" });
    expect(captureShortcut("editor.unindent", key("KeyA", { key: "a", isComposing: true }), {}, false)).toEqual({ kind: "waiting" });
    expect(captureShortcut("editor.unindent", key("KeyA", { key: "a" }), {}, false)).toEqual({ kind: "invalid", reason: "combination" });
    expect(captureShortcut("action-save-file", key("Tab"), {}, false)).toEqual({ kind: "invalid", reason: "application" });
    const conflict = captureShortcut("editor.unindent", key("KeyS", { ctrlKey: true }), {}, false);
    expect(conflict.kind).toBe("conflict");
    if (conflict.kind === "conflict") expect(conflict.command.id).toBe("action-save-file");
    expect(captureShortcut("editor.unindent", key("F9", { altKey: true }), {}, false)).toEqual({ kind: "accepted", key: "Alt-F9" });
    const macConflict = captureShortcut("editor.unindent", key("KeyH", { metaKey: true }), {}, true);
    expect(macConflict.kind === "conflict" && macConflict.platform).toBe("macOS");
  });

  test("records from a modal and leaves Tab available for capture rather than focus traversal", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../src/settingsController.ts", import.meta.url), "utf8");
    const focus = readFileSync(new URL("../src/ui/modalFocus.ts", import.meta.url), "utf8");
    expect(html).toContain('id="shortcut-capture-dialog"');
    expect(html).toContain('data-shortcut-recorder=""');
    expect(html).toContain('id="shortcut-capture-chord"');
    expect(html).toContain('aria-modal="true"');
    expect(settings).toContain('binding.addEventListener("click", () => void this.openShortcutRecorder(entry, binding))');
    expect(settings).toContain('captureShortcut(capture.entry.id, event, this.settings.shortcuts');
    expect(settings).toContain('this.closeShortcutRecorder();');
    expect(focus).toContain('dialog.hasAttribute("data-shortcut-recorder")');
  });

  test("accepts Ctrl+K,O and displays a two-stroke editor command without an old binding", () => {
    expect(shortcutStrokes("Ctrl+K,O")).toEqual(["Ctrl-K", "O"]);
    expect(canonicalShortcut("Ctrl+K,O", false)).toBe(canonicalShortcut("Mod-K O", false));
    expect(shortcutStrokes("Mod-,")).toEqual(["Mod-,"]);
    expect(shortcutStrokes("Mod-, O")).toEqual(["Mod-,", "O"]);
    expect(shortcutFor("editor.unindent", normalizeShortcutOverrides({ "editor.unindent": "Mod-K O" }), false)).toBe("Mod-K O");
    expect(shortcutFromEvent(key("KeyO", { key: "o" }), false, true)).toBe("O");
    expect(shortcutFromEvent(key("KeyO", { key: "o" }), false)).toBeNull();
    expect(captureShortcut("editor.unindent", key("KeyO", { key: "o" }), {}, false, "Mod-K"))
      .toEqual({ kind: "accepted", key: "Mod-K O" });
    const configured = configuredEditorKeymap({ "editor.unindent": "Mod-K O" }, false) as { value: KeyBinding[] };
    expect(configured.value.some(binding => binding.key === "Mod-k o")).toBe(true);
    expect(configured.value.some(binding => binding.key === "Shift-Tab")).toBe(false);
  });

  test("CodeMirror consumes the prefix then unindents on the second key", () => {
    let state = EditorState.create({
      doc: "  #let value = 1",
      extensions: [indentUnit.of("  "), configuredEditorKeymap({ "editor.unindent": "Mod-K O" }, false)],
    });
    const view = {
      get state() { return state; },
      dispatch(...specs: Parameters<EditorView["dispatch"]>) { state = state.update(...specs).state; },
    } as EditorView;
    const first = { ...key("KeyK", { key: "k", ctrlKey: true }), keyCode: 75, preventDefault() {} };
    const second = { ...key("KeyO", { key: "o" }), keyCode: 79, preventDefault() {} };
    expect(runScopeHandlers(view, first, "editor")).toBe(true);
    expect(state.doc.toString()).toBe("  #let value = 1");
    expect(runScopeHandlers(view, second, "editor")).toBe(true);
    expect(state.doc.toString()).toBe("#let value = 1");
  });

  test("rejects one-key commands that would shadow chord prefixes in either direction", () => {
    expect(shortcutCollision("editor.unindent", "Mod-S O", {}, false)?.id).toBe("action-save-file");
    const bindings = { "action-open-folder": "Mod-K O" };
    expect(shortcutCollision("editor.unindent", "Mod-K", bindings, false)?.id).toBe("action-open-folder");
    expect(normalizeShortcutOverrides({ "action-open-folder": "Mod-S O" })).toEqual({});
    expect(normalizeShortcutOverrides({ "action-open-folder": "K O" })).toEqual({});
  });

  test("executes application chords in order, times out, and cancels a wrong second key", () => {
    const settings = { "action-open-folder": "Mod-K O" };
    const sequence = new ApplicationShortcutSequence();
    const first = key("KeyK", { key: "k", ctrlKey: true });
    const second = key("KeyO", { key: "o" });
    expect(sequence.handle(first, settings, false, 1)).toEqual({ kind: "pending" });
    expect(sequence.handle(second, settings, false, 2)).toEqual({ kind: "matched", id: "action-open-folder" });
    expect(sequence.handle(second, settings, false, 3)).toEqual({ kind: "none" });
    expect(sequence.handle(first, settings, false, 10)).toEqual({ kind: "pending" });
    expect(sequence.handle(second, settings, false, 4010)).toEqual({ kind: "none" });
    expect(sequence.handle(first, settings, false, 5000)).toEqual({ kind: "pending" });
    expect(sequence.handle(key("KeyP", { key: "p" }), settings, false, 5001)).toEqual({ kind: "cancelled" });
    expect(sequence.handle(first, settings, false, 6000, () => false)).toEqual({ kind: "none" });
  });

  test("never captures ordinary or uppercase typing as a command", () => {
    expect(shortcutFromEvent(key("KeyA"), false)).toBeNull();
    expect(shortcutFromEvent(key("KeyA", { shiftKey: true }), false)).toBeNull();
    expect(shortcutFromEvent(key("Slash"), false)).toBeNull();
    expect(shortcutFromEvent(key("KeyA", { ctrlKey: true }), false)).toBe("Mod-A");
    expect(validShortcutForCommand("action-save-file", "Tab")).toBe(false);
    expect(validShortcutForCommand("action-save-file", "F9")).toBe(true);
  });

  test("does not offer platform-owned Undo and Redo as misleading remappable entries", () => {
    expect(shortcutDefinitions.some(entry => entry.id === "editor.history.0" || entry.id === "editor.history.1")).toBe(false);
    expect(shortcutCollision("editor.unindent", "Mod-Z", {}, false)?.id).toBe("system.undo");
    expect(shortcutCollision("editor.unindent", "Mod-Shift-Z", {}, true)?.id).toBe("system.redo");
  });

  test("replaces Shift+Tab live with a programmable unindent command", () => {
    const configured = configuredEditorKeymap({ "editor.unindent": "Alt-F9" }, false) as { value: KeyBinding[] };
    expect(configured.value.some(binding => binding.key === "Shift-Tab")).toBe(false);
    const unindent = configured.value.find(binding => binding.key === "Alt-F9")?.run;
    expect(unindent).toBeDefined();
    let state = EditorState.create({
      doc: "#let first = 1\n  #let second = 2",
      extensions: [indentUnit.of("  ")],
    });
    state = state.update({ selection: { anchor: state.doc.line(2).from + 3 } }).state;
    const view = {
      get state() { return state; },
      dispatch(...specs: Parameters<EditorView["dispatch"]>) {
        state = state.update(...specs).state;
      },
    } as EditorView;
    expect(unindent!(view)).toBe(true);
    expect(state.doc.line(2).text).toBe("#let second = 2");
    expect(unindent!(view)).toBe(true);
  });
});
