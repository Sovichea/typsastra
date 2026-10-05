import { resolveRuntimeTitlebar, type RuntimeTitlebarInput } from "./runtimeTitlebar";
import { applicationShortcuts, canonicalShortcut, shortcutFor, type ShortcutOverrides } from "./shortcutRegistry";

let configuredShortcuts: ShortcutOverrides = {};

export function setShortcutLabelOverrides(overrides: ShortcutOverrides): void {
  configuredShortcuts = overrides;
  applyShortcutLabels();
}

/**
 * Shortcut labels are authored once in a platform-neutral form and rendered per
 * platform. `Mod` is the primary accelerator: Cmd on macOS, Ctrl elsewhere.
 * Everything that is not a known modifier passes through as the key name.
 */
const macModifierNames: Record<string, string> = {
  Mod: "Cmd",
  Alt: "Option",
  Ctrl: "Control",
  Shift: "Shift"
};

const standardModifierNames: Record<string, string> = {
  Mod: "Ctrl",
  Alt: "Alt",
  Ctrl: "Ctrl",
  Shift: "Shift"
};

export function isMacShortcutPlatform(input: RuntimeTitlebarInput = {
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  search: window.location.search,
  dev: (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true
}): boolean {
  return resolveRuntimeTitlebar(input).mode === "native-macos";
}

/** Renders one platform-neutral spec, e.g. `Mod+Shift+T` or the chord `Mod+K Mod+O`. */
export function formatShortcut(spec: string, mac: boolean): string {
  const names = mac ? macModifierNames : standardModifierNames;
  return spec.trim().split(/\s+/).filter(Boolean).map(chord =>
    chord.split("+").map(part => names[part]
      ?? (part.length === 1 && /[a-z]/.test(part) ? part.toUpperCase() : part === "Backquote" ? "`" : part === "Comma" ? "," : part)).join("+")
  ).join(", ");
}

/**
 * Renders a shortcut whose macOS binding may differ beyond the modifier name,
 * such as redo: `Mod+Y` on Windows and Linux, `Mod+Shift+Z` on macOS.
 */
export function shortcutLabel(spec: string, macSpec: string = spec, mac: boolean = isMacShortcutPlatform()): string {
  return formatShortcut(mac ? macSpec : spec, mac);
}

/**
 * Fills every `[data-shortcut]` element with its platform label. `data-shortcut`
 * holds the Windows and Linux spec; the optional `data-shortcut-mac` overrides
 * the whole spec on macOS. Elements keep their authored text as a static
 * fallback, so the pre-script paint already reads correctly off macOS.
 *
 * An element carrying `data-shortcut-title` writes its `title` instead of its
 * text, substituting the label for `{}` in that template.
 */
export function applyShortcutLabels(root: ParentNode = document, mac: boolean = isMacShortcutPlatform()): void {
  root.querySelectorAll<HTMLElement>("[data-shortcut]").forEach(element => {
    const spec = element.dataset.shortcut;
    if (!spec) return;
    const original = mac ? element.dataset.shortcutMac ?? spec : spec;
    const entry = applicationShortcuts.find(candidate => {
      const defaultSpec = mac ? candidate.macKey ?? candidate.defaultKey : candidate.defaultKey;
      return canonicalShortcut(defaultSpec, mac) === canonicalShortcut(original.replace(/\+/g, "-"), mac);
    });
    const binding = entry ? shortcutFor(entry.id, configuredShortcuts, mac).replace(/-/g, "+") : original;
    const label = formatShortcut(binding, mac);
    const title = element.dataset.shortcutTitle;
    if (title === undefined) element.textContent = label;
    else element.title = title.replace("{}", label);
  });
}
