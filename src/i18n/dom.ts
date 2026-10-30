import { normalizeMessageKey } from "./translate";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

const translatedAttributes = ["title", "placeholder", "aria-label", "alt"] as const;

const skippedTags = new Set([
  "SCRIPT",
  "STYLE",
  "CODE",
  "PRE",
  "KBD",
  "SAMP",
  "TEXTAREA",
  "SVG",
  "PATH",
  "CANVAS",
  "TITLE",
]);

const skippedClassPattern = /(^|\s)(hotkey|cm-editor|cm-content|cm-tooltip|monaco-editor)(\s|$)/;

type Translator = (message: string) => string;

interface TranslationState {
  source: string;
  applied: string;
}

const textStates = new WeakMap<object, TranslationState>();
const attributeStates = new WeakMap<object, Map<string, TranslationState>>();

function hasLetters(value: string): boolean {
  return /\p{L}/u.test(value);
}

function splitOuterWhitespace(value: string): { leading: string; core: string; trailing: string } {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const end = Math.max(leading.length, value.length - trailing.length);
  return { leading, core: value.slice(leading.length, end), trailing };
}

function stateForText(node: object, current: string): TranslationState {
  const existing = textStates.get(node);
  if (!existing || current !== existing.applied) {
    const next = { source: current, applied: current };
    textStates.set(node, next);
    return next;
  }
  return existing;
}

function stateForAttribute(element: object, attribute: string, current: string): TranslationState {
  let states = attributeStates.get(element);
  if (!states) {
    states = new Map();
    attributeStates.set(element, states);
  }
  const existing = states.get(attribute);
  if (!existing || current !== existing.applied) {
    const next = { source: current, applied: current };
    states.set(attribute, next);
    return next;
  }
  return existing;
}

function translatedValue(translate: Translator, source: string): string {
  const { leading, core, trailing } = splitOuterWhitespace(source);
  if (!core || !hasLetters(core)) return source;
  const translated = translate(core);
  return translated === core ? source : `${leading}${translated}${trailing}`;
}

function localizeTextNode(node: Node, translate: Translator): void {
  const current = node.nodeValue ?? "";
  if (!current || !hasLetters(current)) return;
  const state = stateForText(node, current);
  const next = translatedValue(translate, state.source);
  if (next === current) {
    state.applied = current;
    return;
  }
  node.nodeValue = next;
  state.applied = next;
}

function localizeAttributes(element: Element, translate: Translator): void {
  for (const attribute of translatedAttributes) {
    const value = element.getAttribute(attribute);
    if (value === null) continue;
    const overrideKey = element.getAttribute(`data-i18n-${attribute}`);
    const state = stateForAttribute(element, attribute, value);
    const source = overrideKey ?? state.source;
    const next = translatedValue(translate, source);
    if (next === value) {
      state.applied = value;
      continue;
    }
    element.setAttribute(attribute, next);
    state.applied = next;
  }
}

function localizeElementText(element: Element, translate: Translator): void {
  const key = element.getAttribute("data-i18n");
  if (!key) return;
  if (element.children.length > 0) return;
  const current = element.textContent ?? "";
  if (!hasLetters(current)) return;
  const { leading, trailing } = splitOuterWhitespace(current);
  const translated = translate(key);
  const next = `${leading}${translated}${trailing}`;
  if (next !== current) element.textContent = next;
}

function skipsAttributes(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "SVG" || tag === "PATH" || tag === "CANVAS" || tag === "TITLE") {
    return true;
  }
  if (element.hasAttribute("data-i18n-skip")) return true;
  if ((element.getAttribute("contenteditable") ?? "").toLowerCase() === "true") return true;
  if (element.hasAttribute("data-shortcut")) return true;
  const className = element.getAttribute("class") ?? "";
  return skippedClassPattern.test(className);
}

function isSkippedElement(element: Element): boolean {
  return skippedTags.has(element.tagName.toUpperCase()) || skipsAttributes(element);
}

function walk(node: Node, translate: Translator, parentSkipped: boolean): void {
  if (node.nodeType === TEXT_NODE) {
    if (!parentSkipped) localizeTextNode(node, translate);
    return;
  }
  if (node.nodeType !== ELEMENT_NODE
    && node.nodeType !== DOCUMENT_NODE
    && node.nodeType !== DOCUMENT_FRAGMENT_NODE) {
    return;
  }

  let skipped = parentSkipped;
  if (node.nodeType === ELEMENT_NODE) {
    const element = node as Element;
    if (!parentSkipped && !skipsAttributes(element)) localizeAttributes(element, translate);
    skipped = parentSkipped || isSkippedElement(element);
    if (!skipped) {
      if (element.hasAttribute("data-i18n")) {
        localizeElementText(element, translate);
        return;
      }
    }
  }

  for (const child of node.childNodes) walk(child, translate, skipped);
}

/**
 * Translates text nodes and common accessible attributes below `root`.
 * Source strings are retained so switching back to the source locale restores
 * the authored text without a reload.
 */
export function applyDomTranslations(root: ParentNode, translate: Translator): void {
  walk(root as unknown as Node, translate, false);
}

/**
 * Replaces an element's HTML and immediately localizes the new subtree. Use
 * this instead of assigning `innerHTML` for UI that contains authored text.
 */
export function applyLocalizedHtml(element: Element, html: string, translate: Translator): void {
  element.innerHTML = html;
  applyDomTranslations(element, translate);
}

export function isTranslatableText(value: string): boolean {
  return hasLetters(normalizeMessageKey(value));
}
