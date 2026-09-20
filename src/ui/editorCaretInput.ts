export type EditorCaretInputOptions = {
  shellClass?: string;
  measureClass?: string;
  caretClass?: string;
};

const CARET_MOVEMENT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Wrap an input with the same full-height caret used by the editor. */
export function wrapEditorCaretInput(
  field: HTMLInputElement,
  options: EditorCaretInputOptions = {},
): HTMLSpanElement {
  const shell = document.createElement("span");
  shell.className = ["typsastra-caret-input-shell", options.shellClass]
    .filter(Boolean)
    .join(" ");
  const measure = document.createElement("span");
  measure.className = ["typsastra-caret-measure", options.measureClass]
    .filter(Boolean)
    .join(" ");
  const caret = document.createElement("span");
  caret.className = ["typsastra-input-caret", options.caretClass]
    .filter(Boolean)
    .join(" ");
  shell.append(field, measure, caret);

  let updateFrame: number | null = null;
  let steadyCaretTimer: number | null = null;

  // The measure must use the field's exact typography, otherwise modifiers like
  // bold header cells shift the caret off the text.
  const applyFieldFont = () => {
    const style = window.getComputedStyle(field);
    measure.style.fontFamily = style.fontFamily;
    measure.style.fontSize = style.fontSize;
    measure.style.fontWeight = style.fontWeight;
    measure.style.fontStyle = style.fontStyle;
    measure.style.letterSpacing = style.letterSpacing;
    measure.style.textTransform = style.textTransform;
  };

  const updateCaret = () => {
    applyFieldFont();
    const selection = field.selectionStart ?? 0;
    const selectionEnd = field.selectionEnd ?? selection;
    caret.style.visibility = selection === selectionEnd ? "visible" : "hidden";
    measure.textContent = field.value.slice(0, selection) || "\u200b";
    const measuredWidth = selection === 0 ? 0 : measure.getBoundingClientRect().width;
    caret.style.left = `calc(var(--editor-input-horizontal-inset, 10px) + ${measuredWidth - field.scrollLeft}px)`;
  };

  const scheduleCaretUpdate = () => {
    if (updateFrame !== null) return;
    updateFrame = requestAnimationFrame(() => {
      updateFrame = null;
      updateCaret();
    });
  };

  const keepCaretSteady = () => {
    shell.classList.add("typsastra-caret-input-active");
    if (steadyCaretTimer !== null) window.clearTimeout(steadyCaretTimer);
    steadyCaretTimer = window.setTimeout(() => {
      steadyCaretTimer = null;
      shell.classList.remove("typsastra-caret-input-active");
    }, 500);
  };

  for (const event of ["focus", "input", "click", "keyup", "select", "scroll"]) {
    field.addEventListener(event, scheduleCaretUpdate);
  }
  field.addEventListener("keydown", event => {
    if (!CARET_MOVEMENT_KEYS.has(event.key)) return;
    keepCaretSteady();
    // Keyboard defaults update selectionStart after keydown listeners run.
    // Repaint on the next frame so held/repeated navigation remains visible.
    scheduleCaretUpdate();
  });
  field.addEventListener("beforeinput", () => {
    keepCaretSteady();
    scheduleCaretUpdate();
  });
  field.addEventListener("pointerdown", () => {
    keepCaretSteady();
    scheduleCaretUpdate();
  });
  field.addEventListener("pointermove", event => {
    if (event.buttons === 0) return;
    keepCaretSteady();
    scheduleCaretUpdate();
  });
  field.addEventListener("blur", () => {
    if (steadyCaretTimer !== null) window.clearTimeout(steadyCaretTimer);
    steadyCaretTimer = null;
    shell.classList.remove("typsastra-caret-input-active");
  });
  field.addEventListener("focus", scheduleCaretUpdate);
  updateCaret();
  return shell;
}
