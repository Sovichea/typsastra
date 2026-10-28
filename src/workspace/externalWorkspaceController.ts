import {
  acceptedExternalChangePaths,
  excludeManagedWorkspacePaths,
  type WorkspaceChange,
} from "./workspaceWatcher";

export interface ExternalWorkspaceControllerPort {
  workspaceRoot(): string | null;
  pathKey(path: string): string;
  conflictPaths(): ReadonlySet<string>;
  managedPathKeys(): ReadonlySet<string>;
  sourcePathsChanged?(paths: readonly string[]): void;
  reloadChangedAssets(paths: readonly string[]): Promise<void>;
  loadExplorer(rootPath: string): Promise<void>;
  markImageToolsStale(): void;
  refreshImageTools(): void;
  /** Rescans the workspace for //@table:<id> anchors after an external write. */
  refreshTableDirectives(): void;
  imageToolsActive(): boolean;
  log(kind: "info" | "warning", message: string): void;
}

/** Refreshes workspace tools independently of source monitoring and compilation. */
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

    this.port.sourcePathsChanged?.(externalPaths);
    const acceptedPaths = acceptedExternalChangePaths(
      externalPaths,
      this.port.pathKey,
      this.port.conflictPaths(),
    );
    if (acceptedPaths.length === 0) {
      await this.port.loadExplorer(workspaceRoot);
      return;
    }
    this.port.markImageToolsStale();
    this.port.log("info", `Accepted workspace ${change.kind}: ${acceptedPaths.join(", ")}`);

    await this.port.reloadChangedAssets(acceptedPaths);
    if (this.port.workspaceRoot() !== workspaceRoot) return;
    await this.port.loadExplorer(workspaceRoot);
    if (this.port.imageToolsActive()) this.port.refreshImageTools();
    this.port.refreshTableDirectives();
  }
}
