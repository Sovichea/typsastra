import { invoke } from "@tauri-apps/api/core";
import type { TinymistLspClient } from "../compiler/lsp";
import type { EditorTab } from "../editor/editorTab";
import { filePathFromUri, filePathKey, relativeFilePath } from "../platform/paths";
import type { PreviewRenderMode } from "../settings";
import type {
  DraftImageAsset,
  DraftImageDiagnostic,
  PreviewContentMode,
} from "./draftPreviewController";
import { prepareRenderProjectWithCopyGuard } from "./renderCacheCopyGuard";

export class PreviewPreparationInterrupted extends Error {
  constructor() {
    super("Preview preparation was superseded by editor input.");
  }
}

export type RenderPreparationTimings = {
  totalMs: number;
  setupMs: number;
  cleanupMs: number;
  discoveryMs: number;
  typProcessingMs: number;
  assetSyncMs: number;
  discoveredFiles: number;
  typFiles: number;
  assetFiles: number;
};

type RenderPreparationResult = {
  generatedEntryFile: string;
  changedFiles: string[];
  warnings: Array<{ filePath: string; message: string }>;
  draftAssets: DraftImageAsset[];
  draftDiagnostics: DraftImageDiagnostic[];
  draftCacheHits: number;
  draftReachableFiles: string[];
  timings: RenderPreparationTimings;
};

export type PreparedPreviewFile = {
  generatedPath: string;
  preparedText: string;
};

type RenderPreparationFileResult = PreparedPreviewFile & {
  draftAssets: DraftImageAsset[];
  draftDiagnostics: DraftImageDiagnostic[];
  draftCacheHit: boolean;
};

export type PreparedPdfPreview = {
  path: string;
  documentRootPath: string;
  changedPaths: string[];
  draftAssets: Map<string, DraftImageAsset>;
  draftDiagnostics: DraftImageDiagnostic[];
  draftProjectCacheHits: number;
  draftOverlayCacheHits: number;
  draftOverlayPreparations: number;
  projectPreparationMs: number;
  overlayPreparationMs: number;
  backendTimings: RenderPreparationTimings;
  reachableSourcePaths: string[];
};

export interface PdfPreviewPreparationDependencies {
  getActiveFilePath(): string | null;
  getPreviewRootPath(): string | null;
  getPreviewMainPath(): string | null;
  getPinnedMainFilePath(): string | null;
  isPreviewStandalone(): boolean;
  getWorkspaceRootPath(): string | null;
  getCacheRootPath(): string | null;
  mapToOriginalPath(path: string): string;
  getOpenTabs(): readonly EditorTab[];
  getPreviewRenderMode(): PreviewRenderMode;
  getPreparationRevision(): number;
  getLspClient(): TinymistLspClient | null;
  listOpenedDocumentUris(): readonly string[];
  removeOpenedDocumentUri(uri: string): void;
  isRenderCachePath(path: string): boolean;
  log(kind: "info" | "warning" | "error", source: string, message: string): void;
}

function normalizeEditorText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Owns render-mirror preparation and the generated source registry used by PDF preview. */
export class PdfPreviewPreparationController {
  private readonly generatedFilesValue = new Map<string, PreparedPreviewFile>();

  constructor(private readonly deps: PdfPreviewPreparationDependencies) {}

  public get generatedFiles(): ReadonlyMap<string, PreparedPreviewFile> {
    return this.generatedFilesValue;
  }

  public clearGeneratedFiles(): void {
    this.generatedFilesValue.clear();
  }

  public generatedFile(path: string): PreparedPreviewFile | undefined {
    return this.generatedFilesValue.get(filePathKey(path));
  }

  public ensureCurrent(revision: number): void {
    if (
      this.deps.getPreviewRenderMode() === "on-type"
      && revision !== this.deps.getPreparationRevision()
    ) {
      throw new PreviewPreparationInterrupted();
    }
  }

  public async prepareProjectIfNeeded(): Promise<void> {
    const workspaceRootPath = this.deps.getWorkspaceRootPath();
    const pinnedMainFilePath = this.deps.getPinnedMainFilePath();
    if (!workspaceRootPath || !pinnedMainFilePath) return;
    const cacheRoot = this.deps.getCacheRootPath();
    if (!cacheRoot) return;

    // Cache preparation is shared by render-on-save and render-on-type. Their
    // only difference is the trigger: explicit save versus debounced input.
    // Always mirror the configured main document, never whichever dependency
    // happens to be active while the workspace or LSP is starting.
    const entryFile = this.deps.mapToOriginalPath(pinnedMainFilePath);

    try {
      await prepareRenderProjectWithCopyGuard({
        projectRoot: workspaceRootPath,
        entryFile,
        cacheRoot,
        generateSourceMap: true,
        previewContentMode: "normal",
      });
    } catch (error) {
      console.error("Failed to prepare render project:", error);
    }
  }

  public async prepare(
    contents: string,
    preparationRevision: number,
    contentMode: PreviewContentMode,
    useEditorOverlays: boolean,
  ): Promise<PreparedPdfPreview | null> {
    const activeFilePath = this.deps.getActiveFilePath();
    if (!activeFilePath) return null;
    const rootPath = this.deps.isPreviewStandalone()
      ? (this.deps.getPreviewRootPath() ?? activeFilePath)
      : (this.deps.getPreviewMainPath() ?? this.deps.getPreviewRootPath() ?? activeFilePath);
    if (!rootPath) return null;

    // Every live preview compiles from Typsastra's private render mirror.
    // Tinymist normally honors PREVIEW_OUTPUT_PATH, but older or incompatible
    // versions can fall back to writing beside their compilation root. Keeping
    // that root under Typsastra's machine-local cache guarantees that even the
    // fallback output cannot create a generated file beside user sources.
    const workspaceRootPath = this.deps.getWorkspaceRootPath();
    if (!workspaceRootPath) return null;
    const cacheRoot = this.deps.getCacheRootPath();
    if (!cacheRoot) return null;
    this.generatedFilesValue.clear();
    const originalRootPath = this.deps.mapToOriginalPath(rootPath);
    const originalActivePath = this.deps.mapToOriginalPath(activeFilePath);
    const options = {
      projectRoot: workspaceRootPath,
      entryFile: originalRootPath,
      cacheRoot,
      generateSourceMap: true,
      previewContentMode: contentMode,
    };
    const projectPreparationStartedAt = performance.now();
    const result = await prepareRenderProjectWithCopyGuard<RenderPreparationResult>(options);
    const projectPreparationMs = performance.now() - projectPreparationStartedAt;
    this.ensureCurrent(preparationRevision);
    const draftAssets = new Map(result.draftAssets.map((asset: DraftImageAsset) => [asset.id, asset]));
    const draftDiagnostics = [...result.draftDiagnostics];
    const draftReachableFileKeys = new Set(
      result.draftReachableFiles.map((path: string) => filePathKey(this.deps.mapToOriginalPath(path))),
    );
    let draftOverlayCacheHits = 0;
    let draftOverlayPreparations = 0;
    let overlayPreparationMs = 0;
    const tabsToOverlay = useEditorOverlays
      ? this.deps.getOpenTabs()
        .filter(tab => tab.contentLoaded)
        .filter(tab => tab.path.toLowerCase().endsWith(".typ"))
        .filter(tab => relativeFilePath(workspaceRootPath, this.deps.mapToOriginalPath(tab.path)) !== null)
        .filter(tab => draftReachableFileKeys.has(filePathKey(this.deps.mapToOriginalPath(tab.path))))
      : [];
    const overlaid = new Set<string>();
    for (const tab of tabsToOverlay) {
      const originalTabPath = this.deps.mapToOriginalPath(tab.path);
      overlaid.add(filePathKey(originalTabPath));
      const sourceCode = filePathKey(originalTabPath) === filePathKey(originalActivePath)
        ? contents
        : tab.content;
      const overlayStartedAt = performance.now();
      const generated = await invoke<RenderPreparationFileResult>("prepare_render_file", {
        options,
        filePath: originalTabPath,
        sourceCode,
      });
      overlayPreparationMs += performance.now() - overlayStartedAt;
      this.ensureCurrent(preparationRevision);
      this.generatedFilesValue.set(filePathKey(originalTabPath), generated);
      draftOverlayPreparations += 1;
      if (generated.draftCacheHit) draftOverlayCacheHits += 1;
      for (const asset of generated.draftAssets) draftAssets.set(asset.id, asset);
      draftDiagnostics.push(...generated.draftDiagnostics);
    }
    if (
      useEditorOverlays
      && draftReachableFileKeys.has(filePathKey(originalActivePath))
      && !overlaid.has(filePathKey(originalActivePath))
    ) {
      const overlayStartedAt = performance.now();
      const activeGenerated = await invoke<RenderPreparationFileResult>("prepare_render_file", {
        options,
        filePath: originalActivePath,
        sourceCode: contents,
      });
      overlayPreparationMs += performance.now() - overlayStartedAt;
      this.ensureCurrent(preparationRevision);
      this.generatedFilesValue.set(filePathKey(originalActivePath), activeGenerated);
      draftOverlayPreparations += 1;
      if (activeGenerated.draftCacheHit) draftOverlayCacheHits += 1;
      for (const asset of activeGenerated.draftAssets) draftAssets.set(asset.id, asset);
      draftDiagnostics.push(...activeGenerated.draftDiagnostics);
    }
    this.deps.log(
      "info",
      "preview scheduler",
      contentMode === "draft"
        ? `Draft preparation replaced ${draftAssets.size} unique image asset(s); ${draftDiagnostics.length} image call(s) remained unchanged.`
        : "Normal preview preparation retained all document images.",
    );
    return {
      path: result.generatedEntryFile,
      documentRootPath: originalRootPath,
      changedPaths: result.changedFiles,
      draftAssets: contentMode === "draft" ? draftAssets : new Map(),
      draftDiagnostics: contentMode === "draft" ? draftDiagnostics : [],
      draftProjectCacheHits: contentMode === "draft" ? result.draftCacheHits : 0,
      draftOverlayCacheHits: contentMode === "draft" ? draftOverlayCacheHits : 0,
      draftOverlayPreparations: contentMode === "draft" ? draftOverlayPreparations : 0,
      projectPreparationMs,
      overlayPreparationMs,
      backendTimings: result.timings,
      reachableSourcePaths: result.draftReachableFiles.map((path: string) => this.deps.mapToOriginalPath(path)),
    };
  }

  public async closePreparedDocuments(): Promise<number> {
    const client = this.deps.getLspClient();
    if (!client) return 0;
    const mirrorUris = this.deps.listOpenedDocumentUris().filter(uri =>
      this.deps.isRenderCachePath(filePathFromUri(uri)),
    );
    for (const uri of mirrorUris) {
      await client.closeTextDocument(uri);
      this.deps.removeOpenedDocumentUri(uri);
    }
    return mirrorUris.length;
  }


  public async generatedPreviewText(originalPath: string): Promise<string> {
    const key = filePathKey(originalPath);
    const cached = this.generatedFilesValue.get(key);
    if (cached) return cached.preparedText;
    const workspaceRootPath = this.deps.getWorkspaceRootPath();
    if (!workspaceRootPath) return "";
    const relativePath = relativeFilePath(workspaceRootPath, originalPath);
    if (relativePath === null) return "";
    const cacheRoot = this.deps.getCacheRootPath();
    if (!cacheRoot) return "";
    const generatedPath = `${cacheRoot}/render/${relativePath.replace(/\\/g, "/")}`;
    try {
      const preparedText = normalizeEditorText(
        await invoke<string>("read_workspace_file", { path: generatedPath }),
      );
      this.generatedFilesValue.set(key, { generatedPath, preparedText });
      return preparedText;
    } catch {
      return "";
    }
  }
}
