import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getEditorExtensions } from "./editor/extensions";
import { WorkspaceExplorer } from "./components/explorer";
import { TinymistLspClient } from "./compiler/lsp";

type EditorMode = "CODE" | "WYSIWYM";

class TypstryWorkspaceController {
  private activeMode: EditorMode = "CODE";
  private activeFilePath: string | null = null;
  private currentVersion = 1;
  
  private editorInstance!: EditorView;
  private explorer!: WorkspaceExplorer;
  private lspClient!: TinymistLspClient;

  private codePane = document.getElementById("code-editor-pane")!;
  private wysiwymPane = document.getElementById("wysiwym-editor-pane")!;
  private wysiwymContainer = this.wysiwymPane.querySelector(".wysiwym-container")!;
  private previewPane = document.getElementById("preview-render-pane")!;

  public async bootstrap() {
    this.initCodeMirror();
    this.initExplorer();
    await this.initLsp();
    this.bindGlobalEvents();
  }

  private initCodeMirror() {
    this.editorInstance = new EditorView({
      state: EditorState.create({
        doc: "= Welcome to Typstry\nSelect a file from the explorer to begin configuration editing.",
        extensions: [
          getEditorExtensions(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.handleContentMutation(update.state.doc.toString());
          })
        ]
      }),
      parent: this.codePane
    });
  }

  private initExplorer() {
    this.explorer = new WorkspaceExplorer(document.getElementById("explorer-sidebar")!, (path) => this.loadFile(path));
  }

  private async initLsp() {
    this.lspClient = new TinymistLspClient(8589, (svg) => { this.previewPane.innerHTML = svg; });
    await this.lspClient.connect().catch(e => console.warn("Tinymist LSP instance offline.", e));
  }

  private async loadFile(path: string) {
    this.activeFilePath = path;
    const contents = await readTextFile(path);
    this.currentVersion++;
    
    this.editorInstance.dispatch({
      changes: { from: 0, to: this.editorInstance.state.doc.length, insert: contents }
    });
    
    if (this.activeMode === "WYSIWYM") {
      this.mapMarkupToWysiwym(contents);
    }
  }

  private handleContentMutation(rawText: string) {
    if (this.activeFilePath) {
      this.lspClient.notifyTextChange(this.activeFilePath, rawText, this.currentVersion++);
    }
  }

  private switchViewLayoutMode() {
    if (this.activeMode === "CODE") {
      this.activeMode = "WYSIWYM";
      this.mapMarkupToWysiwym(this.editorInstance.state.doc.toString());
      this.codePane.classList.add("hidden");
      this.wysiwymPane.classList.remove("hidden");
    } else {
      this.activeMode = "CODE";
      const markup = this.mapWysiwymToMarkup();
      this.editorInstance.dispatch({
        changes: { from: 0, to: this.editorInstance.state.doc.length, insert: markup }
      });
      this.wysiwymPane.classList.add("hidden");
      this.codePane.classList.remove("hidden");
    }
  }

  private bindGlobalEvents() {
    listen("menu-toggle-layout", () => this.switchViewLayoutMode());
    listen("menu-open-folder", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") this.explorer.loadWorkspace(selected);
    });
    this.wysiwymContainer.addEventListener("input", () => {
      if (this.activeMode === "WYSIWYM") {
        const generatedMarkup = this.mapWysiwymToMarkup();
        this.handleContentMutation(generatedMarkup);
      }
    });
  }

  private mapMarkupToWysiwym(markup: string) {
    this.wysiwymContainer.innerHTML = "";
    markup.split("\n").forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const block = document.createElement("div");
      block.className = "wysiwym-block " + (trimmed.startsWith("=") ? "heading" : "body");
      block.contentEditable = "true";
      block.textContent = trimmed.startsWith("=") ? trimmed.replace(/^=\s*/, "") : trimmed;
      this.wysiwymContainer.appendChild(block);
    });
  }

  private mapWysiwymToMarkup(): string {
    return Array.from(this.wysiwymContainer.querySelectorAll(".wysiwym-block"))
      .map(b => b.classList.contains("heading") ? `= ${b.textContent?.trim()}` : b.textContent?.trim())
      .join("\n");
  }
}

document.addEventListener("DOMContentLoaded", () => { new TypstryWorkspaceController().bootstrap(); });

