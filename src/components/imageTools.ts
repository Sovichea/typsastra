import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { WorkspaceExplorer } from "./explorer";
import { workspaceParentDirectories } from "./explorer";

export type ProjectImageReference = {
  sourcePath: string;
  fromUtf16: number;
  toUtf16: number;
  line: number;
  column: number;
};

export type ProjectImageAsset = {
  path: string;
  width: number;
  height: number;
  sourceBytes: number;
  estimatedDecodedBytes: number;
  format: string;
  modifiedMs: number;
  referencedByCurrentDocument: boolean;
  references: ProjectImageReference[];
};

type ProjectImageIndex = {
  images: ProjectImageAsset[];
  scannedTypstFiles: number;
};

type ImageToolPreviewResult = {
  path: string;
  mimeType: string;
  width: number;
  height: number;
  outputBytes: number;
};

export type ImageToolFilter = "all" | "current" | "referenced" | "unused" | "recommended";

const decodedWarningBytes = 64 * 1024 * 1024;
const sourceWarningBytes = 8 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function fileName(path: string): string {
  return path.replace(/\\/gu, "/").split("/").pop() ?? path;
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = root.replace(/\\/gu, "/").replace(/\/$/u, "");
  const normalizedPath = path.replace(/\\/gu, "/");
  return normalizedPath.toLocaleLowerCase().startsWith(`${normalizedRoot.toLocaleLowerCase()}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}

function isRecommended(image: ProjectImageAsset): boolean {
  return image.estimatedDecodedBytes > decodedWarningBytes || image.sourceBytes > sourceWarningBytes;
}

function defaultCopyPath(path: string, format: string): string {
  const normalized = path.replace(/\\/gu, "/");
  const slash = normalized.lastIndexOf("/");
  const dot = normalized.lastIndexOf(".");
  const base = dot > slash ? normalized.slice(0, dot) : normalized;
  const separator = path.includes("\\") ? "\\" : "/";
  return `${base.replace(/\//gu, separator)}-optimized.${format === "jpeg" ? "jpg" : format}`;
}

export class ImageToolsController {
  private workspaceRoot: string | null = null;
  private mainPath: string | null = null;
  private images: ProjectImageAsset[] = [];
  private committed: ProjectImageAsset | null = null;
  private filter: ImageToolFilter = "all";
  private query = "";
  private loaded = false;
  private generation = 0;
  private generatedPreview: ImageToolPreviewResult | null = null;
  private originalProxy: ImageToolPreviewResult | null = null;
  private scannedTypstFiles = 0;
  private imageExplorer: WorkspaceExplorer | null = null;
  private imageExplorerList: HTMLElement | null = null;
  private imageExpandedPaths: string[] = [];
  private imageKnownDirectoryPaths: string[] = [];
  private imageExpansionInitialized = false;

  public constructor(
    private readonly sidebar: HTMLElement,
    private readonly inspector: HTMLElement,
    private readonly comparison: HTMLElement,
    private readonly openReference: (reference: ProjectImageReference) => void,
    private readonly showImagePreview: (source: string | null, imagePath?: string) => void,
    private readonly workspaceFilesWritten: (paths: readonly string[], phase: "before" | "after") => Promise<void>,
  ) {}

  public async setWorkspace(workspaceRoot: string | null, mainPath: string | null): Promise<void> {
    this.imageExplorer?.clearWorkspace();
    this.imageExplorer = null;
    this.imageExplorerList = null;
    this.workspaceRoot = workspaceRoot;
    this.mainPath = mainPath;
    this.images = [];
    this.committed = null;
    this.generatedPreview = null;
    this.originalProxy = null;
    this.query = "";
    this.loaded = false;
    this.imageExpandedPaths = [];
    this.imageKnownDirectoryPaths = [];
    this.imageExpansionInitialized = false;
    this.sidebar.replaceChildren();
    if (!workspaceRoot) {
      this.renderSidebar();
      this.renderEmptyInspector();
      return;
    }
  }
  public async refresh(preferredImagePath?: string): Promise<void> {
    if (!this.workspaceRoot) return;
    const generation = ++this.generation;
    const initialLoad = !this.loaded;

    if (initialLoad) {
      this.sidebar.innerHTML = `<div class="image-tool-loading">Indexing project images…</div>`;
    }

    let index: ProjectImageIndex;
    try {
      index = await invoke<ProjectImageIndex>("project_image_index", {
        workspaceRootPath: this.workspaceRoot,
        mainPath: this.mainPath,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      if (!initialLoad) return;
      this.sidebar.replaceChildren();
      const message = document.createElement("div");
      message.className = "image-tool-empty";
      message.textContent = `Could not index project images: ${String(error)}`;
      this.sidebar.appendChild(message);
      return;
    }
    if (generation !== this.generation) return;
    this.images = index.images;
    this.scannedTypstFiles = index.scannedTypstFiles;
    this.loaded = true;

    const committedPath = preferredImagePath ?? this.committed?.path;
    const committedKey = committedPath?.replace(/\\/gu, "/").toLocaleLowerCase();
    const next = committedKey
      ? this.images.find(image => image.path.replace(/\\/gu, "/").toLocaleLowerCase() === committedKey)
      : undefined;

    if (preferredImagePath && next) {
      this.committed = next;
      this.generatedPreview = null;
      this.originalProxy = null;
    }

    this.renderSidebar();

    if (next) {
      if (preferredImagePath) {
        this.imageExplorer?.setActiveFile(next.path);
        this.renderInspector(next);
        await this.loadOriginalProxy(next);
      } else {
        await this.commit(next);
      }
    } else if (committedPath) {
      this.renderEmptyInspector();
    }
  }

  public show(): void {
    this.sidebar.classList.remove("hidden");
    this.inspector.classList.remove("hidden");
    this.comparison.classList.add("hidden");
    if (this.workspaceRoot && !this.loaded) void this.refresh();
    if (!this.committed) {
      this.renderEmptyInspector();
    } else {
      // Clear any document preview immediately while the selected image proxy
      // is restored asynchronously.
      this.showImagePreview(null, this.committed.path);
      const prepared = this.generatedPreview ?? this.originalProxy;
      if (prepared) {
        const imagePath = this.committed.path;
        void this.imageDataUrl(prepared).then(source => {
          if (this.committed?.path === imagePath) this.showImagePreview(source, imagePath);
        });
      } else {
        void this.loadOriginalProxy(this.committed);
      }
    }
  }

  public hide(): void {
    this.sidebar.classList.add("hidden");
    this.inspector.classList.add("hidden");
    this.comparison.classList.add("hidden");
  }

  public hasCommittedImage(): boolean {
    return this.committed !== null;
  }

  public getExplorer(): WorkspaceExplorer | null {
    return this.imageExplorer;
  }

  public referenceSourcePathsForImage(path: string): string[] {
    const key = path.replace(/\\/gu, "/").toLocaleLowerCase();
    const image = this.images.find(candidate =>
      candidate.path.replace(/\\/gu, "/").toLocaleLowerCase() === key
    );
    return image
      ? [...new Set(image.references.map(reference => reference.sourcePath))]
      : [];
  }

  public async selectImage(path: string): Promise<boolean> {
    if (!this.workspaceRoot) return false;
    if (!this.loaded) await this.refresh();
    const key = path.replace(/\\/gu, "/").toLocaleLowerCase();
    const image = this.images.find(candidate =>
      candidate.path.replace(/\\/gu, "/").toLocaleLowerCase() === key
    );
    if (!image) return false;
    await this.commit(image);
    return true;
  }

  private filteredImages(): ProjectImageAsset[] {
    const needle = this.query.trim().toLocaleLowerCase();
    return this.images.filter(image => {
      const referenced = image.references.length > 0;
      const filterMatches = this.filter === "all"
        || (this.filter === "current" && image.referencedByCurrentDocument)
        || (this.filter === "referenced" && referenced && !image.referencedByCurrentDocument)
        || (this.filter === "unused" && !referenced)
        || (this.filter === "recommended" && isRecommended(image));
      return filterMatches && (!needle || relativePath(this.workspaceRoot ?? "", image.path).toLocaleLowerCase().includes(needle));
    });
  }

  private renderSidebar(): void {
    if (!this.workspaceRoot) {
      this.sidebar.innerHTML = `<div class="image-tool-empty">Open a project to inspect its images.</div>`;
      return;
    }
    if (this.imageExplorer && this.imageExpansionInitialized) {
      this.imageExpandedPaths = this.imageExplorer.expandedDirectoryPaths();
    }

    let controls = this.sidebar.querySelector<HTMLElement>(".image-tool-sidebar-controls");
    let list = this.imageExplorerList;
    let footer = this.sidebar.querySelector<HTMLElement>(".image-tool-sidebar-footer");
    let explorer = this.imageExplorer;
    const needsMount = !controls || !list || !footer || !explorer || !list.isConnected;

    if (needsMount) {
      controls = document.createElement("div");
      controls.className = "image-tool-sidebar-controls";
      controls.innerHTML = `
        <input class="image-tool-search" type="search" placeholder="Search images" aria-label="Search project images" autocomplete="off" />
        <select class="image-tool-filter" aria-label="Filter project images">
          <option value="all">All images</option>
          <option value="current">Current document</option>
          <option value="referenced">Referenced elsewhere</option>
          <option value="unused">Unused</option>
          <option value="recommended">Optimization recommended</option>
        </select>`;

      list = document.createElement("div");
      list.className = "image-tool-list explorer-tree";

      footer = document.createElement("div");
      footer.className = "image-tool-sidebar-footer";

      explorer = new WorkspaceExplorer(
        list,
        path => {
          const key = path.replace(/\\/gu, "/").toLocaleLowerCase();
          const image = this.filteredImages().find(candidate =>
            candidate.path.replace(/\\/gu, "/").toLocaleLowerCase() === key
          );
          if (image) void this.commit(image);
        },
        undefined,
        document.getElementById("image-tools-sidebar-title") ?? undefined,
        (path, isDirectory) => {
          if (isDirectory) return null;
          const key = path.replace(/\\/gu, "/").toLocaleLowerCase();
          const image = this.images.find(candidate =>
            candidate.path.replace(/\\/gu, "/").toLocaleLowerCase() === key
          );
          return image && isRecommended(image)
            ? { className: "pathological-image", title: "Optimization recommended" }
            : null;
        },
        "IMAGES",
        false,
      );

      this.imageExplorerList = list;
      this.imageExplorer = explorer;
      this.sidebar.replaceChildren(controls, list, footer);
    }

    if (!controls || !list || !footer || !explorer) return;

    const search = controls.querySelector<HTMLInputElement>(".image-tool-search")!;
    const filter = controls.querySelector<HTMLSelectElement>(".image-tool-filter")!;
    search.value = this.query;
    filter.value = this.filter;

    const activeList = list;
    const activeFooter = footer;
    const activeExplorer = explorer;
    let explorerHasRendered = activeList.querySelector(".file-tree-branch") !== null;

    const renderList = async (expandAll = false) => {
      if (explorerHasRendered && this.imageExpansionInitialized) {
        this.imageExpandedPaths = activeExplorer.expandedDirectoryPaths();
      }

      const images = this.filteredImages();
      if (images.length === 0) {
        activeExplorer.clearWorkspace();
        activeList.innerHTML = `<div class="image-tool-empty">No images match this view.</div>`;
        activeFooter.textContent = `0 images · ${this.scannedTypstFiles.toLocaleString()} Typst file${this.scannedTypstFiles === 1 ? "" : "s"} scanned`;
        explorerHasRendered = false;
        return;
      }

      const parentPaths = [...new Map(
        images
          .flatMap(image => workspaceParentDirectories(this.workspaceRoot!, image.path))
          .map(path => [path.replace(/\\/gu, "/").toLocaleLowerCase(), path] as const)
      ).values()];
      const newParentPaths = parentPaths.filter(path => {
        const key = path.replace(/\\/gu, "/").toLocaleLowerCase();
        return !this.imageKnownDirectoryPaths.some(known =>
          known.replace(/\\/gu, "/").toLocaleLowerCase() === key
        );
      });
      const expandedPaths = expandAll || !this.imageExpansionInitialized
        ? parentPaths
        : [...this.imageExpandedPaths, ...newParentPaths];

      this.imageExpansionInitialized = true;
      this.imageKnownDirectoryPaths = parentPaths;
      activeExplorer.setVisibleFiles(images.map(image => image.path));
      await activeExplorer.loadWorkspace(this.workspaceRoot!, expandedPaths);
      explorerHasRendered = true;
      this.imageExpandedPaths = activeExplorer.expandedDirectoryPaths();
      activeExplorer.setActiveFile(this.committed?.path ?? null);
      activeFooter.textContent = `${images.length.toLocaleString()} image${images.length === 1 ? "" : "s"} · ${this.scannedTypstFiles.toLocaleString()} Typst file${this.scannedTypstFiles === 1 ? "" : "s"} scanned`;
    };

    if (needsMount) {
      search.addEventListener("input", () => {
        this.query = search.value;
        void renderList(true);
      });
      filter.addEventListener("change", () => {
        this.filter = filter.value as ImageToolFilter;
        void renderList(true);
      });
    }

    void renderList(!this.imageExpansionInitialized);
  }
  private async commit(image: ProjectImageAsset): Promise<void> {
    this.committed = image;
    this.generatedPreview = null;
    this.originalProxy = null;
    this.imageExplorer?.setActiveFile(image.path);
    await this.imageExplorer?.revealPath(image.path);
    this.renderInspector(image);
    await this.loadOriginalProxy(image);
  }

  private renderEmptyInspector(): void {
    this.inspector.innerHTML = `<div class="preview-disabled-placeholder image-tool-inspector-empty"><div class="guardrail-placeholder-content"><div class="preview-disabled-title preview-accent-title">Image Tools</div><div class="preview-disabled-msg">Select an image in the sidebar to inspect and optimize it.</div></div></div>`;
    this.comparison.replaceChildren();
    this.showImagePreview(null);
  }

  private renderInspector(image: ProjectImageAsset): void {
    const status = image.referencedByCurrentDocument
      ? "Current document"
      : image.references.length > 0 ? "Referenced elsewhere" : "Unused";
    const statusClass = image.referencedByCurrentDocument
      ? "current-document"
      : image.references.length > 0 ? "referenced-elsewhere" : "unused";
    const warning = isRecommended(image)
      ? `<div class="image-tool-notice warning"><strong>Optimization recommended</strong><span>${image.estimatedDecodedBytes > decodedWarningBytes ? "Large decoded dimensions can increase compilation and preview memory." : "The encoded source file is unusually large."}</span></div>`
      : "";
    const transformSupported = image.format !== "GIF";
    this.inspector.innerHTML = `
      <div class="image-tool-inspector-header"><div><h2></h2><div class="image-tool-path"></div></div><span class="image-tool-status ${statusClass}">${status}</span></div>
      ${warning}
      <section class="image-tool-metadata-grid">
        <div><span>Dimensions</span><strong>${image.width.toLocaleString()} × ${image.height.toLocaleString()} px</strong></div>
        <div><span>Format</span><strong>${image.format}</strong></div>
        <div><span>Source size</span><strong>${formatBytes(image.sourceBytes)}</strong></div>
        <div><span>Decoded size</span><strong>${formatBytes(image.estimatedDecodedBytes)}</strong></div>
        <div><span>Aspect ratio</span><strong>${(image.width / image.height).toFixed(3)}:1</strong></div>
        <div><span>References</span><strong>${image.references.length}</strong></div>
      </section>
      <section class="image-tool-section"><h3>Included from</h3><div class="image-tool-references"></div></section>
      <section class="image-tool-section">
        <h3>Replace image path</h3>
        <div class="image-tool-notice">Choose another image inside this project and update every static Typst reference listed above.</div>
        <div class="image-tool-actions"><button type="button" data-action="replace-path" ${image.references.length === 0 ? "disabled" : ""}>Choose Replacement Image…</button></div>
        <div class="image-tool-reference-output" aria-live="polite"></div>
      </section>
      <section class="image-tool-section image-tool-optimizer ${transformSupported ? "" : "disabled"}">
        <h3>Optimize a copy</h3>
        ${transformSupported ? `<div class="image-tool-form">
          <label>Width <input data-field="width" type="number" min="1" max="32768" value="${image.width}" /></label>
          <label>Height <input data-field="height" type="number" min="1" max="32768" value="${image.height}" /></label>
          <label class="image-tool-lock"><input data-field="lock" type="checkbox" checked /> Preserve aspect ratio</label>
          <label>Format <select data-field="format"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label>
          <label>Quality (JPEG) <input data-field="quality" type="range" min="1" max="100" value="85" /><output>85</output></label>
          <label class="image-tool-lock"><input data-field="update-references" type="checkbox" ${image.references.length === 0 ? "disabled" : ""} /> Replace static image paths with the optimized copy</label>
        </div><div class="image-tool-actions"><button type="button" data-action="preview" class="primary">Preview Changes</button><button type="button" data-action="save" disabled>Save Optimized Copy</button></div><div class="image-tool-output" aria-live="polite"></div>` : `<div class="image-tool-notice">Animated GIF optimization is not supported. The image remains available for inspection.</div>`}
      </section>`;
    this.inspector.querySelector("h2")!.textContent = fileName(image.path);
    this.inspector.querySelector<HTMLElement>(".image-tool-path")!.textContent = relativePath(this.workspaceRoot!, image.path);
    const references = this.inspector.querySelector<HTMLElement>(".image-tool-references")!;
    if (image.references.length === 0) references.innerHTML = `<div class="image-tool-empty-reference">No static Typst references found.</div>`;
    for (const reference of image.references) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "image-tool-reference";
      button.textContent = `${relativePath(this.workspaceRoot!, reference.sourcePath)} · Ln ${reference.line}, Col ${reference.column}`;
      button.addEventListener("click", () => this.openReference(reference));
      references.appendChild(button);
    }
    this.inspector.querySelector<HTMLButtonElement>('[data-action="replace-path"]')
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.replaceImagePath(image, event.currentTarget as HTMLButtonElement);
      });
    if (transformSupported) this.bindOptimizer(image);
  }

  private async replaceImagePath(image: ProjectImageAsset, button: HTMLButtonElement): Promise<void> {
    const workspaceRoot = this.workspaceRoot;
    const output = this.inspector.querySelector<HTMLElement>(".image-tool-reference-output");
    if (!workspaceRoot || image.references.length === 0) {
      if (output) output.textContent = "This image has no static Typst references to replace.";
      return;
    }
    button.disabled = true;
    button.textContent = "Choosing…";
    if (output) output.textContent = "Choose a replacement image inside this project.";
    try {
      const replacementPath = await open({
        title: "Choose Replacement Image",
        defaultPath: workspaceRoot,
        directory: false,
        multiple: false,
        filters: [{
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"],
        }],
      });
      if (typeof replacementPath !== "string") {
        if (output?.isConnected) output.textContent = "Replacement cancelled.";
        return;
      }
      const originalKey = image.path.replace(/\\/gu, "/").toLocaleLowerCase();
      const replacementKey = replacementPath.replace(/\\/gu, "/").toLocaleLowerCase();
      if (originalKey === replacementKey) {
        if (output?.isConnected) output.textContent = "The selected image already uses this path.";
        return;
      }
      const sourcePaths = [...new Set(image.references.map(reference => reference.sourcePath))];
      await this.workspaceFilesWritten(sourcePaths, "before");
      const updatedReferences = await invoke<number>("image_tool_update_references", {
        workspaceRootPath: workspaceRoot,
        originalImagePath: image.path,
        replacementImagePath: replacementPath,
        sourcePaths,
      });
      await this.workspaceFilesWritten(sourcePaths, "after");
      await this.refresh(replacementPath);
      const refreshedOutput = this.inspector.querySelector<HTMLElement>(".image-tool-reference-output");
      if (refreshedOutput) {
        refreshedOutput.textContent = `Replaced ${updatedReferences} static Typst image path${updatedReferences === 1 ? "" : "s"}.`;
      }
    } catch (error) {
      if (output?.isConnected) output.textContent = `Could not replace image paths: ${String(error)}`;
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Choose Replacement Image…";
      }
    }
  }

  private bindOptimizer(image: ProjectImageAsset): void {
    const width = this.inspector.querySelector<HTMLInputElement>('[data-field="width"]')!;
    const height = this.inspector.querySelector<HTMLInputElement>('[data-field="height"]')!;
    const lock = this.inspector.querySelector<HTMLInputElement>('[data-field="lock"]')!;
    const format = this.inspector.querySelector<HTMLSelectElement>('[data-field="format"]')!;
    const quality = this.inspector.querySelector<HTMLInputElement>('[data-field="quality"]')!;
    const output = quality.nextElementSibling as HTMLOutputElement;
    const preview = this.inspector.querySelector<HTMLButtonElement>('[data-action="preview"]')!;
    const saveCopy = this.inspector.querySelector<HTMLButtonElement>('[data-action="save"]')!;
    const updateReferences = this.inspector.querySelector<HTMLInputElement>('[data-field="update-references"]')!;
    format.value = image.format.toLocaleLowerCase() === "jpg" ? "jpeg" : image.format.toLocaleLowerCase();
    if (!["png", "jpeg", "webp"].includes(format.value)) format.value = "png";
    const updateQualityAvailability = () => {
      quality.disabled = format.value !== "jpeg";
      output.textContent = quality.disabled ? "Lossless" : quality.value;
    };
    updateQualityAvailability();
    let changing = false;
    const syncRatio = (source: "width" | "height") => {
      if (!lock.checked || changing) return;
      changing = true;
      if (source === "width") height.value = String(Math.max(1, Math.round(Number(width.value) * image.height / image.width)));
      else width.value = String(Math.max(1, Math.round(Number(height.value) * image.width / image.height)));
      changing = false;
    };
    width.addEventListener("input", () => { syncRatio("width"); this.invalidateGeneratedPreview(saveCopy); });
    height.addEventListener("input", () => { syncRatio("height"); this.invalidateGeneratedPreview(saveCopy); });
    format.addEventListener("change", () => {
      updateQualityAvailability();
      this.invalidateGeneratedPreview(saveCopy);
    });
    quality.addEventListener("input", () => { output.textContent = quality.value; this.invalidateGeneratedPreview(saveCopy); });
    preview.addEventListener("click", () => void this.generateOptimizationPreview(image, {
      width: Number(width.value), height: Number(height.value), format: format.value, quality: Number(quality.value),
    }, preview, saveCopy));
    saveCopy.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const generatedPreview = this.generatedPreview;
      if (!generatedPreview) {
        output.textContent = "Preview the optimization before saving it.";
        saveCopy.disabled = true;
        return;
      }
      void this.saveOptimizedCopy(
        image,
        generatedPreview,
        format.value,
        updateReferences.checked,
        saveCopy,
      );
    });
  }

  private invalidateGeneratedPreview(saveButton: HTMLButtonElement): void {
    this.generatedPreview = null;
    saveButton.disabled = true;
  }

  private async generateOptimizationPreview(
    image: ProjectImageAsset,
    options: { width: number; height: number; format: string; quality: number },
    button: HTMLButtonElement,
    saveButton: HTMLButtonElement,
  ): Promise<void> {
    if (!this.workspaceRoot || !Number.isFinite(options.width) || !Number.isFinite(options.height)) return;
    button.disabled = true;
    button.textContent = "Preparing…";
    const output = this.inspector.querySelector<HTMLElement>(".image-tool-output")!;
    try {
      this.generatedPreview = await invoke<ImageToolPreviewResult>("image_tool_generate_preview", {
        request: { workspaceRootPath: this.workspaceRoot, sourcePath: image.path, ...options },
      });
      output.textContent = `${this.generatedPreview.width.toLocaleString()} × ${this.generatedPreview.height.toLocaleString()} px · ${formatBytes(this.generatedPreview.outputBytes)} encoded · ${formatBytes(this.generatedPreview.width * this.generatedPreview.height * 4)} decoded`;
      saveButton.disabled = false;
      this.showImagePreview(await this.imageDataUrl(this.generatedPreview), this.generatedPreview.path);
    } catch (error) {
      output.textContent = String(error);
      this.generatedPreview = null;
    } finally {
      button.disabled = false;
      button.textContent = "Preview Changes";
    }
  }

  private async loadOriginalProxy(image: ProjectImageAsset): Promise<void> {
    if (!this.workspaceRoot) return;
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    try {
      this.originalProxy = await invoke<ImageToolPreviewResult>("image_tool_generate_preview", {
        request: {
          workspaceRootPath: this.workspaceRoot,
          sourcePath: image.path,
          width: Math.max(1, Math.round(image.width * scale)),
          height: Math.max(1, Math.round(image.height * scale)),
          format: image.format === "JPEG" ? "jpeg" : "png",
          quality: 88,
        },
      });
      if (this.committed?.path !== image.path) return;
      this.showImagePreview(await this.imageDataUrl(this.originalProxy), image.path);
    } catch (error) {
      if (this.committed?.path === image.path) this.showImagePreview(null, image.path);
      const output = this.inspector.querySelector<HTMLElement>(".image-tool-output");
      if (output) output.textContent = `Could not prepare bounded image preview: ${String(error)}`;
    }
  }

  private async imageDataUrl(result: ImageToolPreviewResult): Promise<string> {
    return invoke<string>("read_workspace_file_as_base64", { path: result.path });
  }

  private async saveOptimizedCopy(
    image: ProjectImageAsset,
    generatedPreview: ImageToolPreviewResult,
    format: string,
    updateReferences: boolean,
    button: HTMLButtonElement,
  ): Promise<void> {
    const workspaceRoot = this.workspaceRoot;
    const output = this.inspector.querySelector<HTMLElement>(".image-tool-output");
    if (!workspaceRoot) {
      if (output) output.textContent = "Open a project before saving an optimized image.";
      return;
    }
    const sourcePaths = [...new Set(image.references.map(reference => reference.sourcePath))];
    button.disabled = true;
    button.textContent = "Saving…";
    if (output) output.textContent = "Choose where to save the optimized image.";
    try {
      const destination = await save({
        title: "Save Optimized Image Copy",
        defaultPath: defaultCopyPath(image.path, format),
        filters: [{ name: format.toUpperCase(), extensions: [format === "jpeg" ? "jpg" : format] }],
      });
      if (typeof destination !== "string") {
        if (output?.isConnected) output.textContent = "Save cancelled.";
        return;
      }
      const changedPaths = [
        destination,
        ...(updateReferences ? sourcePaths : []),
      ];
      await this.workspaceFilesWritten(changedPaths, "before");
      await invoke("image_tool_save_copy", {
        workspaceRootPath: workspaceRoot,
        previewPath: generatedPreview.path,
        destinationPath: destination,
      });
      let updatedReferences = 0;
      if (updateReferences) {
        updatedReferences = await invoke<number>("image_tool_update_references", {
          workspaceRootPath: workspaceRoot,
          originalImagePath: image.path,
          replacementImagePath: destination,
          sourcePaths,
        });
      }
      await this.workspaceFilesWritten(changedPaths, "after");
      const successMessage = updateReferences
        ? `Saved optimized copy and updated ${updatedReferences} static Typst reference${updatedReferences === 1 ? "" : "s"}.`
        : `Saved optimized copy to ${destination}`;
      if (output?.isConnected) output.textContent = successMessage;
      try {
        await this.refresh(updateReferences ? destination : undefined);
      } catch (refreshError) {
        if (output?.isConnected) {
          output.textContent = `${successMessage} Image Tools could not refresh: ${String(refreshError)}`;
        }
        return;
      }
      const refreshedOutput = this.inspector.querySelector<HTMLElement>(".image-tool-output");
      if (refreshedOutput) {
        refreshedOutput.textContent = successMessage;
      }
    } catch (error) {
      if (output) output.textContent = `Could not save optimized image: ${String(error)}`;
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Save Optimized Copy";
      }
    }
  }
}
