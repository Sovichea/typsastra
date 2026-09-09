import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import {
  parseLanguageCatalog,
  type LanguageCatalogCapabilities,
} from "../languageSupport";
import type {
  DocumentLanguageService,
  ScriptLanguageAssignment,
} from "./languageScopes";

export interface DocumentLanguageStatusDependencies {
  editor(): EditorView;
  activeFilePath(): string | null;
  languageService(): DocumentLanguageService;
  assignments(): readonly ScriptLanguageAssignment[];
  applyAssignments(assignments: readonly ScriptLanguageAssignment[]): void;
  catalogChanged(catalog: readonly LanguageCatalogCapabilities[]): void;
  spellcheckEnabled(): boolean;
  wordCompletionEnabled(): boolean;
  setSpellcheckEnabled(enabled: boolean): void;
  setWordCompletionEnabled(enabled: boolean): void;
}

export class DocumentLanguageStatusController {
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly deps: DocumentLanguageStatusDependencies) {}

  async initialize(): Promise<void> {
    document.getElementById("document-language-status")?.addEventListener("click", event => {
      event.preventDefault();
      this.open(event.currentTarget as HTMLElement);
    });
    document.getElementById("document-language-close")?.addEventListener("click", () => this.close());
    document.getElementById("document-language-cancel")?.addEventListener("click", () => this.close());
    document.getElementById("document-language-apply")?.addEventListener("click", () => this.apply());
    document.getElementById("document-language-spellcheck")?.addEventListener("click", () => {
      this.deps.setSpellcheckEnabled(!this.deps.spellcheckEnabled());
      this.updateFeatureToggles();
    });
    document.getElementById("document-language-completion")?.addEventListener("click", () => {
      this.deps.setWordCompletionEnabled(!this.deps.wordCompletionEnabled());
      this.updateFeatureToggles();
    });
    document.getElementById("document-language-manage")?.addEventListener("click", () => {
      this.close(false);
      document.dispatchEvent(new CustomEvent("typsastra:open-settings", { detail: { panel: "editor" } }));
    });
    this.overlay()?.addEventListener("mousedown", event => {
      if (event.target === this.overlay()) this.close();
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || this.overlay()?.classList.contains("hidden")) return;
      event.preventDefault();
      this.close();
    });
    try {
      const catalog = parseLanguageCatalog(await invoke<unknown>("list_hunspell_catalog"));
      this.deps.catalogChanged(catalog);
    } catch (error) {
      console.warn("Failed to load the language catalog for document language selection.", error);
      this.deps.catalogChanged([]);
    }
    this.update();
  }

  update(path = this.deps.activeFilePath()): void {
    const button = document.getElementById("document-language-status") as HTMLButtonElement | null;
    const label = button?.querySelector<HTMLElement>(".status-label");
    if (!button || !label) return;
    const active = Boolean(path?.toLocaleLowerCase().endsWith(".typ"));
    button.hidden = !active;
    if (!active) return;

    const editor = this.deps.editor();
    const selection = this.deps.languageService().languageAt(
      editor.state.doc,
      editor.state.selection.main.head,
    );
    const text = selection ? this.selectionLabel(selection) : "No language context";
    label.textContent = text;
    button.dataset.state = selection?.state ?? "none";
    button.title = selection
      ? `${selection.script.label} script · ${text}. Used for spellcheck and word completion.`
      : "Move the caret into text to see its spellcheck and word-completion language.";
    button.setAttribute("aria-label", `Document language: ${text}`);
    if (!this.overlay()?.classList.contains("hidden")) this.renderModal();
  }

  private selectionLabel(selection: ReturnType<DocumentLanguageService["languageAt"]> & {}): string {
    if (selection.state === "unavailable") return `${selection.script.label} — unavailable`;
    if (selection.state === "unconfigured") return `${selection.script.label} — select language`;
    if (!selection.languageTag) return selection.script.label;
    const language = displayLanguageTag(selection.languageTag, selection.displayName ?? selection.script.label);
    return selection.state === "missing" ? `${language} — not installed` : language;
  }

  private open(trigger: HTMLElement): void {
    this.returnFocus = trigger;
    this.renderModal();
    const overlay = this.overlay();
    if (!overlay) return;
    overlay.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => overlay.querySelector<HTMLElement>("select, button")?.focus());
  }

  private close(restoreFocus = true): void {
    this.overlay()?.classList.add("hidden");
    document.getElementById("document-language-status")?.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private renderModal(): void {
    this.updateFeatureToggles();
    const container = document.getElementById("document-language-assignments");
    const empty = document.getElementById("document-language-empty");
    if (!container || !empty) return;
    const configurable = this.deps.languageService().configurableScripts();
    const current = this.deps.assignments();
    container.replaceChildren(...configurable.map(({ script, options }) => {
      const row = document.createElement("label");
      row.className = "document-language-row";
      const name = document.createElement("span");
      name.className = "document-language-script";
      name.textContent = script.label;
      const select = document.createElement("select");
      select.dataset.scriptLanguage = script.iso15924;
      select.setAttribute("aria-label", `${script.label} language`);
      const prompt = document.createElement("option");
      prompt.value = "";
      prompt.textContent = "Select language";
      select.append(prompt, ...options.map(option => {
        const item = document.createElement("option");
        item.value = option.languageTag;
        item.textContent = `${displayLanguageTag(option.languageTag, option.displayName)}${option.installed ? "" : " · not installed"}`;
        return item;
      }));
      const assigned = current.find(entry => entry.script.toLowerCase() === script.iso15924.toLowerCase())?.languageTag ?? "";
      if (assigned && !options.some(option => option.languageTag.toLowerCase() === assigned.toLowerCase())) {
        const unavailable = document.createElement("option");
        unavailable.value = assigned;
        unavailable.textContent = `${displayLanguageTag(assigned, assigned)} · unavailable`;
        select.append(unavailable);
      }
      select.value = assigned;
      row.append(name, select);
      return row;
    }));
    empty.hidden = configurable.length > 0;
  }

  private updateFeatureToggles(): void {
    this.updateFeatureToggle("document-language-spellcheck", this.deps.spellcheckEnabled(), "Spellcheck");
    this.updateFeatureToggle("document-language-completion", this.deps.wordCompletionEnabled(), "Word autocomplete");
  }

  private updateFeatureToggle(id: string, enabled: boolean, label: string): void {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (!button) return;
    button.setAttribute("aria-pressed", String(enabled));
    button.dataset.enabled = String(enabled);
    button.title = `${label}: ${enabled ? "On" : "Off"}`;
    button.setAttribute("aria-label", `${label}: ${enabled ? "On" : "Off"}`);
  }

  private apply(): void {
    const selects = [...document.querySelectorAll<HTMLSelectElement>("#document-language-assignments [data-script-language]")];
    const visibleScripts = new Set(selects.map(select => select.dataset.scriptLanguage!.toLowerCase()));
    const assignments = [
      ...this.deps.assignments().filter(entry => !visibleScripts.has(entry.script.toLowerCase())),
      ...selects.flatMap(select => select.value
        ? [{ script: select.dataset.scriptLanguage!, languageTag: select.value }]
        : []),
    ];
    this.deps.applyAssignments(assignments);
    this.close();
    this.update();
  }

  private overlay(): HTMLElement | null {
    return document.getElementById("document-language-overlay");
  }
}

export function displayLanguageTag(languageTag: string, fallback: string): string {
  try {
    const locale = new Intl.Locale(languageTag);
    const language = new Intl.DisplayNames(["en"], { type: "language" }).of(locale.language) ?? fallback;
    const region = locale.region
      ? new Intl.DisplayNames(["en"], { type: "region" }).of(locale.region)
      : null;
    return region ? `${language} — ${region}` : language;
  } catch {
    return fallback;
  }
}
