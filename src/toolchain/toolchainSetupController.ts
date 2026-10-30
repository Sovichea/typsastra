import type { SystemToolchain, ToolchainStatus } from "./toolchainController";
import { setLocalizedHtml, t } from "../i18n";

type TinymistRelease = { version: string; publishedAt: string | null };

export type ToolchainInstallProgress = {
  phase: "resolving" | "downloading" | "installing" | "verifying" | "complete";
  downloadedBytes: number;
  totalBytes: number | null;
};

export interface ToolchainSetupDependencies {
  listReleases(): Promise<TinymistRelease[]>;
  listSystemToolchains(): Promise<SystemToolchain[]>;
  install(version: string, onProgress: (progress: ToolchainInstallProgress) => void): Promise<ToolchainStatus>;
  selectSystemToolchain(path: string): Promise<ToolchainStatus>;
  closeWindow(): Promise<void>;
  showInstallError(error: unknown): Promise<void>;
  showSelectionError(error: unknown): Promise<void>;
}

export class ToolchainSetupController {
  private systemToolchains: SystemToolchain[] = [];

  constructor(private readonly deps: ToolchainSetupDependencies) {}

  async show(): Promise<ToolchainStatus | null> {
    return new Promise<ToolchainStatus | null>(resolve => {
      const overlay = document.getElementById("toolchain-setup-overlay");
      const versionSelect = document.getElementById("toolchain-version-select") as HTMLSelectElement | null;
      const versionHint = document.getElementById("toolchain-version-hint");
      const downloadBtn = document.getElementById("toolchain-download-btn") as HTMLButtonElement | null;
      const exitBtn = document.getElementById("toolchain-exit-btn") as HTMLButtonElement | null;
      const progressContainer = document.getElementById("toolchain-progress-container");
      const progressLabel = document.getElementById("toolchain-progress-label");
      const progressBar = document.getElementById("toolchain-progress-bar") as HTMLElement | null;
      const actions = document.getElementById("toolchain-setup-actions");
      const versionPicker = document.getElementById("toolchain-version-picker");

      if (!overlay || !versionSelect || !downloadBtn || !exitBtn || !progressContainer || !progressBar || !actions || !progressLabel || !versionHint || !versionPicker) {
        resolve(null);
        return;
      }

      overlay.classList.remove("hidden");
      void this.populateToolchains(versionSelect, versionHint);

      versionSelect.addEventListener("change", () => {
        const hasSelection = Boolean(versionSelect.value);
        downloadBtn.disabled = !hasSelection;
        downloadBtn.textContent = versionSelect.value.startsWith("system:") ? t("Use Toolchain") : t("Download");
        downloadBtn.style.opacity = hasSelection ? "1" : "0.55";
        downloadBtn.style.cursor = hasSelection ? "pointer" : "default";
      });
      exitBtn.addEventListener("click", () => { void this.deps.closeWindow(); });
      downloadBtn.addEventListener("click", () => {
        const selection = versionSelect.value;
        if (!selection) return;
        if (selection.startsWith("system:")) {
          void this.selectSystemToolchain(selection, overlay, downloadBtn, resolve);
          return;
        }
        void this.installSelectedVersion({
          selectedVersion: selection.slice("managed:".length),
          overlay,
          versionPicker,
          actions,
          progressContainer,
          progressLabel,
          progressBar,
          resolve,
        });
      });
    });
  }

  private async populateToolchains(versionSelect: HTMLSelectElement, versionHint: HTMLElement): Promise<void> {
    const [systemResult, releaseResult] = await Promise.allSettled([
      this.deps.listSystemToolchains(),
      this.deps.listReleases(),
    ]);
    this.systemToolchains = systemResult.status === "fulfilled" ? systemResult.value : [];
    const releases = releaseResult.status === "fulfilled" ? releaseResult.value : [];

    versionSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("Select a toolchain...");
    versionSelect.appendChild(placeholder);

    if (this.systemToolchains.length > 0) {
      const group = document.createElement("optgroup");
      group.label = "System PATH";
      this.systemToolchains.forEach((toolchain, index) => {
        const option = document.createElement("option");
        option.value = `system:${index}`;
        option.textContent = t`Tinymist ${toolchain.tinymistVersion} (Typst ${toolchain.typstVersion})`;
        option.title = toolchain.path;
        group.appendChild(option);
      });
      versionSelect.appendChild(group);
    }

    if (releases.length > 0) {
      const group = document.createElement("optgroup");
      group.label = "Managed downloads";
      for (const release of releases) {
        const option = document.createElement("option");
        option.value = `managed:${release.version}`;
        option.textContent = release.version;
        group.appendChild(option);
      }
      versionSelect.appendChild(group);
    }

    if (this.systemToolchains.length > 0) {
      versionHint.textContent = t`${this.systemToolchains.length} system installation${this.systemToolchains.length === 1 ? "" : "s"} detected. Managed downloads remain available below.`;
    } else if (releases.length > 0) {
      versionHint.textContent = t`${releases.length} stable releases available. The latest is ${releases[0]?.version ?? "unknown"}.`;
    } else {
      setLocalizedHtml(versionSelect, "<option value=\"\">Failed to load releases</option>");
      versionHint.textContent = t("No system Tinymist was detected and GitHub could not be reached.");
    }
  }

  private async selectSystemToolchain(
    selection: string,
    overlay: HTMLElement,
    downloadBtn: HTMLButtonElement,
    resolve: (status: ToolchainStatus | null) => void,
  ): Promise<void> {
    const toolchain = this.systemToolchains[Number(selection.slice("system:".length))];
    if (!toolchain) return;
    downloadBtn.disabled = true;
    try {
      const status = await this.deps.selectSystemToolchain(toolchain.path);
      overlay.classList.add("hidden");
      resolve(status);
    } catch (error) {
      await this.deps.showSelectionError(error);
      downloadBtn.disabled = false;
    }
  }

  private async installSelectedVersion(args: {
    selectedVersion: string;
    overlay: HTMLElement;
    versionPicker: HTMLElement;
    actions: HTMLElement;
    progressContainer: HTMLElement;
    progressLabel: HTMLElement;
    progressBar: HTMLElement;
    resolve(status: ToolchainStatus | null): void;
  }): Promise<void> {
    const { selectedVersion, overlay, versionPicker, actions, progressContainer, progressLabel, progressBar, resolve } = args;
    versionPicker.classList.add("hidden");
    actions.classList.add("hidden");
    progressContainer.classList.remove("hidden");

    progressBar.style.width = "0%";
    progressLabel.textContent = t`Preparing Tinymist ${selectedVersion}...`;

    try {
      const status = await this.deps.install(selectedVersion, progress => {
        this.renderInstallProgress(progress, progressLabel, progressBar);
      });
      progressBar.style.width = "100%";
      progressLabel.textContent = t("Installation complete!");
      await new Promise<void>(done => window.setTimeout(done, 700));
      overlay.classList.add("hidden");
      resolve(status);
    } catch (error) {
      progressBar.style.width = "0%";
      progressLabel.textContent = t("Installation failed. Please try again.");
      await this.deps.showInstallError(error);
      progressContainer.classList.add("hidden");
      versionPicker.classList.remove("hidden");
      actions.classList.remove("hidden");
    }
  }

  private renderInstallProgress(
    progress: ToolchainInstallProgress,
    label: HTMLElement,
    bar: HTMLElement,
  ): void {
    if (progress.phase === "resolving") {
      label.textContent = t("Resolving Tinymist release...");
      bar.style.width = "3%";
      return;
    }
    if (progress.phase === "downloading") {
      const total = progress.totalBytes;
      const ratio = total && total > 0 ? Math.min(1, progress.downloadedBytes / total) : null;
      bar.style.width = `${ratio === null ? 8 : 5 + ratio * 80}%`;
      label.textContent = total
        ? t`Downloading Tinymist... ${formatBytes(progress.downloadedBytes)} of ${formatBytes(total)}`
        : t`Downloading Tinymist... ${formatBytes(progress.downloadedBytes)}`;
      return;
    }
    if (progress.phase === "installing") {
      label.textContent = t("Installing downloaded toolchain...");
      bar.style.width = "88%";
      return;
    }
    if (progress.phase === "verifying") {
      label.textContent = t("Verifying embedded Typst compiler...");
      bar.style.width = "95%";
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KiB`;
  return `${Math.max(0, bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
