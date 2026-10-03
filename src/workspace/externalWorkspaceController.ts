import type { TinymistLspClient } from "../compiler/lsp";
import { filePathToUri } from "../platform/paths";
import {
  acceptedExternalChangePaths,
  excludeManagedWorkspacePaths,
  shouldSuppressWorkspaceSelfSave,
  type WorkspaceChange,
} from "./workspaceWatcher";

export interface ExternalWorkspaceControllerPort {
  workspaceRoot(): string | null;
  pathKey(path: string): string;
  openTabPaths(): readonly string[];
  conflictPaths(): ReadonlySet<string>;
  managedPathKeys(): ReadonlySet<string>;
  reloadOpenFiles(refreshPreview: boolean): Promise<boolean>;
  lspClient(): TinymistLspClient | undefined;
  lspReady(): boolean;
  loadExplorer(rootPath: string): Promise<void>;
  refreshImageTools(): void;
  /** Rescans the workspace for //@table:<id> anchors after an external write. */
  refreshTableDirectives(): void;
  imageToolsActive(): boolean;
  clearDiagnostics(): void;
  retireSourceMap(reason: string): Promise<void>;
  refreshPreview(force: boolean): Promise<void>;
  waitForPreviewRefresh(): Promise<void>;
  setRefreshPending(pending: boolean): void;
  updateForwardSyncAction(): void;
  log(kind: "info" | "warning", message: string): void;
}

/** Coordinates accepted filesystem changes from disk through LSP and preview. */
export class ExternalWorkspaceController {
  constructor(private readonly port: ExternalWorkspaceControllerPort) {}

  async handleChange(change: WorkspaceChange): Promise<void> {
    const workspaceRoot = this.port.workspaceRoot();
    if (!workspaceRoot || this.port.pathKey(change.rootPath) !== this.port.pathKey(workspaceRoot)) {
      return;
    }

    const nonCachePaths = change.paths.filter(path => {
      const relative = path.startsWith(workspaceRoot)
        ? path.substring(workspaceRoot.length)
        : path;
      const cleanRelative = relative.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      return !cleanRelative.startsWith(".typsastra");
    });
    const externalPaths = excludeManagedWorkspacePaths(
      nonCachePaths,
      this.port.pathKey,
      this.port.managedPathKeys(),
    );
    if (externalPaths.length === 0) {
      if (nonCachePaths.length > 0) {
        this.port.log(
          "info",
          `Suppressed ${nonCachePaths.length} application-managed workspace change${nonCachePaths.length === 1 ? "" : "s"}.`,
        );
      }
      return;
    }

    const openPathKeys = new Set(this.port.openTabPaths().map(this.port.pathKey));
    const openFilesChanged = await this.port.reloadOpenFiles(false);
    if (this.port.workspaceRoot() !== workspaceRoot) return;

    const externalPathKeys = externalPaths.map(this.port.pathKey);
    if (shouldSuppressWorkspaceSelfSave(openFilesChanged, externalPathKeys, openPathKeys)) {
      this.port.log(
        "info",
        "Workspace watcher self-save event suppressed; mirror preparation and duplicate Tinymist invalidation skipped.",
      );
      return;
    }

    const acceptedPaths = acceptedExternalChangePaths(
      externalPaths,
      this.port.pathKey,
      this.port.conflictPaths(),
    );
    if (acceptedPaths.length === 0) {
      await this.port.loadExplorer(workspaceRoot);
      return;
    }
    this.port.log("info", `Accepted workspace ${change.kind}: ${acceptedPaths.join(", ")}`);

    // Diagnostics describe the previous workspace snapshot. An external edit can
    // resolve an error reported against a dependency rather than the changed file,
    // so invalidate the complete cached set and let Tinymist publish the new state.
    this.port.clearDiagnostics();
    this.port.setRefreshPending(true);
    this.port.updateForwardSyncAction();
    try {
      await this.port.retireSourceMap("accepted external workspace change");
      const client = this.port.lspClient();
      if (this.port.lspReady() && client) {
        const defaultType: 1 | 2 | 3 = change.kind === "create"
          ? 1
          : change.kind === "remove"
            ? 3
            : 2;
        const lastPathIndex = acceptedPaths.length - 1;
        const changes = acceptedPaths.map((path, index) => ({
          uri: filePathToUri(path),
          type: change.kind === "rename" && change.paths.length > 1
            ? (index === lastPathIndex ? 1 : 3) as 1 | 3
            : defaultType,
        }));
        await client.notifyWorkspaceFilesChanged(changes);
      }
      await this.port.loadExplorer(workspaceRoot);
      if (this.port.imageToolsActive()) this.port.refreshImageTools();
      this.port.refreshTableDirectives();
      if (this.port.workspaceRoot() !== workspaceRoot) return;
      await this.port.refreshPreview(true);
      await this.port.waitForPreviewRefresh();
    } finally {
      this.port.setRefreshPending(false);
      this.port.updateForwardSyncAction();
    }
  }
}
