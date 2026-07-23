import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { AppDialogController } from "./ui/appDialog";

type UpdateState = "available" | "downloading" | "ready" | "installing";

export class AppUpdateController {
  private readonly badge = document.getElementById("app-update-badge") as HTMLButtonElement | null;
  private update: Update | null = null;
  private availableVersion: string | null = null;
  private developmentSimulation = false;
  private state: UpdateState = "available";

  constructor(
    private readonly hasUnsavedChanges: () => boolean = () => false,
    private readonly dialog = new AppDialogController()
  ) {}

  public get isInstalling(): boolean {
    return this.state === "downloading" || this.state === "installing";
  }

  public initialize(): void {
    if (!this.badge) return;
    this.badge.addEventListener("click", () => void this.handleBadgeClick());

    const simulatedVersion = developmentUpdateVersion();
    if (simulatedVersion) {
      this.developmentSimulation = true;
      this.showAvailableVersion(simulatedVersion);
      return;
    }
    void this.checkSilently();
  }

  private async checkSilently(): Promise<void> {
    try {
      const update = await check({ timeout: 10_000 });
      if (!update) return;
      this.update = update;
      this.showAvailableVersion(update.version);
    } catch (error) {
      // Startup update checks are intentionally silent. Network or endpoint
      // failures must never interrupt opening a local workspace.
      console.debug("Typsastra update check skipped:", error);
    }
  }

  private showAvailableVersion(rawVersion: string): void {
    if (!this.badge) return;
    this.availableVersion = rawVersion;
    this.state = "available";
    const version = displayVersion(rawVersion);
    this.badge.textContent = `Update ${version}`;
    this.badge.title = this.developmentSimulation
      ? `Test Typsastra ${version} update flow (development simulation)`
      : `Typsastra ${version} is available`;
    this.badge.hidden = false;
  }

  private async handleBadgeClick(): Promise<void> {
    if (this.state === "ready") {
      await this.confirmAndRestart();
      return;
    }
    if (this.state === "available") await this.confirmAndDownload();
  }

  private async confirmAndDownload(): Promise<void> {
    if (!this.availableVersion || !this.badge || this.state !== "available") return;
    const action = await this.dialog.show({
      title: "Download Typsastra Update",
      subtitle: `${displayVersion(this.availableVersion)} is available`,
      description: "Download the update now? You can continue working and choose when to restart after the download finishes.",
      actions: [
        { id: "later", label: "Later" },
        { id: "download", label: "Download Update", primary: true }
      ],
      cancelAction: "later"
    });
    if (action !== "download") return;

    this.state = "downloading";
    this.badge.disabled = true;
    this.badge.textContent = "Downloading...";

    if (this.developmentSimulation) {
      await this.simulateDownload();
      return;
    }
    if (!this.update) return;

    let downloaded = 0;
    let contentLength: number | undefined;
    try {
      await this.update.download(event => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength && contentLength > 0) {
            const percent = Math.min(100, Math.round((downloaded / contentLength) * 100));
            this.badge!.textContent = `Downloading ${percent}%`;
          }
        }
      });
      this.markReady();
    } catch (error) {
      console.error("Failed to download Typsastra update:", error);
      await this.showNotice({
        title: "Update Download Failed",
        description: `The update could not be downloaded.\n\n${String(error)}`
      });
      this.resetAvailableBadge();
    }
  }

  private async confirmAndRestart(): Promise<void> {
    if (!this.availableVersion || this.state !== "ready") return;
    const unsavedWarning = this.hasUnsavedChanges()
      ? "\n\nYou have unsaved changes. Save them before restarting or they will be lost."
      : "";
    const action = await this.dialog.show({
      title: "Restart to Update",
      subtitle: `${displayVersion(this.availableVersion)} is ready to install`,
      description: `Install the update and restart Typsastra now?${unsavedWarning}`,
      actions: [
        { id: "later", label: "Later" },
        { id: "restart", label: "Restart to Update", primary: true }
      ],
      cancelAction: "later"
    });
    if (action === "restart") await this.installDownloaded(true);
  }

  public async prepareForClose(): Promise<boolean> {
    if (this.state === "installing") {
      await this.showNotice({
        title: "Update in Progress",
        description: "Typsastra is installing an update. Please wait for installation to finish."
      });
      return false;
    }
    if (this.state === "downloading") {
      const action = await this.dialog.show({
        title: "Update Download in Progress",
        description: "Typsastra is still downloading an update. Close now and discard this download?",
        actions: [
          { id: "keep", label: "Keep Downloading" },
          { id: "close", label: "Close Typsastra", primary: true }
        ],
        cancelAction: "keep"
      });
      return action === "close";
    }
    if (this.state !== "ready") return true;

    const choice = await this.dialog.show({
      title: "Update ready",
      subtitle: "Choose whether to install it before Typsastra closes",
      description: "The downloaded update has been verified and is ready to install. You can install it now, close without updating, or return to Typsastra.",
      actions: [
        { id: "skip", label: "Close Without Updating" },
        { id: "cancel", label: "Cancel" },
        { id: "install", label: "Install and Close", primary: true }
      ],
      cancelAction: "cancel"
    });
    if (choice === "cancel") return false;
    if (choice === "skip") return true;
    return this.installDownloaded(false);
  }

  private async installDownloaded(relaunchAfterInstall: boolean): Promise<boolean> {
    if (!this.badge || this.state !== "ready") return false;
    this.state = "installing";
    this.badge.disabled = true;
    this.badge.textContent = "Installing...";

    if (this.developmentSimulation) {
      await delay(350);
      await this.showNotice({
        title: "Update Test Complete",
        description: relaunchAfterInstall
          ? "Development update simulation completed. Typsastra was not restarted."
          : "Development update simulation completed. Typsastra will now close without modifying the installed application."
      });
      if (relaunchAfterInstall) this.markReady();
      return true;
    }
    if (!this.update) {
      this.markReady();
      return false;
    }

    try {
      await this.update.install();
      if (relaunchAfterInstall) await relaunch();
      return true;
    } catch (error) {
      console.error("Failed to install Typsastra update:", error);
      await this.showNotice({
        title: "Update Failed",
        description: `The update could not be installed.\n\n${String(error)}`
      });
      this.markReady();
      return false;
    }
  }

  private async simulateDownload(): Promise<void> {
    for (const percent of [20, 45, 70, 100]) {
      await delay(180);
      this.badge!.textContent = `Downloading ${percent}%`;
    }
    await delay(220);
    this.markReady();
  }

  private markReady(): void {
    if (!this.badge || !this.availableVersion) return;
    this.state = "ready";
    this.badge.disabled = false;
    this.badge.textContent = "Restart to update";
    this.badge.title = `Restart to install Typsastra ${displayVersion(this.availableVersion)}`;
  }

  private resetAvailableBadge(): void {
    if (!this.badge || !this.availableVersion) return;
    this.state = "available";
    this.badge.disabled = false;
    this.badge.textContent = `Update ${displayVersion(this.availableVersion)}`;
  }

  private async showNotice(options: { title: string; description: string }): Promise<void> {
    await this.dialog.show({
      title: options.title,
      description: options.description,
      actions: [
        { id: "dismiss", label: "OK", primary: true }
      ],
      cancelAction: "dismiss"
    });
  }
}

function displayVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function developmentUpdateVersion(): string | null {
  if (!import.meta.env.DEV) return null;
  const version = new URLSearchParams(window.location.search).get("test-app-update")?.trim();
  return version && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}
