import type { EditorView } from "@codemirror/view";
import type { TinymistLspClient, LspLogEntry, LspStatus } from "../compiler/lsp";
import { isTypstDocumentPath } from "../platform/fileTypes";
import { filePathToUri } from "../platform/paths";
import { t } from "../i18n";

export interface DocumentFormattingDependencies {
  activeFilePath(): string | null;
  activeMode(): "CODE" | "WYSIWYM";
  lspReady(): boolean;
  client(): TinymistLspClient | undefined;
  editor(): EditorView;
  tabSize(): number;
  flushPendingLspSync(): Promise<void>;
  reloadWorkspaceFonts(): Promise<void>;
  setLspStatus(status: LspStatus): void;
  appendLspLog(entry: LspLogEntry): void;
  appendDeveloperLog(entry: LspLogEntry): void;
}

/** Owns Tinymist document formatting and trailing-whitespace cleanup. */
export class DocumentFormattingController {
  constructor(private readonly deps: DocumentFormattingDependencies) {}

  async formatActiveDocument(options: { silent?: boolean } = {}): Promise<boolean> {
    const activeFilePath = this.deps.activeFilePath();
    if (!activeFilePath || !isTypstDocumentPath(activeFilePath) || this.deps.activeMode() !== "CODE") return false;
    const client = this.deps.client();
    if (!this.deps.lspReady() || !client) {
      if (!options.silent) {
        this.deps.setLspStatus({ kind: "error", message: t("Formatter unavailable until Tinymist LSP is ready") });
      }
      return false;
    }

    try {
      await this.deps.flushPendingLspSync();
      const doc = this.deps.editor().state.doc;
      const edits = await client.formatTextDocument(filePathToUri(activeFilePath), doc, {
        tabSize: this.deps.tabSize(),
        insertSpaces: true,
      });
      if (edits.length > 0) {
        const changes = edits
          .slice()
          .sort((a, b) => a.from - b.from)
          .map(edit => ({ from: edit.from, to: edit.to, insert: edit.insert }));
        this.deps.editor().dispatch({ changes, userEvent: "input.format" });
      }
      if (!options.silent) {
        this.deps.setLspStatus({
          kind: "preview-ready",
          message: edits.length > 0 ? "Document formatted" : "Document already formatted",
        });
      }
      return true;
    } catch (error) {
      try {
        await this.deps.reloadWorkspaceFonts();
      } catch (restartError) {
        this.deps.appendDeveloperLog({
          kind: "error",
          source: "typography",
          message: `Failed to restore Tinymist after typography error: ${String(restartError)}`,
        });
      }
      this.deps.appendLspLog({
        kind: "warning",
        source: "formatter",
        message: `Format failed: ${String(error)}`,
      });
      if (!options.silent) {
        this.deps.setLspStatus({ kind: "error", message: t`Format failed: ${String(error)}` });
      }
      return false;
    }
  }

  removeTrailingSpaces(): void {
    if (this.deps.activeMode() !== "CODE") return;
    const editor = this.deps.editor();
    const doc = editor.state.doc;
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const match = /[ \t]+$/u.exec(line.text);
      if (match) {
        changes.push({
          from: line.from + match.index,
          to: line.to,
          insert: "",
        });
      }
    }
    if (changes.length > 0) {
      editor.dispatch({ changes, userEvent: "input.format" });
    }
  }
}
