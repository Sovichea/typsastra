import { invoke } from "@tauri-apps/api/core";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import type { LspStatus } from "../compiler/lsp";
import {
  projectImportDestinationNameError,
  type ImportedTypsastraProject,
  type TypsastraProjectPreflight,
} from "../projectArchive";
import type { ToolchainStatus } from "../toolchain/toolchainController";
import { formatFileSize } from "./largeFileOpening";
import { t } from "../i18n";

export interface ProjectImportControllerPort {
  setStatus(status: LspStatus): void;
  selectToolchainVersion(version: string): void;
  handleToolchainChanged(status: ToolchainStatus): Promise<void>;
  completeImport(imported: ImportedTypsastraProject, projectName: string): Promise<boolean>;
}

type ProjectImportDestination = {
  name: string;
  path: string;
};

/** Owns project archive inspection, destination selection, and extraction. */
export class ProjectImportController {
  constructor(private readonly port: ProjectImportControllerPort) {}

  async importProject(archivePath?: string): Promise<void> {
    const selected = archivePath ?? await open({
      directory: false,
      multiple: false,
      filters: [{ name: t("Typsastra Project"), extensions: ["typsastra", "typstella"] }],
    });
    if (typeof selected !== "string") return;

    try {
      this.port.setStatus({ kind: "starting", message: t("Inspecting Typsastra project...") });
      let inspection = await this.inspect(selected);
      const requiredTinymist = inspection.manifest.toolchain.tinymistVersion;
      const requiredTypst = inspection.manifest.toolchain.typstVersion;
      let allowIncompatibleToolchain = false;

      if (inspection.toolchainState === "exact-installed") {
        const useInstalled = await confirm(
          `This project requires Tinymist ${requiredTinymist} with Typst ${requiredTypst}. `
          + "The compatible version is installed but not active. Use it for this import?",
          {
            title: t("Compatible Toolchain Available"),
            kind: "info",
            okLabel: t("Use Compatible Version"),
            cancelLabel: t("Other Options"),
          },
        );
        if (useInstalled) {
          const status = await invoke<ToolchainStatus>("select_project_toolchain", {
            tinymistVersion: requiredTinymist,
            typstVersion: requiredTypst,
          });
          this.port.selectToolchainVersion(requiredTinymist);
          await this.port.handleToolchainChanged(status);
          inspection = await this.inspect(selected);
        } else {
          allowIncompatibleToolchain = await this.confirmIncompatibleImport(inspection);
          if (!allowIncompatibleToolchain) return;
        }
      } else if (inspection.toolchainState === "download-required") {
        const result = await this.resolveMissingToolchain(inspection, selected);
        if (!result) return;
        inspection = result.inspection;
        allowIncompatibleToolchain = result.allowIncompatible;
      }

      if (!allowIncompatibleToolchain && inspection.toolchainState !== "exact-active") {
        throw new Error("The required project toolchain could not be activated.");
      }
      const destinationParent = await open({
        directory: true,
        multiple: false,
        title: t("Choose where to import the project"),
      });
      if (typeof destinationParent !== "string") return;
      const destination = await this.chooseDestination(inspection, destinationParent);
      if (!destination) return;

      this.port.setStatus({ kind: "starting", message: t("Verifying and importing project...") });
      const imported = await this.runCancellableImport({
        archivePath: selected,
        destinationPath: destination.path,
        expectedManifestSha256: inspection.manifestSha256,
        allowIncompatibleToolchain,
      });
      const completedInWorkspace = await this.port.completeImport(imported, destination.name);
      if (!completedInWorkspace) {
        await message(t`The project was imported to:\n\n${imported.workspacePath}`, {
          title: t("Project Imported"),
          kind: "info",
        });
      }
    } catch (error) {
      this.port.setStatus({ kind: "error", message: t`Project import failed: ${error}` });
      await message(String(error), { title: t("Typsastra Project Import Failed"), kind: "error" });
    }
  }

  private inspect(archivePath: string): Promise<TypsastraProjectPreflight> {
    return invoke<TypsastraProjectPreflight>("inspect_typsastra_project", { archivePath });
  }

  private async resolveMissingToolchain(
    inspection: TypsastraProjectPreflight,
    archivePath: string,
  ): Promise<{ inspection: TypsastraProjectPreflight; allowIncompatible: boolean } | null> {
    const requiredTinymist = inspection.manifest.toolchain.tinymistVersion;
    const requiredTypst = inspection.manifest.toolchain.typstVersion;
    const downloadCompatible = await confirm(
      `This project was exported with Tinymist ${requiredTinymist}, which embeds Typst ${requiredTypst}. `
      + "Download and activate that compatible version before importing?",
      {
        title: t("Compatible Toolchain Required"),
        kind: "info",
        okLabel: t("Download Compatible Version"),
        cancelLabel: t("Other Options"),
      },
    );
    if (!downloadCompatible) {
      const allowIncompatible = await this.confirmIncompatibleImport(inspection);
      return allowIncompatible ? { inspection, allowIncompatible } : null;
    }

    try {
      this.port.setStatus({
        kind: "starting",
        message: t`Downloading Tinymist ${requiredTinymist} for imported project...`,
      });
      const status = await invoke<ToolchainStatus>("install_tinymist_toolchain", {
        version: requiredTinymist,
      });
      const exact = status.tinymistVersion === requiredTinymist
        && status.typstVersion === requiredTypst;
      await this.port.handleToolchainChanged(status);
      if (!exact) {
        const mismatchedInspection = {
          ...inspection,
          activeTinymistVersion: status.tinymistVersion,
          activeTypstVersion: status.typstVersion,
        };
        const useMismatch = await confirm(
          `Downloaded Tinymist ${status.tinymistVersion ?? "unknown"} reports Typst `
          + `${status.typstVersion ?? "unknown"}, but the project requires Typst ${requiredTypst}.\n\n`
          + "Import with this incompatible version anyway?",
          {
            title: t("Downloaded Toolchain Is Incompatible"),
            kind: "warning",
            okLabel: t("Import Anyway"),
            cancelLabel: t("Cancel"),
          },
        );
        return useMismatch
          ? { inspection: mismatchedInspection, allowIncompatible: true }
          : null;
      }
      this.port.selectToolchainVersion(requiredTinymist);
      return { inspection: await this.inspect(archivePath), allowIncompatible: false };
    } catch (downloadError) {
      const recovered = await invoke<ToolchainStatus>("get_toolchain_status").catch(() => null);
      let recoveredInspection = inspection;
      if (recovered) {
        await this.port.handleToolchainChanged(recovered);
        recoveredInspection = {
          ...inspection,
          activeTinymistVersion: recovered.tinymistVersion,
          activeTypstVersion: recovered.typstVersion,
        };
      }
      const importAfterFailure = await confirm(
        `The compatible toolchain could not be downloaded or verified.\n\n${String(downloadError)}\n\n`
        + "Import with the current environment without a compatibility guarantee?",
        {
          title: t("Compatible Toolchain Unavailable"),
          kind: "warning",
          okLabel: t("Import Anyway"),
          cancelLabel: t("Cancel"),
        },
      );
      return importAfterFailure
        ? { inspection: recoveredInspection, allowIncompatible: true }
        : null;
    }
  }

  private chooseDestination(
    inspection: TypsastraProjectPreflight,
    parentPath: string,
  ): Promise<ProjectImportDestination | null> {
    const overlay = document.getElementById("project-import-overlay");
    const closeButton = document.getElementById("project-import-close") as HTMLButtonElement | null;
    const cancelButton = document.getElementById("project-import-cancel") as HTMLButtonElement | null;
    const confirmButton = document.getElementById("project-import-confirm") as HTMLButtonElement | null;
    const input = document.getElementById("project-import-name") as HTMLInputElement | null;
    const originalName = document.getElementById("project-import-original-name");
    const parent = document.getElementById("project-import-parent");
    const resolvedPath = document.getElementById("project-import-path");
    const validation = document.getElementById("project-import-name-error");
    const details = document.getElementById("project-import-details");
    if (
      !overlay || !closeButton || !cancelButton || !confirmButton || !input
      || !originalName || !parent || !resolvedPath || !validation || !details
    ) {
      return Promise.reject(new Error("The project import dialog is unavailable."));
    }

    originalName.textContent = inspection.manifest.project.name;
    parent.textContent = parentPath;
    details.textContent = t`${inspection.entryCount} archive entries · ${formatFileSize(inspection.totalUncompressedBytes)} uncompressed`;
    input.value = inspection.suggestedFolderName;
    resolvedPath.textContent = "";
    validation.textContent = "";
    confirmButton.disabled = true;
    overlay.classList.remove("hidden");

    return new Promise(resolve => {
      let validationSequence = 0;
      let validationTimer: ReturnType<typeof setTimeout> | null = null;
      let acceptedPath: string | null = null;
      let settled = false;

      const finish = (result: ProjectImportDestination | null) => {
        if (settled) return;
        settled = true;
        validationSequence += 1;
        if (validationTimer !== null) clearTimeout(validationTimer);
        input.removeAttribute("aria-busy");
        overlay.classList.add("hidden");
        closeButton.removeEventListener("click", cancel);
        cancelButton.removeEventListener("click", cancel);
        confirmButton.removeEventListener("click", accept);
        input.removeEventListener("input", validate);
        overlay.removeEventListener("pointerdown", backdropCancel);
        document.removeEventListener("keydown", onKeyDown, true);
        resolve(result);
      };
      const cancel = () => finish(null);
      const previewDestinationPath = (name: string) => {
        const separator = parentPath.includes("\\") && !parentPath.includes("/") ? "\\" : "/";
        return `${parentPath.replace(/[\\/]+$/u, "")}${separator}${name}`;
      };
      const backdropCancel = (event: PointerEvent) => {
        if (event.target === overlay) cancel();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        } else if (event.key === "Enter" && event.target === input && !confirmButton.disabled) {
          event.preventDefault();
          accept();
        }
      };
      const runValidation = (delay: number, acceptWhenValid = false) => {
        const sequence = ++validationSequence;
        const name = input.value;
        if (validationTimer !== null) {
          clearTimeout(validationTimer);
          validationTimer = null;
        }
        acceptedPath = null;
        validation.textContent = "";
        input.removeAttribute("aria-busy");
        const localError = projectImportDestinationNameError(name);
        if (localError) {
          confirmButton.disabled = true;
          input.setAttribute("aria-invalid", "true");
          validation.textContent = localError;
          return;
        }
        input.removeAttribute("aria-invalid");
        resolvedPath.textContent = previewDestinationPath(name);
        confirmButton.disabled = false;
        input.setAttribute("aria-busy", "true");
        validationTimer = setTimeout(() => {
          validationTimer = null;
          void invoke<string>("validate_typsastra_project_import_destination", {
            parentPath,
            projectName: name,
          }).then(path => {
            if (settled || sequence !== validationSequence) return;
            input.removeAttribute("aria-busy");
            acceptedPath = path;
            resolvedPath.textContent = path;
            confirmButton.disabled = false;
            if (acceptWhenValid) finish({ name, path });
          }).catch(error => {
            if (settled || sequence !== validationSequence) return;
            input.removeAttribute("aria-busy");
            confirmButton.disabled = true;
            input.setAttribute("aria-invalid", "true");
            validation.textContent = String(error);
          });
        }, delay);
      };
      const validate = () => runValidation(180);
      const accept = () => {
        if (confirmButton.disabled) return;
        if (acceptedPath) {
          finish({ name: input.value, path: acceptedPath });
          return;
        }
        runValidation(0, true);
      };

      closeButton.addEventListener("click", cancel);
      cancelButton.addEventListener("click", cancel);
      confirmButton.addEventListener("click", accept);
      input.addEventListener("input", validate);
      overlay.addEventListener("pointerdown", backdropCancel);
      document.addEventListener("keydown", onKeyDown, true);
      validate();
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  }

  private async runCancellableImport(args: {
    archivePath: string;
    destinationPath: string;
    expectedManifestSha256: string;
    allowIncompatibleToolchain: boolean;
  }): Promise<ImportedTypsastraProject> {
    const operationId = crypto.randomUUID();
    const progress = document.createElement("div");
    progress.setAttribute("role", "status");
    progress.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:10000;display:flex;gap:12px;align-items:center;padding:12px 14px;border:1px solid var(--ui-hover);border-radius:8px;background:var(--ui-bg);color:var(--ui-text);box-shadow:0 8px 24px rgba(0,0,0,.3)";
    const label = document.createElement("span");
    label.textContent = t("Verifying and extracting Typsastra project…");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("Cancel");
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      label.textContent = t("Cancelling import safely…");
      void invoke("cancel_typsastra_project_import", { operationId });
    });
    progress.append(label, cancel);
    document.body.appendChild(progress);
    try {
      return await invoke<ImportedTypsastraProject>("import_typsastra_project", {
        ...args,
        operationId,
      });
    } finally {
      progress.remove();
    }
  }

  private confirmIncompatibleImport(inspection: TypsastraProjectPreflight): Promise<boolean> {
    const active = inspection.activeTinymistVersion && inspection.activeTypstVersion
      ? `Current: Tinymist ${inspection.activeTinymistVersion}, Typst ${inspection.activeTypstVersion}.`
      : "No validated toolchain is currently active.";
    return confirm(
      `The project requires Tinymist ${inspection.manifest.toolchain.tinymistVersion} with `
      + `Typst ${inspection.manifest.toolchain.typstVersion}. ${active}\n\n`
      + "Importing with the current environment is allowed, but rendering compatibility is not guaranteed.",
      {
        title: t("Import Without Compatibility Guarantee?"),
        kind: "warning",
        okLabel: t("Import Anyway"),
        cancelLabel: t("Cancel"),
      },
    );
  }
}
