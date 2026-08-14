import { EditorView } from "@codemirror/view";
import { foldedRanges, unfoldEffect } from "@codemirror/language";
import type { TinymistLspClient } from "../compiler/lsp";
import type { LspDiagnostic, LspSourcePosition } from "../compiler/lsp";
import { externalReferenceLabels } from "../editor/templateTypography";
import {
  looksLikeStalePrefixDiagnostic,
  setEditorDiagnosticsEffect,
  type EditorDiagnostic,
  type EditorDiagnosticSeverity,
} from "../editor/diagnostics";
import type { SpellcheckController, SpellingIssue } from "../editor/spellcheck";
import type { PreviewCompilerRelatedDiagnostic } from "./previewFailureController";
import { fileNameFromPath, filePathFromUri } from "../platform/paths";
import { isTypstDocumentPath } from "../platform/fileTypes";
import {
  LogConsoleController,
  spellcheckConsoleGroupKey,
  type LogConsoleEntryInput,
} from "./logConsoleController";

export interface DiagnosticsControllerPort {
  editor(): EditorView | undefined;
  client(): TinymistLspClient | undefined;
  activeFilePath(): string | null;
  pathKey(path: string): string;
  mapToOriginalPath(path: string): string;
  isRenderCachePath(path: string): boolean;
  previewImported(): boolean;
  previewStandalone(): boolean;
  latestDocumentVersion(): number;
  hasPendingSync(path: string): boolean;
  spellcheck(): SpellcheckController;
  recordFirstDiagnostics(diagnosticCount: number): void;
  logDeveloper(kind: "info" | "warning", source: string, message: string): void;
  acceptedDiagnosticsChanged(diagnostics: readonly LspDiagnostic[]): void;
  openDiagnosticFile(path: string): Promise<void>;
  activeTabContentLoaded(): boolean;
  editorPositionFromSourceLocation(line: number, column: number): number;
}

/** Owns LSP/spellcheck diagnostics from publication through editor and Problems UI. */
export class DiagnosticsController {
  private readonly lspDiagnosticsByFile = new Map<string, LspDiagnostic[]>();
  private readonly compilerRelatedByFile = new Map<string, PreviewCompilerRelatedDiagnostic[]>();

  constructor(
    private readonly logConsole: LogConsoleController,
    private readonly port: DiagnosticsControllerPort,
  ) {}

  async handleLspDiagnostics(uri: string, diagnostics: LspDiagnostic[], version?: number): Promise<void> {
    const rawPath = filePathFromUri(uri);
    if (this.port.isRenderCachePath(rawPath)) {
      this.port.logDeveloper(
        "info",
        "preview diagnostics",
        `Ignored ${diagnostics.length} diagnostic(s) from private render mirror: ${rawPath}.`,
      );
      return;
    }

    const originalPath = this.port.mapToOriginalPath(rawPath);
    if (!isTypstDocumentPath(originalPath)) return;
    const activePath = this.port.activeFilePath();
    const isActive = !!activePath && this.port.pathKey(originalPath) === this.port.pathKey(activePath);
    if (isActive) this.port.recordFirstDiagnostics(diagnostics.length);

    const normalizedPath = originalPath.toLowerCase();
    const isPackageFile = normalizedPath.includes("typst/packages")
      || normalizedPath.includes("typst\\packages")
      || normalizedPath.includes("packages/preview")
      || normalizedPath.includes("packages\\preview");
    if (isPackageFile) {
      if (isActive) this.clearEditorDiagnostics();
      return;
    }

    if (isActive && !this.shouldAcceptLspDiagnostics(originalPath, version)) return;

    const cacheableDiagnostics = diagnostics.filter(diagnostic =>
      !diagnostic.message.includes("cannot export multiple images without a page number template")
    );
    this.lspDiagnosticsByFile.set(this.port.pathKey(originalPath), cacheableDiagnostics);

    const filteredDiagnostics = cacheableDiagnostics.filter(diagnostic => {
      if (!isActive || !/label.*does not exist|unknown label/i.test(diagnostic.message)) return true;
      const externalLabels = this.port.previewImported() && this.port.previewStandalone()
        ? new Set(externalReferenceLabels(this.editor()!.state.doc.toString()))
        : new Set<string>();
      return ![...externalLabels].some(label =>
        diagnostic.message.includes(label) || this.diagnosticSourceText(diagnostic).includes(`@${label}`)
      );
    });

    if (isActive) {
      const editorDiagnostics: EditorDiagnostic[] = [];
      const staleDiagnostics = new Set<LspDiagnostic>();
      for (const diagnostic of filteredDiagnostics) {
        const from = this.editorPositionFromLspPosition(diagnostic.range.start);
        const to = this.editorPositionFromLspPosition(diagnostic.range.end);
        if (from === null || to === null) continue;
        if (looksLikeStalePrefixDiagnostic(this.editor()!.state.doc, from, Math.max(from, to), diagnostic.message)) {
          staleDiagnostics.add(diagnostic);
          continue;
        }
        editorDiagnostics.push({
          from,
          to: Math.max(from, to),
          severity: this.diagnosticSeverityFromLsp(diagnostic.severity),
          message: diagnostic.message,
        });
      }

      if (!this.shouldAcceptLspDiagnostics(originalPath, version)) return;
      editorDiagnostics.push(...this.compilerRelatedEditorDiagnostics(originalPath));
      this.editor()!.dispatch({ effects: setEditorDiagnosticsEffect.of(editorDiagnostics) });
      this.logConsole.setDiagnostics(
        originalPath,
        filteredDiagnostics
          .filter(diagnostic => !staleDiagnostics.has(diagnostic))
          .map(diagnostic => this.logEntryFromDiagnostic(uri, diagnostic)),
      );
    } else {
      this.logConsole.setDiagnostics(
        originalPath,
        filteredDiagnostics.map(diagnostic => this.logEntryFromDiagnostic(uri, diagnostic)),
      );
    }

    if (isActive) this.port.acceptedDiagnosticsChanged(filteredDiagnostics);
  }

  updateSpellcheckLog(issues: readonly SpellingIssue[]): void {
    const filePath = this.port.activeFilePath();
    const editor = this.editor();
    if (!filePath || !editor) {
      this.logConsole.setSpellcheckIssues([]);
      return;
    }

    const doc = editor.state.doc;
    const grouped = new Map<string, {
      issue: SpellingIssue;
      providers: Set<string>;
      locations: Array<{
        filePath: string;
        fileName: string;
        line: number;
        column: number;
        offset: number;
        toOffset: number;
      }>;
      offsets: Set<string>;
    }>();
    for (const issue of issues) {
      const key = spellcheckConsoleGroupKey(issue.sourceText, issue.ignored);
      const group = grouped.get(key) ?? {
        issue,
        providers: new Set<string>(),
        locations: [],
        offsets: new Set<string>(),
      };
      group.providers.add(issue.provider);
      const offset = Math.max(0, Math.min(issue.from, doc.length));
      const toOffset = Math.max(offset, Math.min(issue.to, doc.length));
      const offsetKey = `${offset}:${toOffset}`;
      if (!group.offsets.has(offsetKey)) {
        const line = doc.lineAt(offset);
        group.offsets.add(offsetKey);
        group.locations.push({
          filePath,
          fileName: fileNameFromPath(filePath),
          line: line.number,
          column: offset - line.from + 1,
          offset,
          toOffset,
        });
      }
      grouped.set(key, group);
    }
    this.logConsole.setSpellcheckIssues([...grouped.values()].map(group => ({
      kind: group.issue.ignored ? "info" : "warning",
      channel: "spellcheck",
      counted: !group.issue.ignored,
      source: [...group.providers].join(", "),
      filePath,
      fileName: fileNameFromPath(filePath),
      message: `${group.issue.ignored ? "Ignored unknown word" : "Unknown word"}: “${group.issue.sourceText}”`,
      locations: group.locations,
    })));
    this.syncSelectedSpellingLocation();
  }

  syncSelectedSpellingLocation(): void {
    const activePath = this.port.activeFilePath();
    const editor = this.editor();
    if (!activePath || !editor) {
      this.logConsole.setActiveSpellcheckLocation(null);
      return;
    }
    const selection = editor.state.selection.main;
    const issue = this.port.spellcheck().issueAt(selection.from < selection.to ? selection.from : selection.head);
    this.logConsole.setActiveSpellcheckLocation(activePath, issue?.from, issue?.to);
  }

  clear(): void {
    this.lspDiagnosticsByFile.clear();
    this.compilerRelatedByFile.clear();
    this.logConsole.clearDiagnostics();
    this.clearEditorDiagnostics();
  }

  clearEditorDiagnostics(): void {
    const editor = this.editor();
    if (editor) editor.dispatch({ effects: setEditorDiagnosticsEffect.of([]) });
  }

  restoreCachedEditorDiagnostics(path: string): void {
    const editor = this.editor();
    const activePath = this.port.activeFilePath();
    const cached = this.lspDiagnosticsByFile.get(this.port.pathKey(path));
    if (!editor || !activePath || this.port.pathKey(path) !== this.port.pathKey(activePath)) return;

    const externalLabels = this.port.previewImported() && this.port.previewStandalone()
      ? new Set(externalReferenceLabels(editor.state.doc.toString()))
      : new Set<string>();
    const editorDiagnostics: EditorDiagnostic[] = [];
    for (const diagnostic of cached ?? []) {
      if (
        /label.*does not exist|unknown label/i.test(diagnostic.message)
        && [...externalLabels].some(label =>
          diagnostic.message.includes(label) || this.diagnosticSourceText(diagnostic).includes(`@${label}`)
        )
      ) continue;
      const from = this.editorPositionFromLspPosition(diagnostic.range.start);
      const to = this.editorPositionFromLspPosition(diagnostic.range.end);
      if (from === null || to === null) continue;
      if (looksLikeStalePrefixDiagnostic(editor.state.doc, from, Math.max(from, to), diagnostic.message)) continue;
      editorDiagnostics.push({
        from,
        to: Math.max(from, to),
        severity: this.diagnosticSeverityFromLsp(diagnostic.severity),
        message: diagnostic.message,
      });
    }
    editorDiagnostics.push(...this.compilerRelatedEditorDiagnostics(path));
    editor.dispatch({ effects: setEditorDiagnosticsEffect.of(editorDiagnostics) });
  }

  setCompilerRelatedDiagnostics(entries: readonly PreviewCompilerRelatedDiagnostic[]): void {
    this.compilerRelatedByFile.clear();
    for (const entry of entries) {
      const key = this.port.pathKey(entry.filePath);
      const group = this.compilerRelatedByFile.get(key) ?? [];
      if (!group.some(candidate => candidate.line === entry.line && candidate.column === entry.column)) {
        group.push(entry);
      }
      this.compilerRelatedByFile.set(key, group);
    }
    const activePath = this.port.activeFilePath();
    if (activePath && this.port.activeTabContentLoaded()) {
      this.restoreCachedEditorDiagnostics(activePath);
    }
  }

  private compilerRelatedEditorDiagnostics(path: string): EditorDiagnostic[] {
    const entries = this.compilerRelatedByFile.get(this.port.pathKey(path)) ?? [];
    return entries.map(entry => {
      const from = this.port.editorPositionFromSourceLocation(entry.line, entry.column);
      return {
        from,
        to: from,
        severity: entry.severity ?? "related",
        message: entry.message,
        gutterOnly: entry.severity !== "error",
      };
    });
  }

  diagnosticSeverityFromLsp(severity: number | undefined): EditorDiagnosticSeverity {
    switch (severity) {
      case 1: return "error";
      case 2: return "warning";
      case 3: return "info";
      case 4: return "hint";
      default: return "info";
    }
  }

  editorPositionFromLspPosition(position: LspSourcePosition): number | null {
    const client = this.port.client();
    if (client) return client.editorPositionFromLspPosition(position);
    const editor = this.editor();
    if (!editor) return null;
    const doc = editor.state.doc;
    if (!doc.length) return 0;
    const lineNumber = Math.max(1, Math.min(position.line + 1, doc.lines));
    const line = doc.line(lineNumber);
    const character = utf8ByteOffsetToStringOffset(line.text, position.character ?? 0);
    return Math.max(line.from, Math.min(line.from + character, line.to));
  }

  async navigateToLogEntry(entry: LogConsoleEntryInput): Promise<void> {
    if (!entry.line && entry.offset === undefined) return;
    const activePath = this.port.activeFilePath();
    if (entry.filePath && this.port.pathKey(entry.filePath) !== this.port.pathKey(activePath ?? "")) {
      await this.port.openDiagnosticFile(entry.filePath);
    }
    if (
      entry.filePath
      && this.port.pathKey(entry.filePath) !== this.port.pathKey(this.port.activeFilePath() ?? "")
    ) return;
    const editor = this.editor();
    if (!editor || !this.port.activeTabContentLoaded()) return;

    const cursor = entry.offset === undefined
      ? this.port.editorPositionFromSourceLocation(entry.line ?? 1, entry.column ?? 1)
      : Math.max(0, Math.min(entry.offset, editor.state.doc.length));
    const selectionEnd = entry.toOffset === undefined
      ? cursor
      : Math.max(cursor, Math.min(entry.toOffset, editor.state.doc.length));
    const effects = [EditorView.scrollIntoView(cursor, { y: "center" })];
    foldedRanges(editor.state).between(
      Math.max(0, cursor - 1),
      Math.min(editor.state.doc.length, Math.max(cursor + 1, selectionEnd)),
      (from, to) => {
        if (from <= cursor && to >= cursor) effects.unshift(unfoldEffect.of({ from, to }));
      },
    );
    editor.dispatch({ selection: { anchor: cursor, head: selectionEnd }, effects });
    editor.focus();
  }

  private editor(): EditorView | undefined {
    return this.port.editor();
  }

  private shouldAcceptLspDiagnostics(originalPath: string, version?: number): boolean {
    if (typeof version === "number") return version >= this.port.latestDocumentVersion();
    return !this.port.hasPendingSync(originalPath);
  }

  private diagnosticSourceText(diagnostic: LspDiagnostic): string {
    const editor = this.editor();
    if (!editor) return "";
    const from = this.editorPositionFromLspPosition(diagnostic.range.start);
    const to = this.editorPositionFromLspPosition(diagnostic.range.end);
    if (from === null || to === null) return "";
    return editor.state.doc.sliceString(from, Math.max(from, to));
  }

  private logEntryFromDiagnostic(uri: string, diagnostic: LspDiagnostic): LogConsoleEntryInput {
    const filePath = this.port.mapToOriginalPath(filePathFromUri(uri));
    const severity = this.diagnosticSeverityFromLsp(diagnostic.severity);
    return {
      kind: severity === "related" ? "info" : severity,
      source: diagnostic.source ?? "typst",
      filePath,
      fileName: fileNameFromPath(filePath),
      message: diagnostic.message,
      line: diagnostic.range.start.line + 1,
      column: (diagnostic.range.start.character ?? 0) + 1,
    };
  }
}

function utf8ByteOffsetToStringOffset(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const encoder = new TextEncoder();
  let bytes = 0;
  let offset = 0;
  for (const character of text) {
    const width = encoder.encode(character).length;
    if (bytes + width > byteOffset) break;
    bytes += width;
    offset += character.length;
  }
  return offset;
}
