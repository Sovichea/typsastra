import { installGraphemeTextControl, type GraphemeTextControl } from "./graphemeTextControl";

const TEXT_INPUT_SELECTOR = [
  "input:not([type])",
  'input[type="text"]',
  'input[type="search"]',
  'input[type="number"]',
  'input[type="email"]',
  'input[type="url"]',
  'input[type="tel"]',
  'input[type="password"]',
  "textarea"
].join(",");

const GRAPHEME_TEXT_INPUT_SELECTOR = [
  "input:not([type])",
  'input[type="text"]',
  'input[type="search"]',
  'input[type="email"]',
  'input[type="url"]',
  'input[type="tel"]',
  'input[type="password"]',
  "textarea",
].join(",");

export function desktopInputAttributes(): Readonly<Record<string, string>> {
  return {
    autocomplete: "off",
    autocorrect: "off",
    autocapitalize: "off",
    spellcheck: "false"
  };
}

function applyDesktopInputAttributes(control: Element): void {
  for (const [name, value] of Object.entries(desktopInputAttributes())) {
    control.setAttribute(name, value);
  }
  if (control.matches(GRAPHEME_TEXT_INPUT_SELECTOR)) {
    installGraphemeTextControl(control as GraphemeTextControl);
  }
}

function applyWithin(root: ParentNode): void {
  if (root instanceof Element && root.matches(TEXT_INPUT_SELECTOR)) {
    applyDesktopInputAttributes(root);
  }
  root.querySelectorAll(TEXT_INPUT_SELECTOR).forEach(applyDesktopInputAttributes);
}

const zoomGuardDocuments = new WeakSet<Document>();

function preventBrowserPageZoom(doc: Document): void {
  if (zoomGuardDocuments.has(doc)) return;
  zoomGuardDocuments.add(doc);
  // Enable native pinch delivery, but reserve scale changes for preview
  // gesture handlers rather than magnifying the entire application's UI.
  doc.addEventListener("wheel", event => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  }, { passive: false });
  doc.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && ["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0"].includes(event.code)) {
      event.preventDefault();
    }
  });
}

export function initializeDesktopInputPolicy(doc: Document = document): MutationObserver {
  applyWithin(doc);
  preventBrowserPageZoom(doc);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      record.addedNodes.forEach(node => {
        if (node instanceof Element) applyWithin(node);
      });
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  return observer;
}

/** Apply the input policy to a static secondary document such as the PDF iframe. */
export function applyDesktopInputPolicy(doc: Document): void {
  applyWithin(doc);
  preventBrowserPageZoom(doc);
}
