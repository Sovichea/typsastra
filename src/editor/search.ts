import { EditorSelection, EditorState } from "@codemirror/state";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery
} from "@codemirror/search";
import { createAppIcon, type AppIconName } from "../ui/icons";
import { wrapEditorCaretInput } from "../ui/editorCaretInput";
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { TypsastraSearchQuery } from "./searchMatcher";
import { t } from "../i18n";

export { TypsastraSearchQuery, type TypsastraSearchQueryConfig } from "./searchMatcher";

function input(attributes: Record<string, string | boolean | EventListener>): HTMLInputElement {
  const element = document.createElement("input");
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value === "boolean") {
      if (name === "checked") element.checked = value;
      else if (name === "disabled") element.disabled = value;
      else if (name === "spellcheck") element.spellcheck = value;
    } else if (typeof value === "function" && name.startsWith("on")) {
      element.addEventListener(name.slice(2), value);
    } else {
      const text = String(value);
      element.setAttribute(name, ["placeholder", "title", "aria-label"].includes(name) ? t(text) : text);
    }
  }
  return element;
}

function editorCaretInput(field: HTMLInputElement): HTMLSpanElement {
  return wrapEditorCaretInput(field, {
    shellClass: "cm-search-textfield-shell",
    measureClass: "cm-search-caret-measure",
    caretClass: "cm-search-editor-caret",
  });
}

function iconButton(name: string, label: string, icon: AppIconName, action: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.name = name;
  element.className = "cm-button cm-search-icon-button";
  element.title = t(label);
  element.setAttribute("aria-label", t(label));
  element.append(createAppIcon(icon, { size: 16 }));
  element.addEventListener("click", action);
  return element;
}

function iconToggle(field: HTMLInputElement, label: string, icon: AppIconName): HTMLLabelElement {
  const element = document.createElement("label");
  element.className = "cm-search-icon-toggle";
  element.title = t(label);
  field.setAttribute("aria-label", t(label));
  element.append(field, createAppIcon(icon, { size: 16 }));
  return element;
}

function queryMatchDiacritics(query: SearchQuery): boolean {
  return query instanceof TypsastraSearchQuery ? query.matchDiacritics : true;
}

export function collapseSearchSelection(state: EditorState): EditorSelection {
  const selection = state.selection;
  return EditorSelection.create(
    selection.ranges.map(range => EditorSelection.cursor(range.head)),
    selection.mainIndex
  );
}

export class TypsastraSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  readonly pos = 80;
  private query: TypsastraSearchQuery;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly caseField: HTMLInputElement;
  private readonly regexpField: HTMLInputElement;
  private readonly wordField: HTMLInputElement;
  private readonly diacriticsField: HTMLInputElement;

  constructor(private readonly view: EditorView) {
    const initial = getSearchQuery(view.state);
    this.query = this.fromQuery(initial);
    const commit = () => this.commit();
    this.searchField = input({
      value: this.query.search,
      placeholder: "Find",
      "aria-label": "Find",
      class: "cm-textfield",
      name: "search",
      form: "",
      "main-field": "true",
      autocomplete: "off",
      spellcheck: false,
      oninput: commit,
      onchange: commit
    });
    this.replaceField = input({
      value: this.query.replace,
      placeholder: "Replace",
      "aria-label": "Replace",
      class: "cm-textfield",
      name: "replace",
      form: "",
      autocomplete: "off",
      spellcheck: false,
      oninput: commit,
      onchange: commit
    });
    this.caseField = input({ type: "checkbox", name: "case", form: "", checked: this.query.caseSensitive, onchange: commit });
    this.regexpField = input({ type: "checkbox", name: "re", form: "", checked: this.query.regexp, onchange: commit });
    this.wordField = input({ type: "checkbox", name: "word", form: "", checked: this.query.wholeWord, onchange: commit });
    this.diacriticsField = input({
      type: "checkbox",
      name: "diacritics",
      form: "",
      checked: this.query.matchDiacritics,
      disabled: this.query.regexp,
      onchange: commit
    });
    this.dom = document.createElement("div");
    this.dom.className = "cm-search";
    this.dom.addEventListener("keydown", event => this.keydown(event));
    const searchRow = document.createElement("div");
    searchRow.className = "cm-search-row";
    searchRow.append(
      editorCaretInput(this.searchField),
      iconButton("next", "Next match", "arrowDown", () => findNext(view)),
      iconButton("prev", "Previous match", "arrowUp", () => findPrevious(view)),
      iconButton("select", "Select all matches", "listChecks", () => selectMatches(view)),
      iconToggle(this.caseField, "Match case", "caseSensitive"),
      iconToggle(this.regexpField, "Use regular expression", "regex"),
      iconToggle(this.wordField, "Match whole word", "wholeWord"),
      iconToggle(this.diacriticsField, "Match diacritics", "languages")
    );
    
    const replaceRow = document.createElement("div");
    replaceRow.className = "cm-search-row";
    
    if (!view.state.readOnly) {
      replaceRow.append(
        editorCaretInput(this.replaceField),
        iconButton("replace", "Replace next match", "replace", () => replaceNext(view)),
        iconButton("replaceAll", "Replace all matches", "replaceAll", () => replaceAll(view))
      );
    }

    Object.assign(searchRow.style, {
      display: "flex",
      alignItems: "center",
      gap: "4px"
    });
    
    Object.assign(replaceRow.style, {
      display: "flex",
      alignItems: "center",
      gap: "4px"
    });
    
    this.searchField.style.width = "280px";
    this.replaceField.style.width = "280px";
    
    this.dom.append(searchRow);
    if (!view.state.readOnly) this.dom.append(replaceRow);
    
    const close = iconButton("close", "Close search", "x", () => closeSearchPanel(view));
    this.dom.append(close);
  }

  mount(): void {
    this.searchField.select();
    // CodeMirror mounts panels while applying the transaction that opened
    // them. Dispatching synchronously from here aborts that view update and
    // prevents the search panel from appearing. Promote the initial native
    // query to Typsastra's query type after the opening transaction settles.
    queueMicrotask(() => {
      if (!this.dom.isConnected) return;
      const current = getSearchQuery(this.view.state);
      if (current instanceof TypsastraSearchQuery && current.eq(this.query)) return;
      this.view.dispatch({ effects: setSearchQuery.of(this.query) });
    });
  }

  update(update: ViewUpdate): void {
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.setQuery(effect.value);
        }
      }
    }
  }

  private fromQuery(query: SearchQuery): TypsastraSearchQuery {
    return new TypsastraSearchQuery({
      search: query.search,
      caseSensitive: query.caseSensitive,
      literal: query.literal,
      regexp: query.regexp,
      replace: query.replace,
      wholeWord: query.wholeWord,
      matchDiacritics: queryMatchDiacritics(query),
      test: query.test
    });
  }

  private commit(): void {
    const query = new TypsastraSearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.regexpField.checked,
      wholeWord: this.wordField.checked,
      replace: this.replaceField.value,
      matchDiacritics: this.diacriticsField.checked
    });
    this.diacriticsField.disabled = query.regexp;
    if (!query.eq(this.query)) {
      const clearSearchSelection = !query.valid
        && this.query.valid
        && !this.view.state.selection.main.empty;
      this.query = query;
      this.view.dispatch({
        effects: setSearchQuery.of(query),
        ...(clearSearchSelection ? { selection: collapseSearchSelection(this.view.state) } : {})
      });
    }
  }

  private setQuery(query: SearchQuery): void {
    this.query = this.fromQuery(query);
    this.searchField.value = this.query.search;
    this.replaceField.value = this.query.replace;
    this.caseField.checked = this.query.caseSensitive;
    this.regexpField.checked = this.query.regexp;
    this.wordField.checked = this.query.wholeWord;
    this.diacriticsField.checked = this.query.matchDiacritics;
    this.diacriticsField.disabled = this.query.regexp;
  }

  private keydown(event: KeyboardEvent): void {
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
    } else if (event.key === "Enter" && event.target === this.searchField) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    } else if (event.key === "Enter" && event.target === this.replaceField) {
      event.preventDefault();
      replaceNext(this.view);
    }
  }
}
