import { invoke } from "@tauri-apps/api/core";
import { basename, dirname, join } from "@tauri-apps/api/path";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-shell";
import { closeCompletion } from "@codemirror/autocomplete";
import { closeHoverTooltips, type EditorView } from "@codemirror/view";
import { selectAll, toggleLineComment } from "@codemirror/commands";
import type { WorkspaceExplorer } from "./explorer";
import type { SpellingIssue } from "../editor/spellcheck";
import {
  filterSurroundWithOptions,
  surroundEditorRange,
  SURROUND_WITH_OPTIONS,
  type SurroundWithOption,
} from "../editor/surroundWith";
import { applyShortcutLabels } from "../platform/shortcuts";
import { isTypstDocumentPath } from "../platform/fileTypes";
import type { PreviewColorMode } from "../settings";

export type ContextMenuDependencies = {
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  getEditor: () => EditorView;
  getExplorer: () => WorkspaceExplorer;
  getExplorerForElement?: (element: HTMLElement) => WorkspaceExplorer | null;
  refreshSecondaryExplorer?: () => void | Promise<void>;
  getPreviewFrame: () => HTMLIFrameElement | null;
  getPreviewColorMode: () => PreviewColorMode;
  setPreviewColorMode: (mode: PreviewColorMode) => void;
  loadFile: (path: string) => void | Promise<void>;
  save: () => void | Promise<void>;
  renameWorkspacePath: (oldPath: string, newPath: string, updateImageReferences?: boolean) => void | Promise<void>;
  closeTab: (path: string) => void | Promise<void>;
  closeTabInteractive: (path: string) => void | Promise<void>;
  closeOtherTabs: (path: string) => void | Promise<void>;
  restartWorkspace: () => void | Promise<void>;
  getSpellingIssue: (x: number, y: number, target?: HTMLElement) => SpellingIssue | null;
  getSpellingIssuesInRange: (from: number, to: number) => SpellingIssue[];
  getSpellingSuggestions: (issue: SpellingIssue) => Promise<string[]>;
  replaceSpelling: (issue: SpellingIssue, replacement: string) => void;
  addSpellingToDictionary: (words: readonly string[]) => void;
  addSpellingTerminology: (issue: SpellingIssue, scope: "global" | "project" | "languageFamily") => void;
  setSpellingIgnored: (issue: SpellingIssue, ignored: boolean) => void;
  isPinnedMainFile: (path: string) => boolean;
  setPinnedMainFile: (path: string | null) => void | Promise<void>;
  getPinnedMainFile: () => string | null;
  canRevealCursorInPreview: () => boolean;
  revealCursorInPreview: () => void;
  getSurroundWithOptions?: () => readonly SurroundWithOption[];
};

export function explorerKeyboardAction(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): "copy" | "paste" | "delete" | "rename" | null {
  const commandModifier = (event.ctrlKey || event.metaKey) && !event.altKey;
  const key = event.key.toLowerCase();
  if (commandModifier && !event.shiftKey && key === "c") return "copy";
  if (commandModifier && !event.shiftKey && key === "v") return "paste";
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === "Delete") return "delete";
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === "F2") return "rename";
  return null;
}

export function isMainFileCandidate(path: string, isDirectory = false): boolean {
  return !isDirectory && path.toLowerCase().endsWith(".typ");
}

export function duplicateFileName(name: string): string {
  const extensionIndex = name.lastIndexOf(".");
  return extensionIndex > 0
    ? `${name.slice(0, extensionIndex)} copy${name.slice(extensionIndex)}`
    : `${name} copy`;
}

export function deleteConfirmationMessage(name: string, isDirectory: boolean): string {
  const kind = isDirectory ? "folder" : "file";
  const consequence = isDirectory
    ? "It and its contents will be moved to the Trash."
    : "It will be moved to the Trash.";
  return `Are you sure you want to delete the ${kind} "${name}"? ${consequence}`;
}

export function dictionaryWordsForSelection(
  selectedText: string,
  issues: readonly Pick<SpellingIssue, "word">[],
): string[] {
  if (issues.length === 0) return [];
  const selectedWord = selectedText.trim();
  if (selectedWord && !/\s/u.test(selectedWord)) return [selectedWord];
  return [...new Set(issues.map(issue => issue.word).filter(Boolean))];
}

export class ContextMenuController {
  private targetPath = "";
  private targetIsDirectory = false;
  private copiedFilePath: string | null = null;
  private textControl: HTMLInputElement | HTMLTextAreaElement | null = null;
  private selectedText = "";
  private contextText = "";
  private readonly menu = document.getElementById("context-menu")!;
  private spellingIssue: SpellingIssue | null = null;
  private spellingDictionaryWords: string[] = [];
  private spellingSuggestions: string[] = [];
  private contextMenuOpenedFromExplorer = false;
  private contextExplorer: WorkspaceExplorer | null = null;
  private surroundSelection: { from: number; to: number } | null = null;
  private surroundSelectionIndex = 0;
  private readonly surroundOverlay = document.getElementById("surround-with-overlay");
  private readonly surroundSearch = document.getElementById("surround-with-search") as HTMLInputElement | null;
  private readonly surroundList = document.getElementById("surround-with-list");

  constructor(private readonly dependencies: ContextMenuDependencies) {}

  public initialize(): void {
    document.addEventListener("click", () => this.hide());
    this.menu.addEventListener("click", event => {
      const submenuTrigger = (event.target as HTMLElement)
        .closest<HTMLElement>(".dropdown-submenu-trigger");
      if (submenuTrigger) {
        event.preventDefault();
        event.stopPropagation();
        const submenu = submenuTrigger.nextElementSibling as HTMLElement | null;
        const expanded = !submenu?.classList.contains("submenu-open");
        submenu?.classList.toggle("submenu-open", expanded);
        submenuTrigger.setAttribute("aria-expanded", String(expanded));
        if (expanded) {
          submenu?.querySelector<HTMLElement>(".dropdown-item")?.focus();
        }
        return;
      }
      const action = (event.target as HTMLElement).closest<HTMLElement>(".dropdown-item")?.id;
      if (action) {
        const restoreExplorerFocus = this.contextMenuOpenedFromExplorer;
        void this.execute(action).finally(() => {
          if (restoreExplorerFocus) (this.contextExplorer ?? this.dependencies.getExplorer()).focus();
        });
      }
    });
    document.addEventListener("contextmenu", event => void this.showForTarget(event));
    this.surroundSearch?.addEventListener("input", () => {
      this.surroundSelectionIndex = 0;
      this.renderSurroundWithOptions();
    });
    this.surroundSearch?.addEventListener("keydown", event => this.handleSurroundWithKeydown(event));
    document.getElementById("surround-with-close")?.addEventListener("click", () => this.closeSurroundWith());
    this.surroundOverlay?.addEventListener("click", event => {
      if (event.target === this.surroundOverlay) this.closeSurroundWith();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !this.surroundOverlay?.classList.contains("hidden")) {
        event.preventDefault();
        this.closeSurroundWith();
      }
    });
    this.menu.addEventListener("keydown", event => this.handleContextMenuKeydown(event));
    document.getElementById("preview-menu-btn")?.addEventListener("click", event => {
      event.stopPropagation();
      if (this.menu.style.display === "block" && this.menu.dataset.menuKind === "preview") {
        this.hide();
        return;
      }
      const button = event.currentTarget as HTMLElement;
      const rect = button.getBoundingClientRect();
      this.show(this.previewItems(), rect.right, rect.bottom + 4, true, "preview");
    });
    window.addEventListener("message", event => this.handlePreviewMessage(event));
    document.getElementById("workspace-explorer-tree")?.addEventListener("keydown", event => {
      void this.handleExplorerKeydown(event);
    });
  }

  private previewItems(): string {
    const available = (id: string): boolean => {
      const element = document.getElementById(id) as HTMLButtonElement | null;
      return Boolean(element && !element.classList.contains("hidden") && !element.disabled);
    };
    const typstActions = [
      this.dependencies.canRevealCursorInPreview()
        ? '<div class="dropdown-item" id="ctx-preview-forward-sync">Reveal Cursor in Preview</div>'
        : "",
      available("preview-recompile-btn")
        ? '<div class="dropdown-item" id="ctx-preview-recompile">Recompile Preview</div>'
        : ""
    ].filter(Boolean).join("");
    const typstSeparator = typstActions ? '<div class="dropdown-separator"></div>' : "";
    const exportAction = isTypstDocumentPath(this.dependencies.getActiveFile() ?? "")
      ? '<div class="dropdown-item" id="ctx-export-pdf">Export PDF</div>'
      : "";
    const colorMode = this.dependencies.getPreviewColorMode();
    const colorItem = (mode: PreviewColorMode, label: string) => `
      <div class="dropdown-item preview-color-mode-item" id="ctx-preview-color-${mode}" role="menuitemradio" aria-checked="${colorMode === mode}">
        <span>${label}</span><span class="preview-color-mode-check" aria-hidden="true">${colorMode === mode ? "✓" : ""}</span>
      </div>`;
    return `
      <div class="dropdown-item" id="ctx-preview-zoom-out">Zoom Out</div>
      <div class="dropdown-item" id="ctx-preview-zoom-fit">Fit to Width</div>
      <div class="dropdown-item" id="ctx-preview-zoom-in">Zoom In</div>
      <div class="dropdown-separator"></div>
      <div class="dropdown-submenu">
        <div class="dropdown-item dropdown-submenu-trigger" role="menuitem" tabindex="0" aria-haspopup="menu" aria-expanded="false">
          <span>Preview colors</span><span class="dropdown-submenu-arrow" aria-hidden="true">›</span>
        </div>
        <div class="dropdown-submenu-menu context-preview-color-submenu-menu" role="menu">
          ${colorItem("document", "Document colors")}
          ${colorItem("dark", "Dark preview")}
          ${colorItem("inverted", "Inverted preview (experimental)")}
        </div>
      </div>
      <div class="dropdown-separator"></div>
      ${typstActions}
      ${typstSeparator}
      ${exportAction}
      <div class="dropdown-item" id="ctx-preview-open-external">Open in External Viewer</div>
      <div class="dropdown-item" id="ctx-preview-undock">Undock Preview</div>`;
  }

  private async handleExplorerKeydown(event: KeyboardEvent): Promise<void> {
    if ((event.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) return;
    const action = explorerKeyboardAction(event);
    if (!action || event.repeat) return;
    const selection = this.dependencies.getExplorer().selectedEntry();
    if (action !== "paste" && !selection) return;
    if (action === "paste" && !this.copiedFilePath) return;

    this.targetPath = selection?.path ?? this.dependencies.getWorkspaceRoot() ?? "";
    this.targetIsDirectory = selection?.isDirectory ?? true;
    event.preventDefault();
    event.stopPropagation();

    try {
      if (action === "copy") await this.execute("ctx-fs-copy");
      else if (action === "paste") await this.execute("ctx-fs-paste");
      else if (action === "rename") await this.execute("ctx-fs-rename");
      else await this.execute("ctx-fs-delete");
    } finally {
      this.dependencies.getExplorer().focus();
    }
  }

  private async execute(action: string): Promise<void> {
    switch (action) {
      case "ctx-new-file": return this.createFile();
      case "ctx-fs-new-folder": return this.createFolder();
      case "ctx-fs-rename": return this.renameTarget();
      case "ctx-fs-delete": return this.deleteTarget();
      case "ctx-fs-duplicate": return this.duplicateFile();
      case "ctx-fs-paste": return this.pasteFile();
      case "ctx-open-project": document.getElementById("action-open-folder")?.click(); return;
      case "ctx-set-main-file":
        if (isMainFileCandidate(this.targetPath, this.targetIsDirectory)) {
          const isCurrentMain = this.dependencies.isPinnedMainFile(this.targetPath);
          await this.dependencies.setPinnedMainFile(isCurrentMain ? null : this.targetPath);
        }
        return;
      case "ctx-export-pdf": document.getElementById("action-export-pdf")?.click(); return;
      case "ctx-copy-text": return this.copyEditorText(false);
      case "ctx-cut-text": return this.copyEditorText(true);
      case "ctx-paste-text": return this.pasteText();
      case "ctx-native-copy": return this.copyNativeText();
      case "ctx-native-cut": return this.cutNativeText();
      case "ctx-native-paste": return this.pasteNativeText();
      case "ctx-native-select-all": this.selectAllNativeText(); return;
      case "ctx-undo": document.getElementById("action-undo")?.click(); return;
      case "ctx-redo": document.getElementById("action-redo")?.click(); return;
      case "ctx-editor-toggle-comment": toggleLineComment(this.dependencies.getEditor()); return;
      case "ctx-editor-select-all": selectAll(this.dependencies.getEditor()); return;
      case "ctx-editor-format": await this.dependencies.save(); return;
      case "ctx-editor-forward-sync":
        if (this.dependencies.canRevealCursorInPreview()) {
          this.dependencies.revealCursorInPreview();
        }
        return;
      case "ctx-editor-surround-with": this.openSurroundWith(); return;
      case "ctx-spelling-add":
        if (this.spellingDictionaryWords.length > 0) {
          this.dependencies.addSpellingToDictionary(this.spellingDictionaryWords);
        }
        return;
      case "ctx-spelling-add-global":
      case "ctx-spelling-add-project":
      case "ctx-spelling-add-language":
        if (this.spellingIssue) {
          const scope = action.endsWith("global") ? "global"
            : action.endsWith("project") ? "project" : "languageFamily";
          this.dependencies.addSpellingTerminology(this.spellingIssue, scope);
        }
        return;
      case "ctx-spelling-ignore":
        if (this.spellingIssue) this.dependencies.setSpellingIgnored(this.spellingIssue, !this.spellingIssue.ignored);
        return;
      case "ctx-fs-copy":
        if (this.targetIsDirectory) alert("Copying directories directly is not yet supported.");
        else this.copiedFilePath = this.targetPath;
        return;
      case "ctx-fs-reveal": if (this.targetPath) await invoke("reveal_in_explorer", { path: this.targetPath }); return;
      case "ctx-fs-copy-rel-path": return this.copyRelativePath();
      case "ctx-fs-copy-abs-path": if (this.targetPath) await writeText(this.targetPath); return;
      case "ctx-project-reveal": return this.revealProjectFolder();
      case "ctx-project-copy-abs-path": return this.copyProjectAbsolutePath();
      case "ctx-preview-open-external": return this.openPreviewPdf();
      case "ctx-preview-undock": document.getElementById("undock-preview-btn")?.click(); return;
      case "ctx-preview-forward-sync": this.dependencies.revealCursorInPreview(); return;
      case "ctx-preview-recompile": document.getElementById("preview-recompile-btn")?.click(); return;
      case "ctx-preview-zoom-out": document.getElementById("preview-zoom-out-btn")?.click(); return;
      case "ctx-preview-zoom-fit": document.getElementById("preview-zoom-fit-btn")?.click(); return;
      case "ctx-preview-zoom-in": document.getElementById("preview-zoom-in-btn")?.click(); return;
      case "ctx-preview-color-document": this.dependencies.setPreviewColorMode("document"); return;
      case "ctx-preview-color-dark": this.dependencies.setPreviewColorMode("dark"); return;
      case "ctx-preview-color-inverted": this.dependencies.setPreviewColorMode("inverted"); return;
      case "ctx-tab-close": if (this.targetPath) await this.dependencies.closeTabInteractive(this.targetPath); return;
      case "ctx-tab-close-others": if (this.targetPath) await this.dependencies.closeOtherTabs(this.targetPath); return;
      case "ctx-restart-workspace": await this.dependencies.restartWorkspace(); return;
      default:
        if (action.startsWith("ctx-spelling-") && this.spellingIssue) {
          const index = Number(action.slice("ctx-spelling-".length));
          const replacement = this.spellingSuggestions[index];
          if (replacement) this.dependencies.replaceSpelling(this.spellingIssue, replacement);
        }
        return;
    }
  }

  private createFile(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (!workspace) {
      document.getElementById("action-new-file")?.click();
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.dependencies.getExplorer().showInlineInput(this.targetPath, "file", "", async name => {
        if (name) {
          try {
            const path = await join(await this.parentDirectory(workspace), name);
            await invoke("save_workspace_file", { path, contents: "" });
            await this.refreshExplorer();
            await this.dependencies.loadFile(path);
          } catch (error) { alert(`Failed to create file: ${error}`); }
        }
        resolve();
      });
    });
  }

  private createFolder(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (!workspace) return Promise.resolve();
    return new Promise(resolve => {
      this.dependencies.getExplorer().showInlineInput(this.targetPath, "folder", "", async name => {
        if (name) {
          try {
            await invoke("create_workspace_dir", { path: await join(await this.parentDirectory(workspace), name) });
            await this.refreshExplorer();
          } catch (error) { alert(`Failed to create folder: ${error}`); }
        }
        resolve();
      });
    });
  }

  private async renameTarget(): Promise<void> {
    if (!this.targetPath) return;
    const originalPath = this.targetPath;
    const oldName = await basename(originalPath);
    await new Promise<void>(resolve => {
      (this.contextExplorer ?? this.dependencies.getExplorer()).showInlineInput(originalPath, "rename", oldName, async newName => {
        if (newName && newName !== oldName) {
          const newPath = await join(await dirname(originalPath), newName);
          try {
            const updateImageReferences = !this.targetIsDirectory
              && Boolean(this.contextExplorer)
              && this.contextExplorer !== this.dependencies.getExplorer();
            await this.dependencies.renameWorkspacePath(originalPath, newPath, updateImageReferences);
            await this.refreshExplorer();
          } catch (error) { alert(`Failed to rename: ${error}`); }
        }
        resolve();
      });
    });
  }

  private async deleteTarget(): Promise<void> {
    if (!this.targetPath) return;
    const path = this.targetPath;

    const mainFilePath = this.dependencies.getPinnedMainFile();
    if (mainFilePath) {
      const mainKey = mainFilePath.toLowerCase().replace(/\\/g, "/");
      const targetKey = path.toLowerCase().replace(/\\/g, "/");
      if (mainKey === targetKey || (this.targetIsDirectory && mainKey.startsWith(targetKey + "/"))) {
        await message(`The active main document cannot be deleted.`, {
          title: "Delete Blocked",
          kind: "error"
        });
        return;
      }
    }

    const accepted = await confirm(deleteConfirmationMessage(await basename(path), this.targetIsDirectory), {
      title: "Confirm Delete", kind: "warning"
    });
    if (!accepted) return;
    try {
      await invoke("move_to_trash", { path });
      await this.refreshExplorer();
      await this.dependencies.closeTab(path);
    } catch (error) { alert(`Failed to move to trash: ${error}`); }
  }

  private async pasteFile(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (!workspace || !this.copiedFilePath) return;
    try {
      const destination = await join(await this.parentDirectory(workspace), `Copy of ${await basename(this.copiedFilePath)}`);
      await invoke("copy_workspace_file", { source: this.copiedFilePath, dest: destination });
      await this.refreshExplorer();
    } catch (error) { alert(`Failed to paste file: ${error}`); }
  }

  private async duplicateFile(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (!workspace || !this.targetPath || this.targetIsDirectory) return;
    const source = this.targetPath;
    const defaultName = duplicateFileName(await basename(source));
    await new Promise<void>(resolve => {
      this.dependencies.getExplorer().showInlineInput(source, "file", defaultName, async name => {
        if (name) {
          try {
            const destination = await join(await dirname(source), name);
            if (await invoke<boolean>("workspace_path_exists", { path: destination })) {
              alert(`A file named "${name}" already exists.`);
            } else {
              await invoke("copy_workspace_file", { source, dest: destination });
              await this.refreshExplorer();
              await this.dependencies.loadFile(destination);
            }
          } catch (error) {
            alert(`Failed to duplicate file: ${error}`);
          }
        }
        resolve();
      });
    });
  }

  private async pasteText(): Promise<void> {
    try {
      const editor = this.dependencies.getEditor();
      editor.dispatch(editor.state.replaceSelection(await readText()));
    } catch (error) { console.error("Failed to read clipboard:", error); }
  }

  private async copyEditorText(cut: boolean): Promise<void> {
    const editor = this.dependencies.getEditor();
    const selection = editor.state.selection.main;
    if (selection.empty) return;
    await writeText(editor.state.sliceDoc(selection.from, selection.to));
    if (cut) editor.dispatch(editor.state.replaceSelection(""));
    editor.focus();
  }

  private async copyNativeText(): Promise<void> {
    const text = this.selectedControlText() || this.selectedText || this.contextText;
    if (text) await writeText(text);
  }

  private async cutNativeText(): Promise<void> {
    const control = this.textControl;
    if (!control || control.readOnly || control.disabled) return;
    await this.copyNativeText();
    this.replaceControlSelection("");
  }

  private async pasteNativeText(): Promise<void> {
    const control = this.textControl;
    if (!control || control.readOnly || control.disabled) return;
    try {
      this.replaceControlSelection(await readText());
    } catch (error) {
      console.error("Failed to paste text:", error);
    }
  }

  private selectAllNativeText(): void {
    this.textControl?.select();
  }

  private selectedControlText(): string {
    const control = this.textControl;
    if (!control) return "";
    if (control.selectionStart === null || control.selectionEnd === null) return control.value;
    const start = control.selectionStart;
    const end = control.selectionEnd;
    return control.value.slice(start, end);
  }

  private replaceControlSelection(text: string): void {
    const control = this.textControl;
    if (!control) return;
    if (control.selectionStart === null || control.selectionEnd === null) {
      control.value = text;
      this.dispatchControlInput(control, text);
      return;
    }
    const start = control.selectionStart;
    const end = control.selectionEnd;
    control.setRangeText(text, start, end, "end");
    this.dispatchControlInput(control, text);
  }

  private dispatchControlInput(control: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    control.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: text,
      inputType: text ? "insertFromPaste" : "deleteByCut"
    }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    control.focus();
  }

  private async copyRelativePath(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (!workspace || !this.targetPath) return;
    const relative = this.targetPath.replace(workspace, "").replace(/^[\\/]/, "").replace(/\\/g, "/");
    await writeText(relative);
  }

  private async revealProjectFolder(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (workspace) await invoke("open_directory_in_explorer", { path: workspace });
  }

  private async copyProjectAbsolutePath(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (workspace) await writeText(workspace);
  }

  private async openPreviewPdf(): Promise<void> {
    const activeFile = this.dependencies.getActiveFile();
    if (!activeFile) return;
    const pdf = await join(await dirname(activeFile), (await basename(activeFile)).replace(/\.typ$/i, ".pdf"));
    await open(pdf);
  }

  private async parentDirectory(workspace: string): Promise<string> {
    if (!this.targetPath) return workspace;
    return this.targetIsDirectory ? this.targetPath : dirname(this.targetPath);
  }

  private async refreshExplorer(): Promise<void> {
    const workspace = this.dependencies.getWorkspaceRoot();
    if (workspace) await this.dependencies.getExplorer().loadWorkspace(workspace);
    await this.dependencies.refreshSecondaryExplorer?.();
  }

  private async showForTarget(event: MouseEvent): Promise<void> {
    const target = event.target as HTMLElement;
    this.contextMenuOpenedFromExplorer = false;
    this.contextExplorer = null;
    if (target.closest("#preview-container-wrapper")) {
      event.preventDefault();
      this.hide();
      return;
    }
    this.textControl = this.textControlFor(target);
    if (this.textControl) {
      event.preventDefault();
      this.show(this.nativeTextItems(!this.textControl.readOnly && !this.textControl.disabled), event.clientX, event.clientY);
      return;
    }

    const explorerItem = target.closest<HTMLElement>(".explorer-item-target");
    if (explorerItem) {
      this.contextMenuOpenedFromExplorer = true;
      const openedFromImageExplorer = Boolean(explorerItem.closest(".image-tool-list"));
      this.contextExplorer = this.dependencies.getExplorerForElement?.(explorerItem)
        ?? this.dependencies.getExplorer();
      this.targetPath = explorerItem.dataset.path || "";
      this.targetIsDirectory = explorerItem.dataset.isDir === "true";
      event.preventDefault();
      this.show(
        openedFromImageExplorer ? this.imageExplorerItems() : this.explorerItems(),
        event.clientX,
        event.clientY,
      );
      return;
    }
    if (target.closest(".workspace-explorer-section")) {
      this.contextMenuOpenedFromExplorer = true;
      this.targetPath = this.dependencies.getWorkspaceRoot() || "";
      this.targetIsDirectory = !!this.targetPath;
      event.preventDefault();
      this.show(this.explorerBackgroundItems(), event.clientX, event.clientY);
      return;
    }

    const editorTab = target.closest<HTMLElement>(".editor-tab");
    if (editorTab) {
      this.targetPath = editorTab.dataset.path || "";
      this.targetIsDirectory = false;
      event.preventDefault();
      this.show(this.tabItems(), event.clientX, event.clientY);
      return;
    }
    if (target.closest("#document-outline-section")) {
      this.hide();
      return;
    }
    if (target.closest(".cm-editor") || target.closest("#code-render-pane")) {
      // Cancel WebKitGTK's browser-owned spelling menu before any asynchronous
      // suggestion lookup. Calling preventDefault after the await is too late
      // in release builds and allows both menus to appear.
      event.preventDefault();
      const menuX = event.clientX;
      const menuY = event.clientY;
      const editor = this.dependencies.getEditor();
      closeCompletion(editor);
      editor.dispatch({ effects: closeHoverTooltips });
      this.spellingIssue = this.dependencies.getSpellingIssue(event.clientX, event.clientY, target);
      const selection = editor.state.selection.main;
      this.surroundSelection = selection.empty ? null : { from: selection.from, to: selection.to };
      const selectedIssues = selection.empty
        ? []
        : this.dependencies.getSpellingIssuesInRange(selection.from, selection.to);
      this.spellingDictionaryWords = selectedIssues.length > 0
        ? dictionaryWordsForSelection(editor.state.sliceDoc(selection.from, selection.to), selectedIssues)
        : this.spellingIssue ? [this.spellingIssue.word] : [];
      this.spellingSuggestions = this.spellingIssue
        ? await this.dependencies.getSpellingSuggestions(this.spellingIssue)
        : [];
      this.show(this.editorItems(), menuX, menuY);
      return;
    }

    const selection = window.getSelection();
    this.selectedText = selection?.toString() ?? "";
    const logEntry = target.closest<HTMLElement>(".log-entry");
    this.contextText = logEntry?.querySelector<HTMLElement>(".log-entry-message")?.textContent ?? "";
    if (logEntry && selection?.anchorNode && !logEntry.contains(selection.anchorNode)) this.selectedText = "";
    if (this.contextText || this.selectedText) {
      event.preventDefault();
      this.show(this.nativeTextItems(false), event.clientX, event.clientY);
      return;
    }

    this.hide();
  }

  private show(
    items: string,
    x: number,
    y: number,
    alignRight = false,
    menuKind = ""
  ): void {
    this.menu.innerHTML = items;
    this.menu.dataset.menuKind = menuKind;
    this.menu.style.display = "block";
    applyShortcutLabels(this.menu);
    const rect = this.menu.getBoundingClientRect();
    if (alignRight) x -= rect.width;
    this.menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width))}px`;
    this.menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height))}px`;
    this.menu.querySelectorAll<HTMLElement>(".dropdown-submenu-menu").forEach(submenu => {
      submenu.classList.toggle("dropdown-submenu-menu-left", x + rect.width + 360 > window.innerWidth);
    });
  }

  private hide(): void {
    this.menu.style.display = "none";
    this.menu.querySelectorAll<HTMLElement>(".submenu-open")
      .forEach(submenu => submenu.classList.remove("submenu-open"));
    delete this.menu.dataset.menuKind;
  }

  private handleContextMenuKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    const trigger = target.closest<HTMLElement>(".dropdown-submenu-trigger");
    const submenu = target.closest<HTMLElement>(".dropdown-submenu-menu");
    if (trigger && ["ArrowRight", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const menu = trigger.nextElementSibling as HTMLElement | null;
      menu?.classList.add("submenu-open");
      trigger.setAttribute("aria-expanded", "true");
      menu?.querySelector<HTMLElement>(".dropdown-item")?.focus();
      return;
    }
    if (!submenu) return;
    const items = [...submenu.querySelectorAll<HTMLElement>(".dropdown-item:not(.dropdown-item-disabled)")];
    const currentIndex = items.indexOf(target.closest<HTMLElement>(".dropdown-item")!);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!items.length) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      items[(Math.max(0, currentIndex) + delta + items.length) % items.length].focus();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      submenu.classList.remove("submenu-open");
      const owner = submenu.previousElementSibling as HTMLElement | null;
      owner?.setAttribute("aria-expanded", "false");
      owner?.focus();
    }
  }

  private textControlFor(target: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
    const control = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    if (!control) return null;
    if (control instanceof HTMLTextAreaElement) return control;
    return ["text", "search", "url", "tel", "email", "password", "number"].includes(control.type)
      ? control
      : null;
  }

  private handlePreviewMessage(event: MessageEvent): void {
    const data = event.data as { type?: unknown; x?: unknown; y?: unknown } | null;
    if (data?.type === "HIDE_CONTEXT_MENU" || data?.type === "SHOW_PREVIEW_CONTEXT_MENU") {
      this.hide();
    }
  }

  private explorerItems(): string {
    const mainAction = this.mainFileItem();
    return `${mainAction}<div class="dropdown-item" id="ctx-new-file">New File <span class="hotkey" data-shortcut="Mod+N">Ctrl+N</span></div><div class="dropdown-item" id="ctx-fs-new-folder">New Folder</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-rename">Rename <span class="hotkey">F2</span></div><div class="dropdown-item" id="ctx-fs-delete">Delete <span class="hotkey">Delete</span></div>${this.targetIsDirectory ? "" : '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-duplicate">Duplicate File</div><div class="dropdown-item" id="ctx-fs-copy">Copy File <span class="hotkey" data-shortcut="Mod+C">Ctrl+C</span></div>'}${this.copiedFilePath ? '<div class="dropdown-item" id="ctx-fs-paste">Paste File <span class="hotkey" data-shortcut="Mod+V">Ctrl+V</span></div>' : ""}<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-reveal">Reveal in System Explorer</div><div class="dropdown-item" id="ctx-fs-copy-rel-path">Copy Relative Path</div><div class="dropdown-item" id="ctx-fs-copy-abs-path">Copy Absolute Path</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-open-project">Open Project <span class="hotkey" data-shortcut="Mod+O">Ctrl+O</span></div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-restart-workspace">Restart Workspace</div>`;
  }

  private imageExplorerItems(): string {
    return `<div class="dropdown-item" id="ctx-fs-rename">Rename <span class="hotkey">F2</span></div><div class="dropdown-item" id="ctx-fs-delete">Delete <span class="hotkey">Delete</span></div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-reveal">Reveal in System Explorer</div><div class="dropdown-item" id="ctx-fs-copy-rel-path">Copy Relative Path</div><div class="dropdown-item" id="ctx-fs-copy-abs-path">Copy Absolute Path</div>`;
  }

  private explorerBackgroundItems(): string {
    return `<div class="dropdown-item" id="ctx-new-file">New File <span class="hotkey" data-shortcut="Mod+N">Ctrl+N</span></div><div class="dropdown-item" id="ctx-fs-new-folder">New Folder</div>${this.copiedFilePath ? '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-paste">Paste File <span class="hotkey" data-shortcut="Mod+V">Ctrl+V</span></div>' : ""}<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-reveal">Reveal Workspace in Explorer</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-open-project">Open Project <span class="hotkey" data-shortcut="Mod+O">Ctrl+O</span></div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-restart-workspace">Restart Workspace</div>`;
  }

  private tabItems(): string {
    return `${this.mainFileItem()}<div class="dropdown-item" id="ctx-tab-close">Close</div><div class="dropdown-item" id="ctx-tab-close-others">Close Others</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-copy-rel-path">Copy Relative Path</div><div class="dropdown-item" id="ctx-fs-copy-abs-path">Copy Absolute Path</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-fs-reveal">Reveal in System Explorer</div>`;
  }

  private mainFileItem(): string {
    if (!isMainFileCandidate(this.targetPath, this.targetIsDirectory)) return "";
    const label = this.dependencies.isPinnedMainFile(this.targetPath)
      ? "Unset as Main File"
      : "Set as Main File";
    return `<div class="dropdown-item" id="ctx-set-main-file">${label}</div><div class="dropdown-separator"></div>`;
  }

  private editorItems(): string {
    const dictionary = this.spellingDictionaryWords.length === 1
      ? `<div class="dropdown-item" id="ctx-spelling-add">Add “${this.escapeHtml(this.spellingDictionaryWords[0])}” to user dictionary</div>`
      : this.spellingDictionaryWords.length > 1
        ? `<div class="dropdown-item" id="ctx-spelling-add">Add ${this.spellingDictionaryWords.length} misspelled words to user dictionary</div>`
        : "";
    const suggestionActions = this.spellingIssue
      ? this.spellingSuggestions.map((suggestion, index) => `<div class="dropdown-item spelling-suggestion" id="ctx-spelling-${index}">${this.escapeHtml(suggestion)}</div>`).join("")
      : "";
    const dictionaryActions = this.spellingIssue
      ? `${dictionary}${this.spellingIssue.languageFamily ? `<div class="dropdown-item" id="ctx-spelling-add-language">Add to ${this.escapeHtml(this.spellingIssue.languageFamily)} dictionary</div>` : ""}`
      : dictionary;
    const terminologyActions = this.spellingIssue
      ? '<div class="dropdown-item" id="ctx-spelling-add-global">Add to global terminology</div><div class="dropdown-item" id="ctx-spelling-add-project">Add to project terminology</div>'
      : "";
    const ignoreAction = this.spellingIssue
      ? `<div class="dropdown-item" id="ctx-spelling-ignore">${this.spellingIssue.ignored ? "Stop ignoring" : this.spellingIssue.languageFamily ? `Ignore in ${this.escapeHtml(this.spellingIssue.languageFamily)}` : "Ignore globally"} “${this.escapeHtml(this.spellingIssue.sourceText)}”</div>`
      : "";
    const issueActions = [suggestionActions, dictionaryActions, terminologyActions, ignoreAction]
      .filter(Boolean)
      .join('<div class="dropdown-separator" role="separator"></div>');
    const spelling = issueActions
      ? `<div class="dropdown-submenu context-spelling-submenu">
          <div class="dropdown-item dropdown-submenu-trigger context-spelling-submenu-trigger" tabindex="0" role="menuitem" aria-haspopup="true" aria-expanded="false">
            Spelling
            <span class="dropdown-submenu-arrow" aria-hidden="true">›</span>
          </div>
          <div class="dropdown-submenu-menu context-spelling-submenu-menu" role="menu">
            ${issueActions.replace(/class="dropdown-item/g, 'tabindex="-1" role="menuitem" class="dropdown-item')}
          </div>
        </div><div class="dropdown-separator"></div>`
      : "";
    const forwardSyncAvailable = this.dependencies.canRevealCursorInPreview();
    const forwardSyncShortcut = navigator.userAgent.toLowerCase().includes("mac")
      ? "Option+Enter"
      : "Alt+Enter";
    const forwardSync = `<div class="dropdown-item${forwardSyncAvailable ? "" : " dropdown-item-disabled"}" id="ctx-editor-forward-sync" aria-disabled="${String(!forwardSyncAvailable)}"${forwardSyncAvailable ? "" : ' title="Available only for textual Typst content when the compiled preview is ready"'}>Reveal Cursor in Preview <span class="hotkey">${forwardSyncShortcut}</span></div><div class="dropdown-separator"></div>`;
    const surroundWith = this.surroundSelection && this.dependencies.getActiveFile()?.toLowerCase().endsWith(".typ")
      ? '<div class="dropdown-item" id="ctx-editor-surround-with">Surround With…</div><div class="dropdown-separator"></div>'
      : "";
    return `${spelling}${forwardSync}${surroundWith}<div class="dropdown-item" id="ctx-copy-text">Copy <span class="hotkey" data-shortcut="Mod+C">Ctrl+C</span></div><div class="dropdown-item" id="ctx-paste-text">Paste <span class="hotkey" data-shortcut="Mod+V">Ctrl+V</span></div><div class="dropdown-item" id="ctx-cut-text">Cut <span class="hotkey" data-shortcut="Mod+X">Ctrl+X</span></div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-editor-toggle-comment">Toggle Line Comment</div><div class="dropdown-item" id="ctx-editor-format">Format Document</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-undo">Undo</div><div class="dropdown-item" id="ctx-redo">Redo</div><div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-editor-select-all">Select All</div>`;
  }

  private openSurroundWith(): void {
    if (!this.surroundOverlay || !this.surroundSelection) return;
    const editor = this.dependencies.getEditor();
    const { from, to } = this.surroundSelection;
    if (to <= from || to > editor.state.doc.length) return;
    if (this.surroundSearch) this.surroundSearch.value = "";
    this.surroundSelectionIndex = 0;
    this.renderSurroundWithOptions();
    this.surroundOverlay.classList.remove("hidden");
    this.surroundSearch?.setAttribute("aria-expanded", "true");
    window.requestAnimationFrame(() => this.surroundSearch?.focus());
  }

  private closeSurroundWith(restoreEditorFocus = true): void {
    this.surroundOverlay?.classList.add("hidden");
    this.surroundSearch?.setAttribute("aria-expanded", "false");
    if (restoreEditorFocus) this.dependencies.getEditor().focus();
  }

  private renderSurroundWithOptions(): void {
    if (!this.surroundList) return;
    const options = filterSurroundWithOptions(
      this.surroundSearch?.value ?? "",
      this.dependencies.getSurroundWithOptions?.() ?? SURROUND_WITH_OPTIONS,
    );
    this.surroundList.replaceChildren();
    if (!options.length) {
      const empty = document.createElement("p");
      empty.className = "surround-with-empty";
      empty.textContent = "No bracket-capable functions match your search.";
      this.surroundList.appendChild(empty);
      this.surroundSearch?.removeAttribute("aria-activedescendant");
      return;
    }
    options.forEach((option, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "surround-with-list-item";
      item.id = `surround-with-result-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      const form = document.createElement("code");
      form.textContent = option.label;
      const description = document.createElement("span");
      description.textContent = option.description;
      item.append(form, description);
      item.addEventListener("click", () => this.applySurroundWith(option));
      item.addEventListener("pointermove", () => this.selectSurroundWithResult(index, false));
      item.addEventListener("focus", () => this.selectSurroundWithResult(index, false));
      this.surroundList?.appendChild(item);
    });
    this.selectSurroundWithResult(Math.min(this.surroundSelectionIndex, options.length - 1), false);
  }

  private handleSurroundWithKeydown(event: KeyboardEvent): void {
    const items = this.surroundResultItems();
    if (event.key === "Enter") {
      const selected = items[this.surroundSelectionIndex];
      if (!selected) return;
      event.preventDefault();
      selected.click();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!items.length) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    this.selectSurroundWithResult(
      (this.surroundSelectionIndex + delta + items.length) % items.length,
      true,
    );
  }

  private surroundResultItems(): HTMLButtonElement[] {
    return this.surroundList
      ? [...this.surroundList.querySelectorAll<HTMLButtonElement>(".surround-with-list-item")]
      : [];
  }

  private selectSurroundWithResult(index: number, scrollIntoView: boolean): void {
    const items = this.surroundResultItems();
    if (!items.length) return;
    this.surroundSelectionIndex = Math.max(0, Math.min(index, items.length - 1));
    items.forEach((item, itemIndex) => {
      const selected = itemIndex === this.surroundSelectionIndex;
      item.classList.toggle("keyboard-selected", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    const selected = items[this.surroundSelectionIndex];
    this.surroundSearch?.setAttribute("aria-activedescendant", selected.id);
    if (scrollIntoView) selected.scrollIntoView({ block: "nearest" });
  }

  private applySurroundWith(option: SurroundWithOption): void {
    const selection = this.surroundSelection;
    this.closeSurroundWith(false);
    if (selection) {
      surroundEditorRange(this.dependencies.getEditor(), selection.from, selection.to, option);
    }
    this.surroundSelection = null;
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character] ?? character);
  }

  private nativeTextItems(editable: boolean): string {
    const editItems = editable
      ? '<div class="dropdown-item" id="ctx-native-cut">Cut <span class="hotkey" data-shortcut="Mod+X">Ctrl+X</span></div><div class="dropdown-item" id="ctx-native-paste">Paste <span class="hotkey" data-shortcut="Mod+V">Ctrl+V</span></div>'
      : "";
    const selectAll = editable
      ? '<div class="dropdown-separator"></div><div class="dropdown-item" id="ctx-native-select-all">Select All <span class="hotkey" data-shortcut="Mod+A">Ctrl+A</span></div>'
      : "";
    return `<div class="dropdown-item" id="ctx-native-copy">Copy <span class="hotkey" data-shortcut="Mod+C">Ctrl+C</span></div>${editItems}${selectAll}`;
  }
}
