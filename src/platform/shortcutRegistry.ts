import type { KeyBinding } from "@codemirror/view";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { foldKeymap } from "@codemirror/language";
import { completionKeymap } from "@codemirror/autocomplete";
import { buildNativeMenuSpec } from "./nativeAppMenuSpec";

/** Shortcuts are per-command preferences, separate from any future modal editor keymap. */
export type ShortcutOverrides = Record<string, string>;
export type ShortcutDefinition = {
  id: string;
  label: string;
  group: "Application" | "Editor" | "Editing" | "History" | "Search" | "Folding" | "Completion" | "System";
  defaultKey: string;
  macKey?: string;
  binding?: KeyBinding;
};

const editorOwned: ShortcutDefinition[] = [
  { id: "editor.comment", label: "Toggle line comment", group: "Editor", defaultKey: "Mod-/" },
  { id: "editor.backspace", label: "Delete previous grapheme", group: "Editor", defaultKey: "Backspace" },
  { id: "editor.delete", label: "Delete next grapheme", group: "Editor", defaultKey: "Delete" },
  { id: "editor.left", label: "Move left by grapheme", group: "Editor", defaultKey: "ArrowLeft" },
  { id: "editor.right", label: "Move right by grapheme", group: "Editor", defaultKey: "ArrowRight" },
  { id: "editor.selectLeft", label: "Select left by grapheme", group: "Editor", defaultKey: "Shift-ArrowLeft" },
  { id: "editor.selectRight", label: "Select right by grapheme", group: "Editor", defaultKey: "Shift-ArrowRight" },
  { id: "editor.unindent", label: "Unindent", group: "Editor", defaultKey: "Shift-Tab" },
  { id: "editor.tab", label: "Indent / insert tab", group: "Editor", defaultKey: "Tab" },
  { id: "editor.argumentNewline", label: "Newline inside function arguments", group: "Editor", defaultKey: "Ctrl-Enter" },
  { id: "editor.acceptCompletion", label: "Accept completion", group: "Completion", defaultKey: "Tab" },
  { id: "editor.completionEnter", label: "Accept completion with Enter", group: "Completion", defaultKey: "Enter" },
  { id: "editor.startCompletion", label: "Start completion", group: "Completion", defaultKey: "Ctrl-Space" },
  { id: "editor.completionDown", label: "Next completion", group: "Completion", defaultKey: "ArrowDown" },
  { id: "editor.completionUp", label: "Previous completion", group: "Completion", defaultKey: "ArrowUp" },
  { id: "editor.completionPageDown", label: "Next completion page", group: "Completion", defaultKey: "PageDown" },
  { id: "editor.completionPageUp", label: "Previous completion page", group: "Completion", defaultKey: "PageUp" },
];

const ownedDefaultKeys = new Set(["Mod-/", "Backspace", "Delete", "ArrowLeft", "ArrowRight"]);

// These labels and the position-based IDs do not depend on function.name, which
// minifiers and upstream CodeMirror releases can change between app builds.
const upstreamLabels: Record<string, readonly string[]> = {
  Editing: [
    "Move by syntax left", "Move by syntax right", "Move line up", "Copy line up",
    "Move line down", "Copy line down", "Add cursor above", "Add cursor below",
    "Simplify selection", "Insert blank line", "Select line", "Select parent syntax",
    "Unindent selection", "Indent selection", "Indent selection to syntax",
    "Delete line", "Jump to matching bracket", "Toggle comment",
    "Move to line start", "Toggle Tab focus mode", "Move character left", "Move group left",
    "Move to line start", "Move character right", "Move group right", "Move to line end",
    "Move line up", "Move to document start", "Move up a page", "Move line down",
    "Move to document end", "Move down a page", "Move up a page", "Move down a page",
    "Move to line start", "Move to document start", "Move to line end", "Move to document end",
    "Insert newline", "Select all", "Delete backward", "Delete forward", "Delete previous word",
    "Delete next word", "Delete to line start", "Delete to line end", "Move character left",
    "Move character right", "Move line up", "Move line down", "Move to line start", "Move to line end",
    "Delete forward", "Delete backward", "Delete to line end", "Delete previous word",
    "Split line", "Transpose characters", "Move down a page",
  ],
  History: ["Undo", "Redo", "Redo on Linux", "Undo selection", "Redo selection"],
  Search: ["Find", "Find next (F3)", "Find next", "Close search", "Select all matches", "Go to line", "Select next occurrence"],
  Folding: ["Fold code", "Unfold code", "Fold all", "Unfold all"],
  Completion: ["Start completion", "Start completion on macOS", "Start completion on macOS", "Close completion", "Next completion", "Previous completion", "Next completion page", "Previous completion page", "Accept completion"],
};

function imported(group: ShortcutDefinition["group"], prefix: string, bindings: readonly KeyBinding[]): ShortcutDefinition[] {
  return bindings.flatMap((binding, index) => {
    // Undo and Redo are predefined native menu items on macOS. Keep their
    // editor bindings but don't offer an override that cannot update the menu.
    if (group === "History" && index < 3) return [];
    if (group === "Editing" && binding.key && (ownedDefaultKeys.has(binding.key) || binding.key === "Mod-a")) return [];
    // The app owns Tab and the completion handler owns Ctrl+Space, arrows, and
    // Enter while the completion menu is open. Keep the remaining upstream
    // bindings in the catalogue and preserve their CodeMirror commands.
    if (group === "Completion" && ["Ctrl-Space", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Enter"].includes(binding.key ?? "")) return [];
    return [{
      id: `${prefix}.${index}`,
      label: upstreamLabels[group]?.[index] ?? `Editor command ${index + 1}`, group,
      defaultKey: binding.key ?? "",
      macKey: binding.mac,
      binding,
    }];
  });
}

const appDefinitions: ShortcutDefinition[] = buildNativeMenuSpec("Typsastra")
  .flatMap(menu => menu.nodes.flatMap(node => node.kind === "item" || node.kind === "check"
    ? node.accelerator ? [{
      id: node.id, label: node.label, group: "Application" as const,
      defaultKey: node.accelerator.replace(/CmdOrCtrl/g, "Mod").replace(/\+/g, "-"),
    }] : []
    : []));

// Non-menu shortcuts already handled by the application itself.
appDefinitions.push({ id: "app.revealPreview", label: "Reveal cursor in preview", group: "Application", defaultKey: "Alt-Enter" });
for (let index = 1; index <= 5; index += 1) {
  appDefinitions.push({ id: `app.recent.${index}`, label: `Open recent project ${index}`, group: "Application", defaultKey: `Mod-${index}` });
}

export const applicationShortcuts: readonly ShortcutDefinition[] = appDefinitions;

// Native predefined clipboard/window items are not programmable. Reserve
// their accelerators so a remapped editor command cannot silently steal them.
const systemShortcuts: ShortcutDefinition[] = [
  { id: "system.undo", label: "Undo (system)", group: "System", defaultKey: "Mod-Z" },
  { id: "system.redo", label: "Redo (system)", group: "System", defaultKey: "Mod-Y", macKey: "Mod-Shift-Z" },
  { id: "system.redoLinux", label: "Redo on Linux (system)", group: "System", defaultKey: "Ctrl-Shift-Z", macKey: "" },
  { id: "system.copy", label: "Copy (system)", group: "System", defaultKey: "Mod-C" },
  { id: "system.cut", label: "Cut (system)", group: "System", defaultKey: "Mod-X" },
  { id: "system.paste", label: "Paste (system)", group: "System", defaultKey: "Mod-V" },
  { id: "system.closeWindow", label: "Close window (system)", group: "System", defaultKey: "", macKey: "Mod-W" },
  { id: "system.hideWindow", label: "Hide application (system)", group: "System", defaultKey: "", macKey: "Mod-H" },
];

export const shortcutDefinitions: readonly ShortcutDefinition[] = [
  ...appDefinitions,
  ...systemShortcuts,
  ...editorOwned,
  ...imported("Editing", "editor.default", defaultKeymap),
  ...imported("History", "editor.history", historyKeymap),
  ...imported("Search", "editor.search", searchKeymap),
  ...imported("Folding", "editor.fold", foldKeymap),
  ...imported("Completion", "editor.completion", completionKeymap),
];

export function shortcutFor(id: string, overrides: ShortcutOverrides, mac: boolean): string {
  const entry = shortcutDefinitions.find(candidate => candidate.id === id);
  if (!entry) return "";
  return Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : mac && entry.macKey !== undefined ? entry.macKey : entry.defaultKey;
}

/** A custom shortcut differs from the shipped key on at least one platform. */
export function isCustomizedShortcut(id: string, overrides: ShortcutOverrides): boolean {
  if (!Object.prototype.hasOwnProperty.call(overrides, id)) return false;
  return [false, true].some(mac =>
    canonicalShortcut(shortcutFor(id, overrides, mac), mac)
      !== canonicalShortcut(shortcutFor(id, {}, mac), mac)
  );
}

/** The stored form uses spaces, while the UI also accepts Ctrl+K,O notation. */
export function shortcutStrokes(value: string): string[] {
  const input = value.trim().replace(/\+/g, "-");
  const separator = input.indexOf(",");
  if (separator > 0 && input[separator - 1] !== "-" && input.slice(separator + 1).trim()) {
    return [input.slice(0, separator).trim(), input.slice(separator + 1).trim()];
  }
  return input.split(/\s+/);
}

function canonicalStroke(value: string, mac: boolean): string | null {
  const parts = value.split("-");
  if (parts.length === 0 || parts.length > 5) return null;
  const rawKey = parts.pop()!;
  const key = rawKey === "`" ? "Backquote" : rawKey;
  if (!/^(?:[A-Za-z0-9]|F\d{1,2}|Arrow(?:Left|Right|Up|Down)|Page(?:Up|Down)|Home|End|Tab|Enter|Escape|Backspace|Delete|Space|Backquote|Comma|\/|\[|\]|\\|,|\.)$/.test(key)) return null;
  const modifiers = new Set<string>();
  for (const modifier of parts) {
    const resolved = modifier === "Mod" ? mac ? "Meta" : "Ctrl" : modifier === "Cmd" ? "Meta" : modifier;
    if (!["Meta", "Ctrl", "Alt", "Shift"].includes(resolved) || modifiers.has(resolved)) return null;
    modifiers.add(resolved);
  }
  return `${[...modifiers].sort().join("+")}+${key.length === 1 ? key.toUpperCase() : key}`;
}

/** Stable physical-key identity for a single key or an ordered two-key chord. */
export function canonicalShortcut(value: string, mac: boolean): string | null {
  const strokes = shortcutStrokes(value);
  if (strokes.length === 0 || strokes.length > 2) return null;
  const canonical = strokes.map(stroke => canonicalStroke(stroke, mac));
  return canonical.some(stroke => stroke === null) ? null : canonical.join(" ");
}

/** Avoid stealing text, including Shift+letter used for uppercase typing. */
export function validShortcut(value: string): boolean {
  if (!value) return false;
  if (![false, true].every(mac => canonicalShortcut(value, mac) !== null)) return false;
  const strokes = shortcutStrokes(value);
  if (strokes.length === 2 && !strokes[0].split("-").slice(0, -1).some(part => part !== "Shift")) return false;
  const parts = strokes[0].split("-");
  const key = parts.pop()!;
  const modifiers = parts.filter(part => part !== "Shift");
  return modifiers.length > 0 || !/^[A-Za-z0-9,/.[\]\\]$/.test(key);
}

export function validShortcutForCommand(id: string, value: string): boolean {
  const entry = shortcutDefinitions.find(candidate => candidate.id === id);
  if (!entry || entry.group === "System" || !validShortcut(value)) return false;
  const parts = shortcutStrokes(value)[0].split("-");
  const key = parts.pop()!;
  // App commands are document-global; don't turn Tab, Enter, Backspace or the
  // arrow keys into shortcuts that steal focus or typing from other controls.
  return entry.group !== "Application" || parts.length > 0 || /^F\d{1,2}$/.test(key);
}

export function shortcutCollision(
  id: string,
  value: string,
  overrides: ShortcutOverrides,
  mac: boolean,
): ShortcutDefinition | null {
  const target = canonicalShortcut(value, mac);
  if (!target) return null;
  const entry = shortcutDefinitions.find(candidate => candidate.id === id);
  if (!entry) return null;
  return shortcutDefinitions.find(other => {
    if (other.id === id) return false;
    const otherValue = shortcutFor(other.id, overrides, mac);
    const otherKey = canonicalShortcut(otherValue, mac);
    if (!otherKey || !(otherKey === target || otherKey.startsWith(`${target} `) || target.startsWith(`${otherKey} `))) return false;
    // Defaults from distinct keymaps can intentionally share Escape, Enter or
    // arrow keys. New assignments must not introduce another overlap.
    const baseline = (definition: ShortcutDefinition) =>
      mac && definition.macKey !== undefined ? definition.macKey : definition.defaultKey;
    if (other.group === "System") return true;
    return Object.prototype.hasOwnProperty.call(overrides, other.id)
      || target !== canonicalShortcut(baseline(entry), mac)
      || target !== canonicalShortcut(baseline(other), mac);
  }) ?? null;
}

export function normalizeShortcutOverrides(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: ShortcutOverrides = {};
  for (const entry of shortcutDefinitions) {
    if (entry.group === "System") continue;
    const raw = (value as Record<string, unknown>)[entry.id];
    if (typeof raw !== "string" || !validShortcutForCommand(entry.id, raw)) continue;
    const binding = shortcutStrokes(raw).join(" ");
    if ([false, true].some(mac => shortcutCollision(entry.id, binding, result, mac))) continue;
    if (binding !== entry.defaultKey || entry.macKey && binding !== entry.macKey) result[entry.id] = binding;
  }
  return result;
}

export function shortcutFromEvent(event: KeyboardEvent, mac: boolean, allowBareSecondStroke = false): string | null {
  if (event.isComposing || event.getModifierState("AltGraph")) return null;
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5)
    : event.code === "Slash" ? "/"
    : event.code === "BracketLeft" ? "["
    : event.code === "BracketRight" ? "]"
    : event.code === "Backslash" ? "\\"
    : event.code === "Period" ? "."
    : event.code === "Comma" ? ","
    : event.code === "Backquote" ? "Backquote"
    : event.key === " " ? "Space"
    : event.code;
  const value = [mac ? event.metaKey && "Mod" : event.ctrlKey && "Mod", mac && event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", key]
    .filter(Boolean).join("-");
  return (allowBareSecondStroke ? canonicalShortcut(value, mac) !== null : validShortcut(value)) ? value : null;
}

export type ShortcutCaptureResult =
  | { kind: "waiting" }
  | { kind: "invalid"; reason: "combination" | "application" }
  | { kind: "conflict"; key: string; platform: "Windows/Linux" | "macOS"; command: ShortcutDefinition }
  | { kind: "accepted"; key: string };

/** Validates the next key event without changing any persisted settings. */
export function captureShortcut(
  id: string,
  event: KeyboardEvent,
  overrides: ShortcutOverrides,
  mac: boolean,
  prefix: string | null = null,
): ShortcutCaptureResult {
  if (event.isComposing || event.getModifierState("AltGraph")
    || ["Alt", "Control", "Meta", "Shift"].includes(event.key)) return { kind: "waiting" };
  const stroke = shortcutFromEvent(event, mac, prefix !== null);
  const key = stroke && prefix ? `${prefix} ${stroke}` : stroke;
  if (!key) return { kind: "invalid", reason: "combination" };
  if (!validShortcutForCommand(id, key)) return { kind: "invalid", reason: "application" };
  for (const platform of [false, true]) {
    const command = shortcutCollision(id, key, overrides, platform);
    if (command) return { kind: "conflict", key, platform: platform ? "macOS" : "Windows/Linux", command };
  }
  return { kind: "accepted", key };
}

export function applicationShortcutForEvent(event: KeyboardEvent, overrides: ShortcutOverrides, mac: boolean): string | null {
  const pressed = shortcutFromEvent(event, mac);
  if (!pressed) return null;
  const canonical = canonicalShortcut(pressed, mac);
  return applicationShortcuts.find(entry => {
    const configured = shortcutFor(entry.id, overrides, mac);
    return configured && canonical === canonicalShortcut(configured, mac);
  })?.id ?? null;
}

/** Application shortcuts need a sequence dispatcher because menus only bind one key. */
export class ApplicationShortcutSequence {
  private pending: { key: string; mac: boolean; expiresAt: number } | null = null;

  reset(): void { this.pending = null; }

  handle(event: KeyboardEvent, overrides: ShortcutOverrides, mac: boolean, now = Date.now(), active: (id: string) => boolean = () => true):
    { kind: "none" | "pending" | "cancelled" } | { kind: "matched"; id: string } {
    const pending = this.pending;
    if (pending && (pending.mac !== mac || now >= pending.expiresAt || event.isComposing || event.getModifierState("AltGraph"))) {
      this.pending = null;
    } else if (pending) {
      if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) return { kind: "none" };
      this.pending = null;
      if (event.key === "Escape") return { kind: "cancelled" };
      const second = shortcutFromEvent(event, mac, true);
      if (!second) return { kind: "cancelled" };
      const complete = canonicalShortcut(`${pending.key} ${second}`, mac);
      const match = applicationShortcuts.find(entry => active(entry.id) && canonicalShortcut(shortcutFor(entry.id, overrides, mac), mac) === complete);
      return match ? { kind: "matched", id: match.id } : { kind: "cancelled" };
    }
    const matched = applicationShortcutForEvent(event, overrides, mac);
    if (matched && active(matched)) return { kind: "matched", id: matched };
    const first = shortcutFromEvent(event, mac);
    if (first && applicationShortcuts.some(entry => {
      if (!active(entry.id)) return false;
      const binding = shortcutFor(entry.id, overrides, mac);
      return shortcutStrokes(binding).length === 2 && canonicalShortcut(shortcutStrokes(binding)[0], mac) === canonicalShortcut(first, mac);
    })) {
      this.pending = { key: first, mac, expiresAt: now + 4000 };
      return { kind: "pending" };
    }
    return { kind: "none" };
  }
}
