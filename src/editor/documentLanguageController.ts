import { invoke } from "@tauri-apps/api/core";
import type { LanguageCatalogCapabilities } from "../languageSupport";
import type { DocumentOutlineController } from "../outline/documentOutline";
import { filePathKey } from "../platform/paths";
import {
  parseLegacyDocumentLanguages,
  type DocumentTypography,
} from "./documentTypography";
import type { EditorTab } from "./editorTab";
import type {
  DocumentLanguageService,
  ScriptLanguageAssignment,
} from "./languageScopes";
import type { SpellcheckController } from "./spellcheck";

export interface DocumentLanguageDependencies {
  languageService(): DocumentLanguageService;
  spellcheck(): SpellcheckController;
  outline(): DocumentOutlineController;
  activeFilePath(): string | null;
  pinnedMainFilePath(): string | null;
  previewImported(): boolean;
  isPinnedMainFile(path: string): boolean;
  editorText(): string;
  workspaceRootPath(): string | null;
  activeTab(): EditorTab | null;
  editorCursorPosition(): number;
  scriptLanguages(): readonly ScriptLanguageAssignment[];
  migrateLegacyLanguages(assignments: readonly ScriptLanguageAssignment[]): void;
}

/** Owns project language-tool routing and debounced outline updates. */
export class DocumentLanguageController {
  // Retained while typography lifecycle ownership is being simplified. This
  // value no longer participates in language routing.
  private mainDocumentScriptsValue: DocumentTypography["fonts"] = [];
  private languageCatalogValue: LanguageCatalogCapabilities[] = [];
  private outlineUpdateTimer: number | null = null;
  private outlineUpdateGeneration = 0;

  constructor(private readonly deps: DocumentLanguageDependencies) {}

  get mainDocumentScripts(): DocumentTypography["fonts"] {
    return this.mainDocumentScriptsValue;
  }

  set mainDocumentScripts(value: DocumentTypography["fonts"]) {
    this.mainDocumentScriptsValue = value;
  }

  get languageCatalog(): readonly LanguageCatalogCapabilities[] {
    return this.languageCatalogValue;
  }

  setLanguageCatalog(catalog: readonly LanguageCatalogCapabilities[]): void {
    this.languageCatalogValue = catalog.map((entry) => ({ ...entry, scripts: [...entry.scripts] }));
    this.applyConfiguration();
  }

  configure(text: string): void {
    if (this.deps.scriptLanguages().length === 0) {
      const activePath = this.deps.activeFilePath();
      const mainPath = this.deps.pinnedMainFilePath();
      const ownsConfiguration = !mainPath || (activePath !== null && this.deps.isPinnedMainFile(activePath));
      const legacy = ownsConfiguration ? parseLegacyDocumentLanguages(text) : [];
      if (legacy.length > 0) this.deps.migrateLegacyLanguages(legacy);
    }
    this.applyConfiguration();
  }

  refresh(): void {
    this.applyConfiguration();
  }

  activate(path: string | null): void {
    this.configure(path ? this.deps.editorText() : "");
    this.deps.spellcheck().activateDocument(path ? filePathKey(path) : "");
  }

  scheduleOutlineUpdate(path: string, delay = 180): void {
    if (this.outlineUpdateTimer !== null) window.clearTimeout(this.outlineUpdateTimer);
    const generation = ++this.outlineUpdateGeneration;
    this.outlineUpdateTimer = window.setTimeout(() => {
      this.outlineUpdateTimer = null;
      const activeTab = this.deps.activeTab();
      if (
        generation !== this.outlineUpdateGeneration
        || !activeTab
        || filePathKey(activeTab.path) !== filePathKey(path)
      ) return;
      void this.deps.outline().update(
        path,
        activeTab.content,
        this.deps.workspaceRootPath() || "",
        candidatePath => this.readWorkspaceFile(candidatePath),
      );
    }, delay);
  }

  updateOutlineNow(path: string, contents: string): void {
    void this.deps.outline().update(
      path,
      contents,
      this.deps.workspaceRootPath() || "",
      candidatePath => this.readWorkspaceFile(candidatePath),
    );
    this.deps.outline().setCursorPosition(
      this.deps.editorCursorPosition(),
      this.deps.activeFilePath(),
    );
  }

  clearOutline(): void {
    this.cancelOutlineUpdate();
    this.deps.outline().clear();
  }

  cancelOutlineUpdate(): void {
    this.outlineUpdateGeneration += 1;
    if (this.outlineUpdateTimer !== null) {
      window.clearTimeout(this.outlineUpdateTimer);
      this.outlineUpdateTimer = null;
    }
  }

  private applyConfiguration(): void {
    const assignments = this.deps.scriptLanguages();
    const providers = this.deps.spellcheck().getAllProviders();
    this.deps.languageService().configure(assignments, this.languageCatalogValue, providers);
    this.deps.spellcheck().setLanguageConfiguration(assignments, this.languageCatalogValue);
  }

  private async readWorkspaceFile(path: string): Promise<string | null> {
    try {
      return await invoke<string>("read_workspace_file", { path });
    } catch {
      return null;
    }
  }
}
