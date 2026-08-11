import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { typstLanguage } from "../editor/typstLanguage";

type FontCatalog = { documentAll: string[]; all: string[]; privateLocal: string[] };
type PreparedFontRecord = {
  family: string; alias: string; percent: number; sourceStatus: string;
  active: boolean; generatedAtMs: number | null;
};
type PreparedFontResult = { family: string; alias: string; scale: number; changed: boolean };
type VariantLimitWarning = { family: string; cachedVariants: number; requestedScale: number; recommendedLimit: number };
type ScaledFontSetStatus = { variantLimitWarnings: VariantLimitWarning[] };

const DEFAULT_SPECIMEN = `Font preparation specimen
The quick brown fox jumps over the lazy dog.
អក្សរខ្មែរសម្រាប់ប្រៀបធៀបមាត្រដ្ឋាន។`;

function preparedAlias(family: string, percent: number): string {
  return percent === 100 ? family : `${family} ${percent}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export class FontToolsController {
  private workspaceRoot: string | null = null;
  private catalog: FontCatalog | null = null;
  private library: PreparedFontRecord[] = [];
  private selectedFamily = "";
  private percent = 100;
  private query = "";
  private specimen: EditorView | null = null;
  private specimenSource = DEFAULT_SPECIMEN;
  private statusMessage = "";
  private previewTimer: number | null = null;
  private previewGeneration = 0;
  private visible = false;

  public constructor(
    private readonly sidebar: HTMLElement,
    private readonly inspector: HTMLElement,
    private readonly preview: HTMLElement,
    private readonly applyFont: (alias: string) => void,
    private readonly onActivationChanged: () => Promise<void>,
    private readonly addWorkspaceFontDirectory: () => Promise<void>,
    private readonly addGlobalFontDirectory: () => Promise<void>,
  ) {}

  public async setWorkspace(workspaceRoot: string | null): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    this.catalog = null;
    this.library = [];
    this.selectedFamily = "";
    this.statusMessage = "";
    this.destroySpecimen();
    this.renderSidebar();
    this.renderInspector();
    if (workspaceRoot && this.visible) await this.refresh();
  }

  public async refresh(): Promise<void> {
    if (!this.workspaceRoot) return;
    const root = this.workspaceRoot;
    try {
      const [catalog, library] = await Promise.all([
        invoke<FontCatalog>("list_system_fonts", { workspaceRootPath: root }),
        invoke<PreparedFontRecord[]>("prepared_font_library", { workspaceRootPath: root }),
      ]);
      if (this.workspaceRoot !== root) return;
      this.catalog = catalog;
      this.library = library;
      if (!this.selectedFamily) this.selectedFamily = catalog.documentAll?.[0] ?? catalog.all?.[0] ?? "";
      this.renderSidebar();
      this.renderInspector();
    } catch (error) {
      const message = escapeHtml(String(error));
      this.sidebar.innerHTML = `<div class="font-tool-empty">Could not load fonts: ${message}</div>`;
      this.inspector.innerHTML = `<div class="preview-disabled-placeholder"><div class="guardrail-placeholder-content"><div class="preview-disabled-title preview-accent-title">Font Tools unavailable</div><div class="preview-disabled-msg">${message}</div></div></div>`;
      this.renderPreviewMessage("Font Tools unavailable", String(error));
    }
  }

  public show(): void {
    this.visible = true;
    this.sidebar.classList.remove("hidden");
    this.inspector.classList.remove("hidden");
    this.preview.classList.remove("hidden");
    if (!this.catalog && this.workspaceRoot) void this.refresh();
    else this.renderInspector();
  }

  public hide(): void {
    this.visible = false;
    this.sidebar.classList.add("hidden");
    this.inspector.classList.add("hidden");
    this.preview.classList.add("hidden");
    this.destroySpecimen();
  }

  private sourceFamilies(): string[] {
    const families = this.catalog?.documentAll ?? this.catalog?.all ?? [];
    const preparedAliases = new Set(this.library.map(record => record.alias.toLocaleLowerCase()));
    return [...new Set(families)]
      .filter(family => !preparedAliases.has(family.toLocaleLowerCase()))
      .sort((left, right) => left.localeCompare(right));
  }

  private renderSidebar(): void {
    if (!this.workspaceRoot) {
      this.sidebar.innerHTML = `<div class="font-tool-empty">Open a project to prepare and activate fonts.</div>`;
      return;
    }
    if (!this.catalog) {
      this.sidebar.innerHTML = `<div class="font-tool-empty">Loading font library…</div>`;
      return;
    }
    const needle = this.query.trim().toLocaleLowerCase();
    const prepared = this.library.filter(record => !needle
      || record.alias.toLocaleLowerCase().includes(needle)
      || record.family.toLocaleLowerCase().includes(needle));
    const sources = this.sourceFamilies().filter(family => !needle || family.toLocaleLowerCase().includes(needle));
    this.sidebar.innerHTML = `
      <div class="font-tool-sidebar-controls"><input type="search" placeholder="Search fonts" aria-label="Search fonts" autocomplete="off" value="${escapeHtml(this.query)}"></div>
      <div class="font-tool-list" role="listbox" aria-label="Font library">
        <div class="font-tool-group-title">Prepared library</div>
        ${prepared.length ? prepared.map(record => `<button type="button" class="font-tool-item prepared ${record.active ? "active" : ""} ${record.sourceStatus !== "current" ? "attention" : ""}" data-alias="${escapeHtml(record.alias)}"><span>${escapeHtml(record.alias)}</span><small>${record.sourceStatus === "missing" ? "Missing · recreate required" : record.sourceStatus === "changed" ? "Source changed · renew recommended" : record.active ? "Active in project" : `${record.percent}% · machine-local`}</small></button>`).join("") : `<div class="font-tool-empty compact">No prepared fonts.</div>`}
        <div class="font-tool-group-title">Source fonts</div>
        ${sources.map(family => `<button type="button" class="font-tool-item ${family === this.selectedFamily ? "selected" : ""}" data-family="${escapeHtml(family)}"><span>${escapeHtml(family)}</span></button>`).join("")}
      </div>`;
    const search = this.sidebar.querySelector<HTMLInputElement>("input[type=search]")!;
    search.addEventListener("input", () => { this.query = search.value; this.renderSidebar(); });
    this.sidebar.querySelectorAll<HTMLElement>("[data-family]").forEach(button => button.addEventListener("click", () => {
      this.selectedFamily = button.dataset.family ?? "";
      this.percent = 100;
      this.statusMessage = "";
      this.renderSidebar();
      this.renderInspector();
    }));
    this.sidebar.querySelectorAll<HTMLElement>("[data-alias]").forEach(button => button.addEventListener("click", () => {
      const record = this.library.find(entry => entry.alias === button.dataset.alias);
      if (!record) return;
      this.selectedFamily = record.family;
      this.percent = record.percent;
      this.statusMessage = "";
      this.renderSidebar();
      this.renderInspector(record.alias);
    }));
  }

  private renderInspector(previewFamily?: string): void {
    this.destroySpecimen();
    if (!this.workspaceRoot || !this.catalog) {
      this.inspector.innerHTML = `<div class="preview-disabled-placeholder"><div class="guardrail-placeholder-content"><div class="preview-disabled-title preview-accent-title">Font Tools</div><div class="preview-disabled-msg">Select a source font to prepare a reusable scaled family.</div></div></div>`;
      this.renderPreviewMessage("Font Specimen", "Select a source font to compile a specimen.");
      return;
    }
    const families = this.sourceFamilies();
    if (!this.selectedFamily) this.selectedFamily = families[0] ?? "";
    const alias = previewFamily ?? preparedAlias(this.selectedFamily, this.percent);
    const current = this.library.find(record => record.alias.toLocaleLowerCase() === alias.toLocaleLowerCase());
    const warning = this.percent < 90 || this.percent > 110;
    this.inspector.innerHTML = `
      <div class="font-tool-inspector-content">
        <header class="font-tool-header"><div><h2>Prepare Font</h2><p>Create a named, machine-local font variant for precise visual adjustment.</p></div><div class="font-tool-folder-actions"><button type="button" data-action="add-workspace-fonts">Add workspace folder</button><button type="button" data-action="add-global-fonts">Add global folder</button></div></header>
        <div class="font-tool-form">
          <label>Source family<select data-field="family">${families.map(family => `<option ${family === this.selectedFamily ? "selected" : ""}>${escapeHtml(family)}</option>`).join("")}</select></label>
          <label>Scale (%)<input data-field="percent" type="number" min="50" max="200" step="1" value="${this.percent}"></label>
          <div class="font-tool-alias"><span>Prepared family</span><strong>${escapeHtml(alias)}</strong></div>
        </div>
        <div class="font-tool-scale-warning ${warning ? "" : "hidden"}">△ Scaling beyond ±10% is intended for exceptional cases. Accurate visual representation varies between font families.</div>
        <div class="font-tool-actions">
          <button type="button" data-action="prepare" class="primary" ${this.percent === 100 ? "disabled" : ""}>${current?.sourceStatus === "missing" ? "Recreate prepared font" : current ? "Renew prepared font" : "Prepare font"}</button>
          <button type="button" data-action="activate" ${!current ? "disabled" : ""}>${current?.active ? "Deactivate from project" : "Activate in project"}</button>
          <button type="button" data-action="apply">Apply to selection</button>
        </div>
        <div class="font-tool-output" aria-live="polite">${escapeHtml(this.statusMessage)}</div>
        <section class="font-tool-specimen-section"><h3>Typst specimen</h3><p>Edit this content fragment to compare the actual compiled glyphs.</p><div class="font-tool-specimen-editor"></div></section>
      </div>`;
    this.renderPreviewMessage("Font Specimen", `Compiling ${alias}…`);
    const familySelect = this.inspector.querySelector<HTMLSelectElement>("[data-field=family]")!;
    const percentInput = this.inspector.querySelector<HTMLInputElement>("[data-field=percent]")!;
    familySelect.addEventListener("change", () => {
      this.selectedFamily = familySelect.value; this.percent = 100; this.statusMessage = "";
      this.renderInspector(); this.renderSidebar();
    });
    percentInput.addEventListener("change", () => {
      this.percent = Math.max(50, Math.min(200, Math.round(Number(percentInput.value) || 100)));
      this.statusMessage = "";
      this.renderInspector();
    });
    this.inspector.querySelector<HTMLElement>("[data-action=prepare]")?.addEventListener("click", () => void this.prepare());
    this.inspector.querySelector<HTMLElement>("[data-action=activate]")?.addEventListener("click", () => void this.toggleActivation(alias));
    this.inspector.querySelector<HTMLElement>("[data-action=apply]")?.addEventListener("click", () => this.applyFont(alias));
    this.inspector.querySelector<HTMLElement>("[data-action=add-workspace-fonts]")?.addEventListener("click", () => void this.addFontDirectory("workspace"));
    this.inspector.querySelector<HTMLElement>("[data-action=add-global-fonts]")?.addEventListener("click", () => void this.addFontDirectory("global"));
    const parent = this.inspector.querySelector<HTMLElement>(".font-tool-specimen-editor")!;
    this.specimen = new EditorView({
      parent,
      state: EditorState.create({ doc: this.specimenSource, extensions: [
        history(), typstLanguage, keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return;
          this.specimenSource = update.state.doc.toString();
          this.schedulePreview(alias);
        }),
        EditorView.theme({ "&": { height: "150px" }, ".cm-scroller": { fontFamily: "var(--editor-code-font)", fontSize: "var(--editor-font-size)" } }),
      ] }),
    });
    this.schedulePreview(alias, 0);
  }

  private async prepare(): Promise<void> {
    if (!this.workspaceRoot || this.percent === 100) return;
    const output = this.inspector.querySelector<HTMLElement>(".font-tool-output");
    this.statusMessage = "Preparing named font…";
    if (output) output.textContent = this.statusMessage;
    try {
      const active = this.library.filter(record => record.active).map(record => ({
        family: record.family,
        scale: record.percent / 100,
      }));
      if (!active.some(font => font.family === this.selectedFamily && Math.round(font.scale * 100) === this.percent)) {
        active.push({ family: this.selectedFamily, scale: this.percent / 100 });
      }
      const status = await invoke<ScaledFontSetStatus>("scaled_workspace_font_set_status", {
        workspaceRootPath: this.workspaceRoot,
        fonts: active,
      });
      if (status.variantLimitWarnings.length > 0) {
        const warning = status.variantLimitWarnings[0]!;
        const accepted = await confirm(
          `${warning.family} already has ${warning.cachedVariants} prepared variants. Typsastra recommends keeping no more than ${warning.recommendedLimit} per font face.\n\nCreate ${preparedAlias(this.selectedFamily, this.percent)} anyway?`,
          { title: "Font Variant Cache Limit", kind: "warning", okLabel: "Create Variant", cancelLabel: "Cancel" },
        );
        if (!accepted) {
          this.statusMessage = "Font preparation cancelled.";
          if (output) output.textContent = this.statusMessage;
          return;
        }
      }
      const result = await invoke<PreparedFontResult>("prepare_named_workspace_font", {
        workspaceRootPath: this.workspaceRoot,
        request: { family: this.selectedFamily, percent: this.percent },
      });
      this.statusMessage = `${result.alias} is ready in the global prepared-font library.`;
      await this.refresh();
    } catch (error) {
      this.statusMessage = String(error);
      if (output) output.textContent = this.statusMessage;
    }
  }

  private async toggleActivation(alias: string): Promise<void> {
    if (!this.workspaceRoot) return;
    const selected = this.library.find(record => record.alias === alias);
    if (!selected) return;
    const active = this.library.filter(record => record.active && record.alias !== alias);
    if (!selected.active) active.push(selected);
    try {
      await invoke("activate_scaled_workspace_fonts", {
        workspaceRootPath: this.workspaceRoot,
        fonts: active.map(record => ({ family: record.family, scale: record.percent / 100 })),
      });
      await this.onActivationChanged();
      await this.refresh();
    } catch (error) {
      this.statusMessage = String(error);
      const output = this.inspector.querySelector<HTMLElement>(".font-tool-output");
      if (output) output.textContent = this.statusMessage;
    }
  }

  private schedulePreview(family: string, delay = 250): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => { this.previewTimer = null; void this.compilePreview(family); }, delay);
  }

  private async compilePreview(family: string): Promise<void> {
    if (!this.workspaceRoot || !this.specimen) return;
    const generation = ++this.previewGeneration;
    try {
      const svg = await invoke<string>("compile_font_specimen", {
        workspaceRootPath: this.workspaceRoot, family, content: this.specimen.state.doc.toString(),
      });
      if (generation !== this.previewGeneration) return;
      this.preview.innerHTML = `<div class="font-tool-preview-label">${escapeHtml(family)}</div><div class="font-tool-preview-document">${svg}</div>`;
    } catch (error) {
      if (generation !== this.previewGeneration) return;
      const previous = this.preview.querySelector("svg");
      if (!previous) this.preview.replaceChildren();
      const message = document.createElement("div");
      message.className = "font-tool-preview-error";
      message.textContent = String(error);
      this.preview.appendChild(message);
    }
  }

  private async addFontDirectory(scope: "workspace" | "global"): Promise<void> {
    try {
      if (scope === "workspace") await this.addWorkspaceFontDirectory();
      else await this.addGlobalFontDirectory();
      this.catalog = null;
      await this.refresh();
    } catch (error) {
      this.statusMessage = String(error);
      const output = this.inspector.querySelector<HTMLElement>(".font-tool-output");
      if (output) output.textContent = this.statusMessage;
    }
  }

  private renderPreviewMessage(title: string, message: string): void {
    this.preview.innerHTML = `<div class="preview-disabled-placeholder"><div class="guardrail-placeholder-content"><div class="preview-disabled-title preview-accent-title">${escapeHtml(title)}</div><div class="preview-disabled-msg">${escapeHtml(message)}</div></div></div>`;
  }

  private destroySpecimen(): void {
    this.previewGeneration += 1;
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.specimen?.destroy();
    this.specimen = null;
  }
}
