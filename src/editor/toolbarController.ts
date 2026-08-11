import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { invoke } from "@tauri-apps/api/core";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import {
  parseLanguageCatalog,
  parseLanguageProviderCapabilitiesList,
  type LanguageCatalogCapabilities,
  type LanguageProviderCapabilities,
} from "../languageSupport";
import {
  detectTypographyScripts,
  isTypstInternalOnlyFont,
  parseTypographyBlock,
  preferredInstalledFamily,
  TYPST_INTERNAL_FONT_FAMILIES,
  typographyScripts,
  type DocumentScriptFont,
  type DocumentTypography
} from "./documentTypography";

type EditorMode = "CODE" | "WYSIWYM";
const typographyChoiceStorageKey = "typsastra-last-document-typography";

type PrivateFontDirectoryInspection = {
  path: string;
  families: string[];
  collisions: string[];
};

export type EditorToolbarDependencies = {
  getMode: () => EditorMode;
  getEditor: () => EditorView;
  wysiwymContainer: HTMLElement;
  serializeWysiwym: () => string;
  renderWysiwym: (markup: string) => void;
  save: () => Promise<void>;
  syncPreview: (cursor: number) => Promise<void>;
  applyTypography: (config: DocumentTypography, target: "document" | "template") => Promise<boolean>;
  getWorkspaceRoot: () => string | null;
  onWorkspacePrivateFontDirectoriesChanged: () => void | Promise<void>;
  // TODO: Re-enable when the WYSIWYM layout is ready for use.
  // toggleMode: () => void;
};

const snippets: Record<string, string> = {
  table: "#table(\n  columns: 3,\n  [Header 1], [Header 2], [Header 3],\n  [Cell 1], [Cell 2], [Cell 3],\n)\n",
  figure: '#figure(\n  image("image.png", width: 80%),\n  caption: [Caption],\n)\n',
  bibliography: '#bibliography("refs.bib")\n',
  "math-block": "$\n  x = frac(-b plus.minus sqrt(b^2 - 4 a c), 2 a)\n$\n",
  outline: "#outline()\n",
  pagebreak: "#pagebreak()\n"
};

const wrappers: Record<string, [string, string, string]> = {
  bold: ["#strong[", "]", "strong text"],
  italic: ["#emph[", "]", "emphasized text"],
  underline: ["#underline[", "]", "text"],
  strikethrough: ["#strike[", "]", "text"],
  highlight: ["#highlight[", "]", "text"],
  "inline-code": ["`", "`", "code"],
  "code-block": ["```typst\n", "\n```", "code"],
  blockquote: ["#quote(block: true)[\n  ", "\n]", "quote"],
  link: ['#link("https://example.com")[', "]", "link text"],
  footnote: ["#footnote[", "]", "note"],
  label: ["<", ">", "label"],
  reference: ["@", "", "label"],
  "inline-math": ["$", "$", "x"],
  subscript: ["_", "", "sub"],
  superscript: ["^", "", "sup"],
  "align-center": ["#align(center)[\n  ", "\n]", "content"],
  "align-right": ["#align(right)[\n  ", "\n]", "content"]
};

export class EditorToolbarController {
  private readonly toolbar = document.getElementById("editor-visual-toolbar")!;
  private systemFontFamilies: string[] = ["MiSans Latin", "Fira Mono"];
  private privateFontFamilies: string[] = [];
  private scriptFontFamilies: Record<string, string[]> = {};
  private languageCatalog: LanguageCatalogCapabilities[] = [];
  private installedLanguageProviders: LanguageProviderCapabilities[] = [];
  private typographyDefaults: DocumentTypography = {
    baseSizePt: 11,
    fonts: [{ script: "latin", family: "MiSans Latin", scale: 1, language: null }]
  };
  private rememberedTypography: DocumentTypography | null = null;
  private coverageGeneration = 0;
  private typographyReturnFocus: HTMLElement | null = null;
  private draggedTypographyRow: HTMLElement | null = null;
  private typographyDragPointerId: number | null = null;

  private readonly onTypographyPointerMove = (event: PointerEvent): void => {
    const row = this.draggedTypographyRow;
    if (!row || this.typographyDragPointerId !== event.pointerId) return;
    event.preventDefault();
    this.reorderTypographyRowAt(row, event.clientY);
  };

  private readonly onTypographyPointerUp = (event: PointerEvent): void => {
    if (!this.draggedTypographyRow || this.typographyDragPointerId !== event.pointerId) return;
    event.preventDefault();
    this.finishTypographyDrag(event.type === "pointerup");
  };

  constructor(private readonly dependencies: EditorToolbarDependencies) {}

  public initialize(): void {
    void this.initializeTypographyControls();
    window.addEventListener("pointermove", this.onTypographyPointerMove, { passive: false });
    window.addEventListener("pointerup", this.onTypographyPointerUp);
    window.addEventListener("pointercancel", this.onTypographyPointerUp);
    document.addEventListener("typsastra:system-fonts-changed", () => void this.initializeTypographyControls());
    document.addEventListener("typsastra:private-fonts-changed", () => void this.initializeTypographyControls());
    document.addEventListener("typsastra:workspace-private-fonts-changed", () => void this.initializeTypographyControls());
    document.addEventListener("typsastra:language-providers-changed", () => void this.initializeTypographyControls());
    document.getElementById("toolbar-typography-apply")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      this.applyDocumentTypography("document");
    });
    document.getElementById("toolbar-typography-apply-template")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      this.applyDocumentTypography("template");
    });
    document.getElementById("toolbar-add-script-font")?.addEventListener("click", event => {
      event.preventDefault();
      const rows = this.fallbackRows();
      const scriptId = rows.length > 0
        ? this.rowScript(rows[rows.length - 1]).value
        : typographyScripts[0].id;
      this.fallbackContainer()?.append(this.createFallbackRow({
        script: scriptId,
        family: "",
        scale: 1,
        language: null,
        defaultText: false,
      }));
      this.updateTypographyAvailability();
    });
    document.getElementById("toolbar-document-typography")?.addEventListener("click", event => {
      event.preventDefault();
      this.openTypographyModal(event.currentTarget as HTMLElement);
    });
    document.getElementById("toolbar-add-workspace-private-font-directory")?.addEventListener("click", () => {
      void this.addWorkspacePrivateFontDirectory();
    });
    document.getElementById("document-typography-close")?.addEventListener("click", () => this.closeTypographyModal());
    document.getElementById("document-typography-cancel")?.addEventListener("click", () => this.closeTypographyModal());
    this.typographyOverlay()?.addEventListener("mousedown", event => {
      if (event.target === this.typographyOverlay()) this.closeTypographyModal();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !this.typographyOverlay()?.classList.contains("hidden")) {
        event.preventDefault();
        this.closeTypographyModal();
      }
    });
    this.toolbar.addEventListener("pointerdown", event => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-tool]") || target.closest(".toolbar-dropdown-btn") || target.closest("#toolbar-document-typography")) event.preventDefault();
    });
    this.toolbar.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      const dropdownButton = target.closest(".toolbar-dropdown-btn");
      if (dropdownButton) {
        const container = dropdownButton.closest(".toolbar-dropdown-container");
        if (container) {
          this.closeDropdowns(container);
          container.classList.toggle("active");
          event.stopPropagation();
        }
        return;
      }
      const button = target.closest<HTMLElement>("[data-tool]");
      this.closeDropdowns();
      if (button) void this.run(button.dataset.tool ?? "");
    });
    document.addEventListener("click", event => {
      if (!this.toolbar.contains(event.target as Node)) this.closeDropdowns();
    });
  }

  private async initializeTypographyControls(): Promise<void> {
    this.rememberedTypography = this.loadRememberedTypography();
    try {
      const [fontCatalog, languageCatalog, providers] = await Promise.all([
        invoke<{
          all: string[];
          scripts: Record<string, string[]>;
          privateLocal: string[];
          documentAll: string[];
          documentScripts: Record<string, string[]>;
        }>("list_system_fonts", { workspaceRootPath: this.dependencies.getWorkspaceRoot() }),
        invoke<unknown>("list_hunspell_catalog"),
        invoke<unknown>("get_provider_capabilities"),
      ]);
      this.systemFontFamilies = [...new Set(fontCatalog.documentAll ?? fontCatalog.all)]
        .sort((left, right) => left.localeCompare(right));
      this.privateFontFamilies = [...new Set(fontCatalog.privateLocal ?? [])]
        .sort((left, right) => left.localeCompare(right));
      this.scriptFontFamilies = fontCatalog.documentScripts ?? fontCatalog.scripts ?? {};
      this.languageCatalog = parseLanguageCatalog(languageCatalog);
      this.installedLanguageProviders = parseLanguageProviderCapabilitiesList(providers);
    } catch (error) {
      console.warn("Unable to load document script options.", error);
    }
    this.syncTypographyControls();
  }

  private emptyFontOption(label: string): HTMLOptionElement {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = label;
    return option;
  }

  private fontOptions(families: readonly string[]): HTMLOptionElement[] {
    return families.map(family => {
      const option = document.createElement("option");
      option.value = family;
      option.textContent = family;
      return option;
    });
  }

  private groupedFontOptions(families: readonly string[]): HTMLOptGroupElement[] {
    const internal = families.filter(family => isTypstInternalOnlyFont(family, this.systemFontFamilies));
    const privateKeys = new Set(this.privateFontFamilies.map(family => family.toLocaleLowerCase()));
    const privateLocal = families.filter(family => privateKeys.has(family.toLocaleLowerCase()));
    const system = families.filter(family =>
      !isTypstInternalOnlyFont(family, this.systemFontFamilies)
      && !privateKeys.has(family.toLocaleLowerCase())
    );
    const group = (label: string, entries: readonly string[]) => {
      const element = document.createElement("optgroup");
      element.label = label;
      element.append(...this.fontOptions(entries));
      return element;
    };
    return [
      ...(internal.length > 0 ? [group("Typst built-in", internal)] : []),
      ...(privateLocal.length > 0 ? [group("Private local", privateLocal)] : []),
      ...(system.length > 0 ? [group("System fonts", system)] : []),
    ];
  }

  private async workspacePrivateFontDirectories(): Promise<string[]> {
    const workspaceRootPath = this.dependencies.getWorkspaceRoot();
    if (!workspaceRootPath) return [];
    return invoke<string[]>("load_workspace_private_font_directories", { workspaceRootPath });
  }

  private async populateWorkspacePrivateFontDirectories(): Promise<void> {
    const section = document.getElementById("toolbar-workspace-private-fonts-section");
    const container = document.getElementById("toolbar-workspace-private-font-directories");
    const workspaceRootPath = this.dependencies.getWorkspaceRoot();
    if (!section || !container) return;
    section.hidden = !workspaceRootPath;
    if (!workspaceRootPath) {
      container.replaceChildren();
      return;
    }
    try {
      const paths = await this.workspacePrivateFontDirectories();
      const rows = paths.map(path => {
        const text = document.createElement("span");
        text.className = "settings-private-font-path";
        text.textContent = path;
        text.title = path;

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "settings-secondary-button";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove workspace private font directory ${path}`);
        remove.addEventListener("click", () => void this.removeWorkspacePrivateFontDirectory(path));

        const row = document.createElement("div");
        row.className = "settings-private-font-directory";
        row.append(text, remove);
        return row;
      });
      if (rows.length === 0) {
        const empty = document.createElement("small");
        empty.className = "settings-private-font-empty";
        empty.textContent = "No workspace private font directory configured.";
        container.replaceChildren(empty);
      } else {
        container.replaceChildren(...rows);
      }
    } catch (error) {
      const empty = document.createElement("small");
      empty.className = "settings-private-font-empty";
      empty.textContent = `Unable to load workspace private fonts: ${String(error)}`;
      container.replaceChildren(empty);
    }
  }

  public async addWorkspacePrivateFontDirectory(): Promise<void> {
    const workspaceRootPath = this.dependencies.getWorkspaceRoot();
    if (!workspaceRootPath) return;
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose Workspace Private Font Directory"
    });
    if (typeof selected !== "string") return;
    try {
      const inspection = await invoke<PrivateFontDirectoryInspection>(
        "inspect_private_font_directory",
        { path: selected, workspaceRootPath }
      );
      if (inspection.collisions.length > 0) {
        await message(
          `This directory contains font families that are already available from the system, global private folders, or another workspace folder:\n\n${inspection.collisions.join("\n")}\n\nTypsastra does not add ambiguous font families because the compiler could select a different file between sessions.`,
          { title: "Ambiguous Font Families", kind: "error" }
        );
        return;
      }
      const paths = await this.workspacePrivateFontDirectories();
      await this.saveWorkspacePrivateFontDirectories([...paths, inspection.path]);
    } catch (error) {
      await message(String(error), { title: "Unable to Add Workspace Font Directory", kind: "error" });
    }
  }

  private async removeWorkspacePrivateFontDirectory(path: string): Promise<void> {
    const accepted = await confirm(
      `Remove this private font directory from this workspace?\n\n${path}\n\nThe font files will not be deleted. Documents using these fonts may no longer compile on this computer.`,
      {
        title: "Remove Workspace Private Font Directory?",
        kind: "warning",
        okLabel: "Remove",
        cancelLabel: "Cancel"
      }
    );
    if (!accepted) return;
    const paths = await this.workspacePrivateFontDirectories();
    await this.saveWorkspacePrivateFontDirectories(paths.filter(candidate => candidate !== path));
  }

  private async saveWorkspacePrivateFontDirectories(paths: string[]): Promise<void> {
    const workspaceRootPath = this.dependencies.getWorkspaceRoot();
    if (!workspaceRootPath) return;
    await invoke<string[]>("save_workspace_private_font_directories", { workspaceRootPath, paths });
    await this.dependencies.onWorkspacePrivateFontDirectoriesChanged();
    document.dispatchEvent(new Event("typsastra:workspace-private-fonts-changed"));
    await this.populateWorkspacePrivateFontDirectories();
  }

  private supportedFonts(scriptId: string): string[] {
    if (scriptId === "latin") {
      return [...new Set([...this.systemFontFamilies, ...TYPST_INTERNAL_FONT_FAMILIES])]
        .sort((left, right) => left.localeCompare(right));
    }
    return [...new Set(this.scriptFontFamilies[scriptId] ?? [])]
      .sort((left, right) => left.localeCompare(right));
  }

  private fallbackContainer(): HTMLElement | null {
    return document.getElementById("toolbar-document-scripts");
  }

  private typographyOverlay(): HTMLElement | null {
    return document.getElementById("document-typography-overlay");
  }

  private openTypographyModal(returnFocus: HTMLElement): void {
    this.typographyReturnFocus = returnFocus;
    this.closeDropdowns();
    this.syncTypographyControls();
    void this.populateWorkspacePrivateFontDirectories();
    const overlay = this.typographyOverlay();
    if (!overlay) return;
    overlay.classList.remove("hidden");
    returnFocus.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => document.getElementById("document-typography-close")?.focus());
  }

  private closeTypographyModal(): void {
    const overlay = this.typographyOverlay();
    if (!overlay || overlay.classList.contains("hidden")) return;
    overlay.classList.add("hidden");
    this.typographyReturnFocus?.setAttribute("aria-expanded", "false");
    this.typographyReturnFocus?.focus();
    this.typographyReturnFocus = null;
  }

  private fallbackRows(): HTMLElement[] {
    return Array.from(this.fallbackContainer()?.querySelectorAll<HTMLElement>(".toolbar-font-fallback-row") ?? []);
  }

  private rowScript(row: HTMLElement): HTMLSelectElement {
    return row.querySelector<HTMLSelectElement>("[data-fallback-script]")!;
  }

  private typographyScriptLabel(row: HTMLElement): string {
    const scriptId = this.rowScript(row).value;
    return typographyScripts.find(script => script.id === scriptId)?.label ?? scriptId;
  }

  private announceTypographyOrder(row: HTMLElement): void {
    const status = document.getElementById("document-typography-order-status");
    if (!status) return;
    const rows = this.fallbackRows();
    status.textContent = `${this.typographyScriptLabel(row)} moved to position ${rows.indexOf(row) + 1} of ${rows.length}.`;
  }

  private moveTypographyRow(row: HTMLElement, direction: -1 | 1): void {
    const container = this.fallbackContainer();
    const rows = this.fallbackRows();
    const current = rows.indexOf(row);
    const target = current + direction;
    if (!container || current < 0 || target < 0 || target >= rows.length) return;
    if (direction < 0) {
      container.insertBefore(row, rows[target]);
    } else {
      container.insertBefore(row, rows[target].nextSibling);
    }
    this.announceTypographyOrder(row);
    row.querySelector<HTMLButtonElement>("[data-typography-drag-handle]")?.focus();
  }

  private reorderTypographyRowAt(row: HTMLElement, clientY: number): void {
    const container = this.fallbackContainer();
    if (!container) return;
    const insertionTarget = this.fallbackRows()
      .filter(candidate => candidate !== row)
      .find(candidate => {
        const bounds = candidate.getBoundingClientRect();
        return clientY < bounds.top + bounds.height / 2;
      });
    container.insertBefore(row, insertionTarget ?? null);
  }

  private finishTypographyDrag(announce: boolean): void {
    const dragged = this.draggedTypographyRow;
    if (!dragged) return;
    if (announce) this.announceTypographyOrder(dragged);
    dragged.classList.remove("is-dragging");
    this.draggedTypographyRow = null;
    this.typographyDragPointerId = null;
  }

  private languageOptions(scriptId: string): Array<{ tag: string; label: string; installed: boolean }> {
    const script = typographyScripts.find((candidate) => candidate.id === scriptId);
    if (!script) return [];
    const matchesScript = (scripts: readonly string[]) => scripts.some((value) =>
      value.toLowerCase() === script.iso15924.toLowerCase());
    const byTag = new Map<string, { tag: string; label: string; installed: boolean }>();
    for (const entry of this.languageCatalog.filter((candidate) => matchesScript(candidate.scripts))) {
      byTag.set(entry.languageTag, {
        tag: entry.languageTag,
        label: entry.displayName,
        installed: entry.installed,
      });
    }
    for (const provider of this.installedLanguageProviders.filter((candidate) => matchesScript(candidate.scripts))) {
      byTag.set(provider.languageTag, {
        tag: provider.languageTag,
        label: provider.displayName,
        installed: true,
      });
    }
    return [...byTag.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  private populateRowLanguages(row: HTMLElement, scriptId: string, selected: string | null): void {
    const select = row.querySelector<HTMLSelectElement>("[data-fallback-language]");
    if (!select) return;
    const options = this.languageOptions(scriptId);
    const off = document.createElement("option");
    off.value = "";
    off.textContent = "Language tools off";
    select.replaceChildren(off, ...options.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.tag;
      option.textContent = `${entry.label} (${entry.tag})${entry.installed ? "" : " · not installed"}`;
      return option;
    }));
    if (selected && !options.some((entry) => entry.tag === selected)) {
      const unavailable = document.createElement("option");
      unavailable.value = selected;
      unavailable.textContent = `${selected} (unavailable)`;
      select.append(unavailable);
    }
    select.value = selected ?? "";
    const selectedOption = options.find((entry) => entry.tag === select.value);
    const status = row.querySelector<HTMLElement>("[data-language-status]");
    const statusText = row.querySelector<HTMLElement>("[data-language-status-text]");
    const settingsButton = row.querySelector<HTMLButtonElement>("[data-language-settings]");
    const unavailable = !!select.value && !selectedOption;
    const state = !select.value ? "off" : selectedOption?.installed ? "ready" : "missing";
    if (status) status.dataset.state = state;
    if (statusText) {
      statusText.textContent = state === "ready" ? "Ready" : state === "missing" ? "Not installed" : "Off";
      statusText.title = state === "ready"
        ? `${selectedOption?.label ?? select.value} owns language tools for this script.`
        : state === "missing"
          ? `${unavailable ? select.value : selectedOption?.label} needs an installed language provider.`
          : "Spellcheck and word completion are disabled for this script.";
    }
    if (settingsButton) settingsButton.hidden = state !== "missing";
  }

  private populateRowFonts(
    row: HTMLElement,
    scriptId: string,
    preferredFont?: string | null,
    coverageFamilies?: readonly string[]
  ): string[] {
    const select = row.querySelector<HTMLSelectElement>("[data-fallback-font]");
    const compilerFonts = scriptId === "latin" ? TYPST_INTERNAL_FONT_FAMILIES : [];
    const supported = [...new Set([...(coverageFamilies ?? this.supportedFonts(scriptId)), ...compilerFonts])]
      .sort((left, right) => left.localeCompare(right));
    if (!select) return supported;
    const previous = preferredFont === null ? "" : preferredFont ?? select.value;
    select.replaceChildren(
      this.emptyFontOption(supported.length > 0 ? "Select font" : "No compatible installed font"),
      ...this.groupedFontOptions(supported)
    );
    const next = previous === ""
      ? ""
      : supported.find(family => family === previous)
        ?? preferredInstalledFamily(typographyScripts.find(script => script.id === scriptId) ?? typographyScripts[0], supported)
        ?? supported[0]
        ?? "";
    if (next) {
      select.value = next;
    } else {
      select.value = "";
    }
    select.disabled = false;
    const hint = row.querySelector<HTMLElement>("[data-fallback-hint]");
    if (hint) hint.textContent = supported.length > 0
      ? `${supported.length} compatible Typst font${supported.length === 1 ? "" : "s"}.`
      : "No compatible installed font.";
    this.updateTypographyAvailability();
    return supported;
  }

  private createFallbackRow(fallback: DocumentScriptFont, detected = false): HTMLElement {
    const row = document.createElement("div");
    row.className = "toolbar-font-fallback-row";
    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "document-typography-drag-handle";
    dragHandle.dataset.typographyDragHandle = "";
    dragHandle.draggable = false;
    dragHandle.setAttribute("draggable", "false");
    dragHandle.setAttribute("aria-label", `Reorder ${typographyScripts.find(candidate => candidate.id === fallback.script)?.label ?? fallback.script} script`);
    dragHandle.title = "Drag to reorder; use Up or Down Arrow while focused";
    const script = document.createElement("select");
    script.dataset.fallbackScript = "";
    script.replaceChildren(...typographyScripts.map(candidate => {
      const option = document.createElement("option");
      option.value = candidate.id;
      option.textContent = candidate.label;
      return option;
    }));
    script.value = fallback.script;
    const font = document.createElement("select");
    font.dataset.fallbackFont = "";
    const language = document.createElement("select");
    language.dataset.fallbackLanguage = "";
    language.setAttribute("aria-label", "Script language tools");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "toolbar-remove-fallback";
    remove.textContent = "Remove";
    const hint = document.createElement("span");
    hint.dataset.fallbackHint = "";
    hint.className = "document-typography-field-hint";
    const status = document.createElement("div");
    status.className = "document-typography-status";
    status.dataset.languageStatus = "";
    const statusText = document.createElement("span");
    statusText.dataset.languageStatusText = "";
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.dataset.languageSettings = "";
    settingsButton.textContent = "Manage";
    settingsButton.hidden = true;
    status.append(statusText, settingsButton);
    const cell = (label: string, ...children: HTMLElement[]) => {
      const container = document.createElement("div");
      container.className = "document-typography-cell";
      container.dataset.label = label;
      container.append(...children);
      return container;
    };
    const scriptCell = cell("Script order", dragHandle, script);
    scriptCell.classList.add("document-typography-script-cell");
    row.append(
      scriptCell,
      cell("Font", font, hint),
      cell("Language tools", language),
      cell("Status", status),
      cell("", remove),
    );
    this.populateRowFonts(row, fallback.script, fallback.family || undefined);
    this.populateRowLanguages(row, fallback.script, fallback.language);
    if (detected) hint.textContent = `Detected ${typographyScripts.find(item => item.id === fallback.script)?.label}. ${hint.textContent}`;
    script.addEventListener("change", () => {
      this.populateRowFonts(row, script.value);
      this.populateRowLanguages(row, script.value, null);
      dragHandle.setAttribute("aria-label", `Reorder ${this.typographyScriptLabel(row)} script`);
      this.updateTypographyAvailability();
    });
    font.addEventListener("change", () => this.updateTypographyAvailability());
    language.addEventListener("change", () => {
      if (language.value) {
        this.fallbackRows().forEach(other => {
          if (other === row || this.rowScript(other).value !== script.value) return;
          const otherLanguage = other.querySelector<HTMLSelectElement>("[data-fallback-language]");
          if (otherLanguage) otherLanguage.value = "";
        });
      }
      this.populateRowLanguages(row, script.value, language.value || null);
    });
    settingsButton.addEventListener("click", () => {
      this.closeTypographyModal();
      document.dispatchEvent(new CustomEvent("typsastra:open-settings", { detail: { panel: "editor" } }));
    });
    remove.addEventListener("click", () => {
      row.remove();
      this.updateTypographyAvailability();
    });
    dragHandle.addEventListener("keydown", event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      this.moveTypographyRow(row, event.key === "ArrowUp" ? -1 : 1);
    });
    dragHandle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragHandle.focus();
      this.draggedTypographyRow = row;
      this.typographyDragPointerId = event.pointerId;
      row.classList.add("is-dragging");
    });
    dragHandle.addEventListener("dragstart", event => event.preventDefault());
    return row;
  }

  private async refineFallbackCoverage(text: string): Promise<void> {
    const generation = ++this.coverageGeneration;
    await Promise.all(this.fallbackRows().map(async row => {
      const scriptId = this.rowScript(row).value;
      const script = typographyScripts.find(candidate => candidate.id === scriptId);
      if (!script) return;
      script.pattern.lastIndex = 0;
      const characters = [...new Set([...text.matchAll(script.pattern)].map(match => match[0]))].join("");
      if (!characters) return;
      const selected = row.querySelector<HTMLSelectElement>("[data-fallback-font]")?.value ?? "";
      try {
        const families = await invoke<string[]>("font_families_supporting_text", {
          families: this.systemFontFamilies,
          characters,
          workspaceRootPath: this.dependencies.getWorkspaceRoot()
        });
        if (generation !== this.coverageGeneration || !row.isConnected || this.rowScript(row).value !== scriptId) return;
        this.populateRowFonts(row, scriptId, selected, families);
        const hint = row.querySelector<HTMLElement>("[data-fallback-hint]");
        const selectedFamily = row.querySelector<HTMLSelectElement>("[data-fallback-font]")?.value ?? "";
        if (hint) hint.textContent = isTypstInternalOnlyFont(selectedFamily, this.systemFontFamilies)
          ? `${selectedFamily} is provided by the Typst compiler.`
          : families.length > 0
            ? `${families.length} installed font${families.length === 1 ? "" : "s"} cover every ${script.label} character used.`
            : `No installed font covers every ${script.label} character used.`;
      } catch (error) {
        console.warn(`Unable to inspect ${script.label} font coverage.`, error);
      }
    }));
  }

  private syncTypographyControls(): void {
    const text = this.dependencies.getEditor().state.doc.toString();
    const existing = parseTypographyBlock(text);
    const preferred = existing ?? this.rememberedTypography;
    const detected = detectTypographyScripts(text);
    const scripts = detected.length > 0 ? detected : [typographyScripts[0]];
    const fonts = preferred?.fonts ?? scripts.map(script => ({
      script: script.id,
      family: preferredInstalledFamily(script, this.supportedFonts(script.id)) ?? this.supportedFonts(script.id)[0] ?? "",
      scale: 1,
      language: null
    }));
    this.typographyDefaults = {
      baseSizePt: preferred?.baseSizePt ?? 11,
      fonts
    };
    this.setTypographyControl("toolbar-base-size", String(this.typographyDefaults.baseSizePt));
    this.fallbackContainer()?.replaceChildren(...fonts.map(font =>
      this.createFallbackRow(font, detected.some(script => script.id === font.script))
    ));
    void this.refineFallbackCoverage(text);
    this.updateTypographyAvailability();
  }

  private updateTypographyAvailability(): void {
    const baseSize = document.getElementById("toolbar-base-size") as HTMLInputElement | null;
    const apply = document.getElementById("toolbar-typography-apply") as HTMLButtonElement | null;
    const applyTemplate = document.getElementById("toolbar-typography-apply-template") as HTMLButtonElement | null;
    const hasFont = this.fallbackRows().some(row =>
      !!row.querySelector<HTMLSelectElement>("[data-fallback-font]")?.value
    );

    if (baseSize) baseSize.disabled = !hasFont;

    if (apply) {
      apply.disabled = !hasFont;
      if (applyTemplate) applyTemplate.disabled = apply.disabled;
    }
  }

  private setTypographyControl(id: string, value: string): void {
    const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!control) return;
    if (control instanceof HTMLSelectElement && ![...control.options].some(option => option.value === value)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      control.appendChild(option);
    }
    control.value = value;
  }

  private async applyDocumentTypography(target: "document" | "template"): Promise<void> {
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
    const fonts = this.fallbackRows().flatMap(row => {
      const family = row.querySelector<HTMLSelectElement>("[data-fallback-font]")?.value ?? "";
      if (!family) return [];
      return [{
        family,
        script: this.rowScript(row).value,
        scale: 1,
        language: row.querySelector<HTMLSelectElement>("[data-fallback-language]")?.value || null,
      }];
    });
    if (fonts.length === 0) return;
    const config: DocumentTypography = {
      baseSizePt: this.boundedTypographyNumber(value("toolbar-base-size"), 6, 96, this.typographyDefaults.baseSizePt),
      fonts
    };
    if (!await this.dependencies.applyTypography(config, target)) return;
    this.typographyDefaults = config;
    this.rememberedTypography = config;
    this.saveRememberedTypography(config);
    this.closeTypographyModal();
  }

  private loadRememberedTypography(): DocumentTypography | null {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(typographyChoiceStorageKey) ?? "null");
      if (!value || typeof value !== "object") return null;
      const candidate = value as Partial<DocumentTypography> & {
        primary?: { family?: string; script?: string } | null;
        embedded?: DocumentScriptFont[];
        latinFont?: string | null;
        latinSizePt?: number;
        fallbacks?: DocumentScriptFont[];
        complexFont?: string | null;
        complexScript?: string;
        complexScale?: number;
      };
      const baseSizePt = typeof candidate.baseSizePt === "number"
        ? candidate.baseSizePt
        : candidate.latinSizePt;
      if (typeof baseSizePt !== "number" || !Number.isFinite(baseSizePt)) return null;
      const storedFonts = Array.isArray(candidate.fonts) ? candidate.fonts : [];
      const legacyPrimary = candidate.primary && typeof candidate.primary.family === "string"
        && typeof candidate.primary.script === "string"
        ? [{ family: candidate.primary.family, script: candidate.primary.script, scale: 1, language: null }]
        : typeof candidate.latinFont === "string"
          ? [{ family: candidate.latinFont, script: "latin", scale: 1, language: null }]
          : [];
      const rawFallbacks = Array.isArray(candidate.embedded)
        ? candidate.embedded
        : Array.isArray(candidate.fallbacks)
          ? candidate.fallbacks
        : candidate.complexFont && candidate.complexScript
          ? [{ family: candidate.complexFont, script: candidate.complexScript, scale: candidate.complexScale ?? 1, language: null }]
          : [];
      const fonts = [...storedFonts, ...legacyPrimary, ...rawFallbacks].flatMap(font =>
        font && typeof font.family === "string"
          && typeof font.script === "string"
          && typographyScripts.some(script => script.id === font.script)
          ? [{
            family: font.family,
            script: font.script,
            scale: this.boundedTypographyNumber(String(font.scale), 0.5, 2, 1),
            language: "defaultText" in font && font.defaultText === false
              ? null
              : typeof font.language === "string" ? font.language : null,
            ...("defaultText" in font && font.defaultText === false ? { defaultText: false } : {}),
          }]
          : []
      );
      if (fonts.length === 0) return null;
      return {
        baseSizePt: this.boundedTypographyNumber(String(baseSizePt), 6, 96, 11),
        fonts
      };
    } catch {
      return null;
    }
  }

  private saveRememberedTypography(config: DocumentTypography): void {
    try {
      localStorage.setItem(typographyChoiceStorageKey, JSON.stringify(config));
    } catch {
      // Typography application should still work when browser storage is unavailable.
    }
  }

  private boundedTypographyNumber(value: string, min: number, max: number, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  private closeDropdowns(except?: Element): void {
    this.toolbar.querySelectorAll(".toolbar-dropdown-container.active").forEach(element => {
      if (element !== except) element.classList.remove("active");
    });
  }

  private async run(tool: string): Promise<void> {
    if (this.dependencies.getMode() === "WYSIWYM") {
      this.applyWysiwymTool(tool);
      const markup = this.dependencies.serializeWysiwym();
      const editor = this.dependencies.getEditor();
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: markup } });
      this.dependencies.renderWysiwym(markup);
      return;
    }

    const editor = this.dependencies.getEditor();
    if (wrappers[tool]) {
      this.wrapSelection(...wrappers[tool]);
      return;
    }
    if (snippets[tool]) {
      this.insertSnippet(snippets[tool]);
      return;
    }

    switch (tool) {
      case "save": await this.dependencies.save(); break;
      case "undo": undo(editor); break;
      case "redo": redo(editor); break;
      case "find-replace": openSearchPanel(editor); break;
      case "heading-1": this.applyHeading(1); break;
      case "heading-2": this.applyHeading(2); break;
      case "heading-3": this.applyHeading(3); break;
      case "bullet-list": this.applyLinePrefix("- "); break;
      case "numbered-list": this.applyLinePrefix("+ "); break;
      case "fraction": this.insertSnippet("$frac(1, 2)$", 6, 7); break;
      case "sqrt": this.insertSnippet("$sqrt(x)$", 6, 7); break;
      case "sync-preview":
        await this.dependencies.syncPreview(editor.state.selection.main.head);
        editor.focus();
        break;
      case "export-pdf": document.getElementById("action-export-pdf")?.click(); break;
      case "toggle-wrap": document.getElementById("word-wrap-toggle")?.click(); break;
      case "toggle-special-chars": document.getElementById("zws-toggle")?.click(); break;
      // TODO: Re-enable when the WYSIWYM layout is ready for use.
      // case "toggle-mode": this.dependencies.toggleMode(); break;
    }
  }

  private applyWysiwymTool(tool: string): void {
    const selection = window.getSelection();
    const container = this.dependencies.wysiwymContainer;
    let selectedBlock: HTMLElement | null = null;
    if (selection?.rangeCount && container.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      const anchor = selection.anchorNode!;
      const parent = (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor) as HTMLElement;
      selectedBlock = parent?.closest<HTMLElement>(".wysiwym-block") ?? null;
      const inlineWrappers: Record<string, [string, string, string]> = {
        bold: ["*", "*", "strong text"], italic: ["_", "_", "emphasized text"],
        underline: ["#underline[", "]", "text"], strikethrough: ["#strike[", "]", "text"],
        highlight: ["#highlight[", "]", "text"], "inline-code": ["`", "`", "code"],
        footnote: ["#footnote[", "]", "note"], label: ["<", ">", "label"], reference: ["@", "", "label"],
        "inline-math": ["$", "$", "x"], subscript: ["_", "", "sub"], superscript: ["^", "", "sup"]
      };
      if (inlineWrappers[tool]) {
        const [prefix, suffix, placeholder] = inlineWrappers[tool];
        const existing = this.findFormattingAncestor(anchor, `wysiwym-${tool}`, container);
        if (existing) this.unwrapFormatting(existing);
        else {
          const node = document.createTextNode(`${prefix}${range.toString() || placeholder}${suffix}`);
          range.deleteContents();
          range.insertNode(node);
        }
      } else if (selectedBlock) {
        this.applyWysiwymBlockTool(selectedBlock, tool);
      }
    }

    if (snippets[tool]) {
      const block = document.createElement("div");
      block.className = "wysiwym-block body";
      block.innerText = snippets[tool];
      if (selectedBlock?.parentNode) selectedBlock.parentNode.insertBefore(block, selectedBlock.nextSibling);
      else container.appendChild(block);
    }
  }

  private applyWysiwymBlockTool(block: HTMLElement, tool: string): void {
    const container = this.dependencies.wysiwymContainer;
    container.classList.add("serialize-mode");
    const text = block.innerText;
    container.classList.remove("serialize-mode");
    if (tool.startsWith("heading-")) {
      const level = Number(tool.split("-")[1]);
      const sameLevel = new RegExp(`^={${level}}\\s+`).test(text);
      block.innerText = sameLevel ? text.replace(/^=+\s*/, "") : `${"=".repeat(level)} ${text.replace(/^=+\s*/, "")}`;
    } else if (tool === "bullet-list") {
      block.innerText = text.startsWith("- ") ? text.replace(/^- \s*/, "") : `- ${text.replace(/^[-+]\s*/, "")}`;
    } else if (tool === "numbered-list") {
      block.innerText = text.startsWith("+ ") ? text.replace(/^\+ \s*/, "") : `+ ${text.replace(/^[-+]\s*/, "")}`;
    } else {
      const blocks: Record<string, [string, number]> = {
        "align-center": ["#align(center)[", 16], "align-right": ["#align(right)[", 15], blockquote: ["#quote(block: true)[", 21]
      };
      const wrapper = blocks[tool];
      if (wrapper) {
        const [prefix, contentStart] = wrapper;
        block.innerText = text.startsWith(`${prefix}\n`) && text.endsWith("\n]")
          ? text.substring(contentStart, text.length - 2).trim()
          : `${prefix}\n  ${text}\n]`;
      }
    }
  }

  private findFormattingAncestor(node: Node, className: string, boundary: HTMLElement): HTMLElement | null {
    let current: Node | null = node;
    while (current && current !== boundary) {
      if (current.nodeType === Node.ELEMENT_NODE && (current as HTMLElement).classList.contains(className)) return current as HTMLElement;
      current = current.parentNode;
    }
    return null;
  }

  private unwrapFormatting(element: HTMLElement): void {
    for (const sibling of [element.previousSibling, element.nextSibling]) {
      if (sibling?.nodeType === Node.ELEMENT_NODE && (sibling as HTMLElement).classList.contains("wysiwym-marker")) sibling.remove();
    }
    const parent = element.parentNode;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    element.remove();
  }

  private wrapSelection(prefix: string, suffix: string, placeholder: string): void {
    const editor = this.dependencies.getEditor();
    const state = editor.state;
    const transaction = state.changeByRange(range => {
      const selectedText = state.sliceDoc(range.from, range.to) || placeholder;
      const selectionFrom = range.from + prefix.length;
      return {
        changes: { from: range.from, to: range.to, insert: `${prefix}${selectedText}${suffix}` },
        range: EditorSelection.range(selectionFrom, selectionFrom + selectedText.length)
      };
    });
    editor.dispatch(transaction, { scrollIntoView: true, userEvent: "input" });
    editor.focus();
  }

  private insertSnippet(snippet: string, selectFrom?: number, selectTo?: number): void {
    const editor = this.dependencies.getEditor();
    const range = editor.state.selection.main;
    const selectionFrom = range.from + (selectFrom ?? snippet.length);
    editor.dispatch({
      changes: { from: range.from, to: range.to, insert: snippet },
      selection: { anchor: selectionFrom, head: range.from + (selectTo ?? selectFrom ?? snippet.length) },
      scrollIntoView: true,
      userEvent: "input"
    });
    editor.focus();
  }

  private applyHeading(level: number): void {
    const editor = this.dependencies.getEditor();
    const selection = editor.state.selection.main;
    const line = editor.state.doc.lineAt(selection.from);
    const prefix = `${"=".repeat(level)} `;
    const text = line.text.replace(/^=+\s*/, "");
    editor.dispatch({
      changes: { from: line.from, to: line.to, insert: `${prefix}${text}` },
      selection: { anchor: line.from + prefix.length, head: line.from + prefix.length + text.length },
      scrollIntoView: true,
      userEvent: "input"
    });
    editor.focus();
  }

  private applyLinePrefix(prefix: string): void {
    const editor = this.dependencies.getEditor();
    const selection = editor.state.selection.main;
    const start = editor.state.doc.lineAt(selection.from);
    const end = editor.state.doc.lineAt(selection.to > selection.from ? selection.to - 1 : selection.to);
    const changes = [];
    for (let lineNumber = start.number; lineNumber <= end.number; lineNumber++) {
      changes.push({ from: editor.state.doc.line(lineNumber).from, insert: prefix });
    }
    editor.dispatch({ changes, scrollIntoView: true, userEvent: "input" });
    editor.focus();
  }

  public setDisabled(disabled: boolean): void {
    if (disabled) {
      this.toolbar.classList.add("disabled");
      this.toolbar.querySelectorAll("button, select, input").forEach(el => {
        el.setAttribute("disabled", "true");
      });
    } else {
      this.toolbar.classList.remove("disabled");
      this.toolbar.querySelectorAll("button, select, input").forEach(el => {
        el.removeAttribute("disabled");
      });
      this.updateTypographyAvailability();
    }
  }

  public synchronizeDocumentTypography(config: DocumentTypography): void {
    const synchronized = {
      baseSizePt: config.baseSizePt,
      fonts: config.fonts.map(font => ({ ...font }))
    };
    this.typographyDefaults = synchronized;
    this.rememberedTypography = synchronized;
    this.saveRememberedTypography(synchronized);
    this.setTypographyControl("toolbar-base-size", String(synchronized.baseSizePt));
    const text = this.dependencies.getEditor().state.doc.toString();
    const detected = detectTypographyScripts(text);
    this.fallbackContainer()?.replaceChildren(...synchronized.fonts.map(font =>
      this.createFallbackRow(font, detected.some(script => script.id === font.script))
    ));
    void this.refineFallbackCoverage(text);
    this.updateTypographyAvailability();
  }
}
