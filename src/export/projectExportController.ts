import { invoke } from "@tauri-apps/api/core";
import { message, save } from "@tauri-apps/plugin-dialog";
import type { LspStatus } from "../compiler/lsp";
import { filePathKey, relativeFilePath } from "../platform/paths";
import {
  prepareRenderProjectWithCopyGuard,
  RenderCacheCopyCancelled,
} from "../preview/renderCacheCopyGuard";

export type ExportableEditorTab = {
  path: string;
  content: string;
  contentLoaded: boolean;
  isDirty: boolean;
};

export type PdfExportProvenance = {
  compilerKind: "tinymist" | "enhanced-managed" | "custom-typst";
  displayName: string;
  compilerVersion: string;
  typstVersion?: string;
  engineVersion?: string;
  typstCommit?: string;
  krillaCommit?: string;
};

type ProjectExportDependencies = {
  activeFilePath: () => string | null;
  activeContents: () => string;
  previewStandalone: () => boolean;
  previewRootPath: () => string | null;
  previewMainPath: () => string | null;
  workspaceRootPath: () => string | null;
  cacheRootPath: () => string | null;
  mapToOriginalPath: (path: string) => string;
  openTabs: () => readonly ExportableEditorTab[];
  enhancedUnicodeEnginePath: () => string | null;
  setLspStatus: (status: LspStatus) => void;
  log: (kind: "info" | "warning" | "error", message: string) => void;
};

const PDF_EXPORT_CANCELLED = "PDF_EXPORT_CANCELLED";

class PdfExportCancelled extends Error {
  constructor() {
    super(PDF_EXPORT_CANCELLED);
  }
}

export function isPdfExportCancellation(error: unknown): boolean {
  return error instanceof PdfExportCancelled || String(error).includes(PDF_EXPORT_CANCELLED);
}

function destinationName(path: string): string {
  return path.split(/[/\\]/).pop() || "PDF";
}

export function pdfExportProvenanceLog(
  provenance: PdfExportProvenance,
  outcome: "success" | "cancelled" | "failure",
  destination?: string,
): string {
  const details: string[] = [provenance.compilerKind];
  if (provenance.engineVersion) details.push(`engine ${provenance.engineVersion}`);
  if (provenance.compilerKind === "tinymist") details.push(`tinymist ${provenance.compilerVersion}`);
  if (provenance.typstVersion) details.push(`typst ${provenance.typstVersion}`);
  details.push(`outcome ${outcome}`);
  if (destination) details.push(destinationName(destination));
  return details.join(" · ");
}

export class ProjectExportController {
  private busy = false;
  private activePdfOperationId: string | null = null;
  private activePdfProvenance: PdfExportProvenance | null = null;
  private pdfCancellationRequested = false;

  constructor(private readonly deps: ProjectExportDependencies) {}

  get isBusy(): boolean {
    return this.busy;
  }

  async exportPdf(): Promise<void> {
    if (this.activePdfOperationId) {
      await this.cancelPdfExport();
      return;
    }
    if (this.busy) return;
    const activeFilePath = this.deps.activeFilePath();
    if (!activeFilePath) return;

    const content = this.deps.activeContents();
    let operationId: string | null = null;
    let provenance: PdfExportProvenance | null = null;
    let exportPdfPath: string | null = null;
    this.busy = true;
    try {
      const rootPath = this.deps.previewStandalone()
        ? (this.deps.previewRootPath() ?? activeFilePath)
        : (this.deps.previewMainPath() ?? this.deps.previewRootPath() ?? activeFilePath);

      const defaultPdfPath = (this.deps.previewStandalone()
        ? activeFilePath
        : (this.deps.previewMainPath() ?? activeFilePath)).replace(/\.typ$/i, ".pdf");
      exportPdfPath = await save({
        title: "Export PDF",
        defaultPath: defaultPdfPath,
        filters: [{ name: "PDF Document", extensions: ["pdf"] }]
      });
      if (!exportPdfPath) {
        this.deps.setLspStatus({ kind: "preview-ready", message: "PDF export cancelled" });
        return;
      }

      operationId = crypto.randomUUID();
      this.activePdfOperationId = operationId;
      this.pdfCancellationRequested = false;
      this.updatePdfExportAction(true);
      await invoke("begin_pdf_export_operation", { operationId });
      this.throwIfPdfExportCancelled();
      const enhancedUnicodeEnginePath = this.deps.enhancedUnicodeEnginePath();
      provenance = await invoke<PdfExportProvenance>("inspect_pdf_export_compiler", {
        operationId,
        compilerPath: enhancedUnicodeEnginePath,
      });
      this.activePdfProvenance = provenance;
      this.throwIfPdfExportCancelled();
      this.deps.setLspStatus({
        kind: "running",
        message: `Exporting PDF with ${provenance.displayName}... Use Export PDF again to cancel.`,
      });
      let targetFilePath = rootPath;
      let targetContent = "";
      if (filePathKey(targetFilePath) === filePathKey(activeFilePath)) {
        targetContent = content;
      } else {
        targetContent = await invoke<string>("read_workspace_file", { path: targetFilePath }).catch(() => "");
      }
      this.throwIfPdfExportCancelled();

      const cacheRoot = this.deps.cacheRootPath();
      const workspaceRootPath = this.deps.workspaceRootPath();
      if (cacheRoot && workspaceRootPath) {
        const originalRootPath = this.deps.mapToOriginalPath(rootPath);
        const originalActivePath = this.deps.mapToOriginalPath(activeFilePath);
        const options = {
          projectRoot: workspaceRootPath,
          entryFile: originalRootPath,
          cacheRoot,
          generateSourceMap: false,
          // User-facing export must never compile Draft Preview placeholders.
          previewContentMode: "normal"
        };

        const result = await prepareRenderProjectWithCopyGuard<{ generatedEntryFile: string }>(options);
        this.throwIfPdfExportCancelled();
        const tabsToOverlay = this.deps.openTabs()
          .filter(tab => tab.contentLoaded)
          .filter(tab => tab.path.toLowerCase().endsWith(".typ"))
          .filter(tab => relativeFilePath(workspaceRootPath, this.deps.mapToOriginalPath(tab.path)) !== null);

        for (const tab of tabsToOverlay) {
          const originalTabPath = this.deps.mapToOriginalPath(tab.path);
          const sourceCode = filePathKey(originalTabPath) === filePathKey(originalActivePath)
            ? content
            : tab.content;
          await invoke("prepare_render_file", {
            options,
            filePath: originalTabPath,
            sourceCode
          });
          this.throwIfPdfExportCancelled();
        }

        targetFilePath = result.generatedEntryFile;
        targetContent = await invoke<string>("read_workspace_file", { path: targetFilePath }).catch(() => "");
      }
      this.throwIfPdfExportCancelled();

      const pdfPath = await invoke<string>("compile_typst_document", {
        operationId,
        sourceCode: targetContent,
        filePath: targetFilePath,
      });
      this.throwIfPdfExportCancelled();
      this.activePdfOperationId = null;
      this.updatePdfExportAction(false);
      this.deps.setLspStatus({
        kind: "running",
        message: `Finalizing PDF export with ${provenance.displayName}...`,
      });
      await invoke("commit_pdf_export", { operationId, source: pdfPath, destination: exportPdfPath });
      this.deps.setLspStatus({
        kind: "preview-ready",
        message: `Exported with ${provenance.displayName} to ${destinationName(exportPdfPath)}`,
      });
      this.deps.log("info", pdfExportProvenanceLog(provenance, "success", exportPdfPath));
    } catch (error) {
      if (error instanceof RenderCacheCopyCancelled || isPdfExportCancellation(error)) {
        this.deps.setLspStatus({
          kind: "preview-ready",
          message: provenance ? `${provenance.displayName} export cancelled` : "PDF export cancelled",
        });
        if (provenance) this.deps.log("info", pdfExportProvenanceLog(provenance, "cancelled", exportPdfPath ?? undefined));
        return;
      }
      this.deps.setLspStatus({
        kind: "error",
        message: provenance
          ? `${provenance.displayName} export failed: ${error}`
          : `PDF export failed before compiler selection: ${error}`,
      });
      if (provenance) {
        this.deps.log("error", pdfExportProvenanceLog(provenance, "failure", exportPdfPath ?? undefined));
      }
    } finally {
      if (operationId) {
        await invoke("finish_pdf_export_operation", { operationId }).catch(() => {});
      }
      this.activePdfOperationId = null;
      this.activePdfProvenance = null;
      this.pdfCancellationRequested = false;
      this.updatePdfExportAction(false);
      this.busy = false;
    }
  }

  private async cancelPdfExport(): Promise<void> {
    const operationId = this.activePdfOperationId;
    if (!operationId || this.pdfCancellationRequested) return;
    this.pdfCancellationRequested = true;
    this.deps.setLspStatus({
      kind: "running",
      message: this.activePdfProvenance
        ? `Cancelling ${this.activePdfProvenance.displayName} export...`
        : "Cancelling PDF export...",
    });
    await invoke("cancel_pdf_export", { operationId }).catch(error => {
      console.error("Failed to terminate PDF export process:", error);
    });
  }

  private throwIfPdfExportCancelled(): void {
    if (this.pdfCancellationRequested) throw new PdfExportCancelled();
  }

  private updatePdfExportAction(running: boolean): void {
    const label = running ? "Cancel PDF Export" : "Export PDF";
    const menuItem = document.getElementById("action-export-pdf");
    if (menuItem) menuItem.textContent = label;
    for (const button of document.querySelectorAll<HTMLElement>('[data-tool="export-pdf"]')) {
      button.title = label;
      button.setAttribute("aria-label", label);
      button.classList.toggle("is-cancelling-action", running);
    }
  }

  async exportProjectArchive(): Promise<void> {
    const workspaceRootPath = this.deps.workspaceRootPath();
    if (!workspaceRootPath) {
      alert("Please open a project first.");
      return;
    }
    if (this.deps.openTabs().some(tab => tab.isDirty)) {
      await message("Save all modified files before exporting so the archive matches the editor.", {
        title: "Unsaved Files",
        kind: "warning"
      });
      return;
    }

    const activeFilePath = this.deps.activeFilePath();
    const mainFilePath = this.deps.previewMainPath() ?? (
      activeFilePath?.toLowerCase().endsWith(".typ") ? activeFilePath : null
    );
    if (!mainFilePath) {
      await message("Set or open the project's main Typst file before exporting a version-bound project.", {
        title: "Main File Required",
        kind: "warning"
      });
      return;
    }

    this.busy = true;
    try {
      const folderName = workspaceRootPath.split(/[/\\]/).pop() || "workspace";
      const selected = await save({
        filters: [{ name: "Typsastra Project", extensions: ["typsastra"] }],
        defaultPath: `${folderName}.typsastra`
      });
      if (selected) {
        this.deps.setLspStatus({ kind: "running", message: "Exporting Typsastra project..." });
        await invoke("export_typsastra_project", {
          workspacePath: workspaceRootPath,
          archivePath: selected,
          mainFilePath
        });
        this.deps.setLspStatus({
          kind: "preview-ready",
          message: `Typsastra project exported to ${selected}. Font files were not included.`
        });
      }
    } catch (error) {
      this.deps.setLspStatus({ kind: "error", message: `Project export failed: ${error}` });
      await message(String(error), { title: "Typsastra Project Export Failed", kind: "error" });
    } finally {
      this.busy = false;
    }
  }

  async exportSourceZip(): Promise<void> {
    const workspaceRootPath = this.deps.workspaceRootPath();
    if (!workspaceRootPath) {
      alert("Please open a project first.");
      return;
    }
    if (this.deps.openTabs().some(tab => tab.isDirty)) {
      await message("Save all modified files before exporting so the ZIP matches the editor.", {
        title: "Unsaved Files",
        kind: "warning"
      });
      return;
    }

    this.busy = true;
    try {
      const folderName = workspaceRootPath.split(/[/\\]/).pop() || "workspace";
      const selected = await save({
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
        defaultPath: `${folderName}.zip`
      });
      if (selected) {
        this.deps.setLspStatus({ kind: "running", message: "Exporting source ZIP..." });
        await invoke("export_source_zip", {
          workspacePath: workspaceRootPath,
          zipPath: selected
        });
        this.deps.setLspStatus({
          kind: "preview-ready",
          message: `Source ZIP exported to ${selected}. Font files were not included.`
        });
      }
    } catch (error) {
      this.deps.setLspStatus({ kind: "error", message: `Source ZIP export failed: ${error}` });
      await message(String(error), { title: "Source ZIP Export Failed", kind: "error" });
    } finally {
      this.busy = false;
    }
  }
}
