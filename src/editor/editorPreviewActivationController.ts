import { invoke } from "@tauri-apps/api/core";
import type { EditorTab, PreviewSessionState } from "./editorTab";
import type { LspDocumentController, LspDocumentResolution } from "../session/lspDocumentController";
import type { PreviewFrame } from "../preview/previewFrame";
import type { PreviewSessionController } from "../preview/previewSessionController";
import { previewLspMainPath, type PreviewTarget } from "../preview/previewPolicy";

export interface EditorPreviewActivationOptions {
  skipPreviewActivation?: boolean;
  preservePreviewSession?: PreviewSessionState;
}

export interface EditorPreviewActivationContext {
  target: PreviewTarget | null;
  guarded: boolean;
  presentationReused: boolean;
}

export interface EditorPreviewActivationDependencies {
  previewSession: PreviewSessionController;
  lspDocuments: LspDocumentController;
  previewFrame(): PreviewFrame;
  workspaceRootPath(): string | null;
  pinnedMainFilePath(): string | null;
  isLowMemoryMode(): boolean;
  lspAvailable(): boolean;
  currentVersion(): number;
  resolveLspDocument(path: string, text: string): Promise<LspDocumentResolution>;
  ensureLargePreviewApproved(rootPath: string | null): Promise<boolean>;
  invalidatePreviewWork(reason: string): void;
  noMainFileMessage(): string;
  disabledPreviewMessage(): string;
  renderPdfPreview(contents: string): void;
  logPreview(message: string): void;
}

/** Owns compiler-preview session selection and LSP activation for an editor tab. */
export class EditorPreviewActivationController {
  constructor(private readonly deps: EditorPreviewActivationDependencies) {}

  async prepare(
    tab: EditorTab,
    path: string,
    isTypstDocument: boolean,
    options: EditorPreviewActivationOptions,
  ): Promise<EditorPreviewActivationContext> {
    let presentationReused = false;
    let guarded = false;
    let target: PreviewTarget | null = null;

    this.deps.logPreview(`Tab preview prepare: tab=${path}; typst=${isTypstDocument}; lowMemory=${this.deps.isLowMemoryMode()}; skip=${options.skipPreviewActivation === true}; pinned=${this.deps.pinnedMainFilePath() ?? "none"}.`);
    if (options.skipPreviewActivation) {
      return { target, guarded, presentationReused };
    }
    if (options.preservePreviewSession) {
      this.deps.previewSession.applySessionToTab(tab, options.preservePreviewSession);
      if (options.preservePreviewSession.previewSessionKey) {
        presentationReused = this.deps.previewFrame().activateSession(
          options.preservePreviewSession.previewSessionKey,
        );
      }
      return { target, guarded, presentationReused };
    }
    if (!isTypstDocument) return { target, guarded, presentationReused };
    if (!this.deps.pinnedMainFilePath()) {
      this.deps.previewFrame().setMessage(this.deps.noMainFileMessage());
      return { target, guarded, presentationReused };
    }

    const resolvedTarget = await invoke<PreviewTarget>("resolve_preview_main", {
      filePath: path,
      workspaceRootPath: this.deps.workspaceRootPath(),
      fileContents: tab.content,
      pinnedMainPath: this.deps.pinnedMainFilePath(),
    });
    target = resolvedTarget;
    this.deps.logPreview(`Tab preview target resolved: tab=${path}; root=${resolvedTarget.rootPath ?? "none"}; main=${resolvedTarget.mainPath ?? "none"}; imported=${resolvedTarget.imported}; disabled=${resolvedTarget.disabled}.`);
    if (resolvedTarget.disabled) {
      this.deps.previewSession.applyTargetToTab(tab, resolvedTarget);
      this.deps.invalidatePreviewWork(`${path} does not participate in the configured main preview`);
      return { target, guarded, presentationReused };
    }

    target = await this.deps.previewSession.prepareTemplateAware(resolvedTarget, path, tab.content);
    const approved = await this.deps.ensureLargePreviewApproved(target.rootPath);
    guarded = !approved;
    this.deps.logPreview(`Tab preview approval: tab=${path}; root=${target.rootPath ?? "none"}; approved=${approved}; guarded=${guarded}; session=${this.deps.previewSession.sessionKey ?? "none"}.`);
    if (guarded) {
      this.deps.previewSession.applyTargetToTab(tab, target);
      return { target, guarded, presentationReused };
    }

    // A dependency tab belongs to the same logical preview as its configured
    // main file. Reuse that mounted PDF directly instead of treating the
    // dependency as a new preview root (which would needlessly recompile and
    // rebuild the low-memory sync index on every tab switch).
    const existingMainSession = this.deps.previewSession.captureCurrentMainSessionForImportedTarget(target);
    if (existingMainSession) {
      this.deps.previewSession.applySessionToTab(tab, existingMainSession);
      if (existingMainSession.previewSessionKey) {
        presentationReused = this.deps.previewFrame().activateSession(existingMainSession.previewSessionKey);
      }
      if (presentationReused) return { target, guarded, presentationReused };
    } else {
      this.deps.previewSession.applyTargetToTab(tab, target);
      if (tab.previewSessionKey) {
        presentationReused = this.deps.previewFrame().activateSession(tab.previewSessionKey);
      }
      if (presentationReused) return { target, guarded, presentationReused };
    }
    return { target, guarded, presentationReused };
  }

  async finish(
    tab: EditorTab,
    path: string,
    isTypstDocument: boolean,
    context: EditorPreviewActivationContext,
    options: EditorPreviewActivationOptions,
  ): Promise<void> {
    if (options.skipPreviewActivation || !isTypstDocument) return;

    // Low-memory preview deliberately compiles in one-shot processes rather
    // than through the persistent LSP. The LSP can still be momentarily
    // available while the deferred workspace services settle; do not let that
    // transient state route the first confirmed render through the LSP path.
    if (this.deps.isLowMemoryMode()) {
      // `prepare` may have performed its approval check before the user
      // confirmed a guarded large document. Check again here: this is the
      // confirmed activation path and it must not preserve the stale guarded
      // result that originally displayed the confirmation UI.
      const approved = await this.deps.ensureLargePreviewApproved(this.deps.previewSession.rootPath);
      this.deps.logPreview(`Low-memory preview finish: tab=${path}; root=${this.deps.previewSession.rootPath ?? "none"}; approved=${approved}; guarded=${context.guarded}; reused=${context.presentationReused}; disabled=${this.deps.previewSession.disabled}; preserve=${Boolean(options.preservePreviewSession)}.`);
      if (
        approved
        && !options.preservePreviewSession
        && this.deps.previewSession.rootPath
        && !this.deps.previewSession.disabled
        && !context.presentationReused
      ) {
        this.deps.logPreview(`Low-memory preview render requested from tab: tab=${path}; root=${this.deps.previewSession.rootPath}; session=${this.deps.previewSession.sessionKey ?? "none"}.`);
        this.deps.renderPdfPreview(tab.content);
      } else {
        this.deps.logPreview(`Low-memory preview render skipped after tab activation: tab=${path}; root=${this.deps.previewSession.rootPath ?? "none"}.`);
      }
      return;
    }

    if (this.deps.lspAvailable()) {
      const lspRes = await this.deps.resolveLspDocument(path, tab.content);
      if (lspRes) {
        await this.deps.lspDocuments.openIfNeeded(
          lspRes.uri,
          lspRes.content,
          this.deps.currentVersion(),
        );
      }
      if (!context.guarded) {
        const lspMainPath = context.target
          ? previewLspMainPath(context.target)
          : (this.deps.previewSession.standalone
              ? this.deps.previewSession.rootPath
              : (this.deps.previewSession.mainPath ?? this.deps.previewSession.rootPath));
        const pinChanged = await this.deps.lspDocuments.updatePinnedMain(lspMainPath);
        if (pinChanged) await this.deps.lspDocuments.recheckActiveAfterPin(tab.content);
      }

      if (context.guarded || options.preservePreviewSession) return;
      if (!this.deps.pinnedMainFilePath()) {
        this.deps.previewFrame().setMessage(this.deps.noMainFileMessage());
      } else if (context.target?.disabled) {
        this.deps.previewFrame().setMessage(this.deps.disabledPreviewMessage());
      } else if (this.deps.previewSession.rootPath) {
        if (!context.presentationReused) this.deps.renderPdfPreview(tab.content);
      } else {
        this.deps.previewFrame().setMessage(
          `<div style="padding: 20px; color: var(--ui-header-text); font-family: var(--font-family-sans);">No preview root found for this library/template file. Diagnostics are still active.</div>`,
        );
      }
      return;
    }

    if (
      !context.guarded
      && !options.preservePreviewSession
      && this.deps.previewSession.rootPath
      && !this.deps.previewSession.disabled
    ) {
      this.deps.renderPdfPreview(tab.content);
    }
  }
}
