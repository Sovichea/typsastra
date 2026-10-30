import { filePathKey } from "../platform/paths";
import type { LspStatus } from "../compiler/lsp";
import type { PreviewFrame } from "./previewFrame";
import { t } from "../i18n";

export interface TinymistPreviewRecoveryDependencies {
  workspaceRootPath(): string | null;
  activeFilePath(): string | null;
  hasClient(): boolean;
  lspReady(): boolean;
  previewFrame(): PreviewFrame;
  restartTinymistSession(statusMessage: string): Promise<void>;
  restoreActiveDocumentAfterRestart(): Promise<void>;
  queueRecovery(contents: string): void;
  setLspStatus(status: LspStatus): void;
  appendLog(kind: "info" | "warning" | "error", message: string): void;
}

/** Owns the single automatic Tinymist restart attempt used by interrupted preview renders. */
export class TinymistPreviewRecoveryController {
  private attempts = 0;
  private recovery: Promise<boolean> | null = null;

  constructor(private readonly dependencies: TinymistPreviewRecoveryDependencies) {}

  resetAttempts(): void {
    this.attempts = 0;
  }

  recover(contents: string, failedGeneration: number): Promise<boolean> {
    if (this.recovery) return this.recovery;
    const workspacePath = this.dependencies.workspaceRootPath();
    const activePath = this.dependencies.activeFilePath();
    if (this.attempts >= 1 || !workspacePath || !activePath || !this.dependencies.hasClient()) {
      return Promise.resolve(false);
    }

    this.attempts += 1;
    this.dependencies.appendLog(
      "warning",
      `Render generation ${failedGeneration} was interrupted because Tinymist stopped; attempting one automatic recovery.`,
    );
    this.dependencies.setLspStatus({ kind: "starting", message: t("Recovering preview compiler") });
    const previewFrame = this.dependencies.previewFrame();
    if (!previewFrame.currentUrl) {
      previewFrame.setLoading("Recovering PDF preview...");
    }

    const recovery = (async () => {
      try {
        await this.dependencies.restartTinymistSession("Recovering interrupted preview...");
        if (
          this.dependencies.workspaceRootPath() !== workspacePath
          || filePathKey(this.dependencies.activeFilePath() ?? "") !== filePathKey(activePath)
        ) {
          return false;
        }
        await this.dependencies.restoreActiveDocumentAfterRestart();
        if (!this.dependencies.lspReady()) return false;

        this.dependencies.queueRecovery(contents);
        this.dependencies.appendLog(
          "info",
          `Tinymist recovered after render generation ${failedGeneration}; the latest preview revision was requeued.`,
        );
        return true;
      } catch (recoveryError) {
        this.dependencies.appendLog(
          "error",
          `Automatic Tinymist recovery failed after render generation ${failedGeneration}: ${String(recoveryError)}`,
        );
        return false;
      }
    })();
    this.recovery = recovery;
    void recovery.finally(() => {
      if (this.recovery === recovery) {
        this.recovery = null;
      }
    });
    return recovery;
  }
}
