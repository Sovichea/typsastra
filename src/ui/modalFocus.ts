const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function modalTabDestination(
  currentIndex: number,
  focusableCount: number,
  backwards: boolean
): number | null {
  if (focusableCount <= 0) return null;
  if (currentIndex < 0 || currentIndex >= focusableCount) {
    return backwards ? focusableCount - 1 : 0;
  }
  return backwards
    ? (currentIndex - 1 + focusableCount) % focusableCount
    : (currentIndex + 1) % focusableCount;
}

function visibleModalDialog(documentRoot: Document): HTMLElement | null {
  const dialogs = [...documentRoot.querySelectorAll<HTMLElement>("[aria-modal='true']")];
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index];
    const overlay = dialog.closest<HTMLElement>(".settings-overlay");
    if (overlay && !overlay.classList.contains("hidden")) return dialog;
  }
  return null;
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(element => {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    if (element.closest(".hidden")) return false;
    return element.getClientRects().length > 0;
  });
}

function focusInsideDialog(dialog: HTMLElement, backwards = false): void {
  const focusable = focusableElements(dialog);
  const destination = modalTabDestination(-1, focusable.length, backwards);
  if (destination !== null) {
    focusable[destination].focus();
    return;
  }
  if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
  dialog.focus();
}

/** Keep sequential and programmatic focus inside the topmost visible modal. */
export function installModalFocusTrap(documentRoot: Document = document): () => void {
  let redirectingFocus = false;
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const dialog = visibleModalDialog(documentRoot);
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    const active = documentRoot.activeElement;
    const currentIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
    const destination = modalTabDestination(currentIndex, focusable.length, event.shiftKey);
    event.preventDefault();
    if (destination !== null) focusable[destination].focus();
    else focusInsideDialog(dialog, event.shiftKey);
  };
  const onFocusIn = (event: FocusEvent) => {
    if (redirectingFocus) return;
    const dialog = visibleModalDialog(documentRoot);
    const target = event.target;
    if (!dialog || (target instanceof Node && dialog.contains(target))) return;
    redirectingFocus = true;
    focusInsideDialog(dialog);
    redirectingFocus = false;
  };

  documentRoot.addEventListener("keydown", onKeydown, true);
  documentRoot.addEventListener("focusin", onFocusIn, true);
  return () => {
    documentRoot.removeEventListener("keydown", onKeydown, true);
    documentRoot.removeEventListener("focusin", onFocusIn, true);
  };
}
