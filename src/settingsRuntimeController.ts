import type { EditorView } from "@codemirror/view";
import type { StateEffect } from "@codemirror/state";
import { applyUIThemeVariables } from "./editor/extensions";
import type { SpellcheckController } from "./editor/spellcheck";
import type { EditorFontManager } from "./editor/fontManager";
import type { AppSettings } from "./settings";
import type { PreviewRefreshStyle } from "./preview/previewPolicy";

export interface SettingsRuntimeDependencies {
  projectTerminology(): AppSettings["editor"]["globalTerminology"];
  configureAutoSave(enabled: boolean, intervalSeconds: number): void;
  editorFontManager: EditorFontManager;
  spellcheck: SpellcheckController;
  syncPreviewTheme(): void;
  isPreviewOnlyWindow(): boolean;
  effectivePreviewRenderMode(): PreviewRefreshStyle;
  cancelOnTypeSchedule(): void;
  prepareRenderProject(): Promise<void>;
  refreshActivePreviewRoot(): Promise<void>;
  editor(): EditorView | null;
  currentEditorSettingsEffects(): readonly StateEffect<unknown>[];
  clearForwardSync(): void;
  applyLowMemoryMode(enabled: boolean): void;
  updateSettings(update: (settings: AppSettings) => void): void;
}

export class SettingsRuntimeController {
  private _forwardSyncDebounceMs = 120;
  private _lastKhmerRenderPrepState: boolean | undefined;
  private _lastPreviewRenderMode: PreviewRefreshStyle | undefined;
  private _lastLowMemoryMode: boolean | undefined;

  constructor(private readonly deps: SettingsRuntimeDependencies) {}

  get forwardSyncDebounceMs(): number { return this._forwardSyncDebounceMs; }
  get lastPreviewRenderMode(): PreviewRefreshStyle | undefined { return this._lastPreviewRenderMode; }
  set lastPreviewRenderMode(mode: PreviewRefreshStyle | undefined) { this._lastPreviewRenderMode = mode; }

  apply(settings: AppSettings): void {
    const { appearance, editor, preview } = settings;
    document.documentElement.style.setProperty("--editor-font-size", `${appearance.editorFontSize}px`);
    document.documentElement.style.setProperty("--editor-line-height", String(appearance.editorLineHeight));
    document.documentElement.style.setProperty(
      "--editor-line-height-px",
      `${appearance.editorFontSize * appearance.editorLineHeight}px`,
    );
    this._forwardSyncDebounceMs = preview.syncDebounceMs;
    this.deps.configureAutoSave(editor.autoSave, editor.autoSaveIntervalSeconds);
    this.deps.editorFontManager.configure(editor.codeFont, editor.unicodeFont, editor.unicodeFonts);
    this.deps.spellcheck.setEnabled(editor.spellcheck);
    this.deps.spellcheck.setUserDictionary(editor.userDictionary);
    this.deps.spellcheck.setIgnoredWords(editor.ignoredWords);
    this.deps.spellcheck.setTerminology(
      editor.globalTerminology,
      this.deps.projectTerminology(),
      editor.languageTerminology,
      editor.scopedIgnoredWords,
    );
    void applyUIThemeVariables(appearance.theme).then(() => this.deps.syncPreviewTheme());
    if (!this.deps.isPreviewOnlyWindow()) {
      import("@tauri-apps/api/event").then(({ emit }) => {
        void emit("preview-theme-update", appearance.theme);
      }).catch(() => {});
    }

    const khmerPrepChanged = this._lastKhmerRenderPrepState !== undefined
      && this._lastKhmerRenderPrepState !== preview.khmerRenderPreparation;
    this._lastKhmerRenderPrepState = preview.khmerRenderPreparation;
    const renderMode = this.deps.effectivePreviewRenderMode();
    const previewRenderModeChanged = this._lastPreviewRenderMode !== undefined && this._lastPreviewRenderMode !== renderMode;
    this._lastPreviewRenderMode = renderMode;
    if (previewRenderModeChanged && renderMode !== "on-type") this.deps.cancelOnTypeSchedule();
    if (this._lastLowMemoryMode !== preview.lowMemoryMode) {
      this._lastLowMemoryMode = preview.lowMemoryMode;
      this.deps.applyLowMemoryMode(preview.lowMemoryMode);
    }

    const khmerPrepStatus = document.getElementById("khmer-prep-status");
    if (khmerPrepStatus) khmerPrepStatus.classList.toggle("hidden", !preview.khmerRenderPreparation);

    if (khmerPrepChanged) {
      void this.deps.prepareRenderProject().then(() => this.deps.refreshActivePreviewRoot());
    } else if (previewRenderModeChanged) {
      void this.deps.refreshActivePreviewRoot();
    }

    const editorView = this.deps.editor();
    if (editorView) {
      editorView.dispatch({ effects: this.deps.currentEditorSettingsEffects() });
      window.requestAnimationFrame(() => {
        if (this.deps.editor() === editorView) editorView.requestMeasure();
      });
    }

    const wrapLabel = document.getElementById("word-wrap-label");
    if (wrapLabel) wrapLabel.textContent = editor.wordWrap ? "Wrap: On" : "Wrap: Off";
    const zwsLabel = document.getElementById("zws-label");
    if (zwsLabel) zwsLabel.textContent = editor.showZws ? "Invisibles: On" : "Invisibles: Off";
    if (!preview.cursorSync) this.deps.clearForwardSync();
  }

  initializeWordWrapToggle(): void {
    const wordWrapBtn = document.getElementById("word-wrap-toggle");
    wordWrapBtn?.addEventListener("click", () => {
      this.deps.updateSettings(settings => { settings.editor.wordWrap = !settings.editor.wordWrap; });
    });
  }

  initializeZwsToggle(): void {
    const zwsToggle = document.getElementById("zws-toggle");
    zwsToggle?.addEventListener("click", () => {
      this.deps.updateSettings(settings => { settings.editor.showZws = !settings.editor.showZws; });
    });
  }
}
