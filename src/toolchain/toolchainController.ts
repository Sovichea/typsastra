import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";

export type ToolchainStatus = {
  typstVersion: string | null;
  typstSource: string | null;
  tinymistVersion: string | null;
  tinymistSource: string | null;
  lspAvailable: boolean;
  message: string;
};

type TinymistRelease = {
  version: string;
  publishedAt: string | null;
};

export type SystemToolchain = {
  path: string;
  tinymistVersion: string;
  typstVersion: string;
};

type ToolchainControllerOptions = {
  getSelectedVersion: () => string | null;
  setSelectedVersion: (version: string) => void;
  onToolchainChanged: (status: ToolchainStatus) => void | Promise<void>;
};

export class ToolchainController {
  private status: ToolchainStatus | null = null;
  private releases: TinymistRelease[] = [];
  private systemToolchains: SystemToolchain[] = [];
  private loading = false;

  constructor(private readonly options: ToolchainControllerOptions) {}

  public get isBusy(): boolean {
    return this.loading;
  }

  public initialize() {
    document.getElementById("settings-tinymist-version")?.addEventListener("change", event => {
      const version = (event.currentTarget as HTMLSelectElement).value;
      if (version.startsWith("system:")) {
        const index = Number(version.slice("system:".length));
        const systemToolchain = this.systemToolchains[index];
        if (systemToolchain) void this.selectSystemToolchain(systemToolchain);
      } else if (version && version !== this.status?.tinymistVersion) {
        void this.install(version);
      }
    });
    document.getElementById("settings-toolchain-refresh")?.addEventListener("click", () => {
      void this.refresh(true);
    });
    document.addEventListener("typsastra:settings-opened", () => void this.refresh(false));
    document.querySelector('[data-settings-panel="toolchain"]')?.addEventListener("click", () => {
      void this.refresh(false);
    });
    this.render();
  }

  public setStatus(status: ToolchainStatus) {
    this.status = status;
    this.render();
  }

  public async refresh(forceReleases: boolean) {
    if (this.loading) return;
    this.loading = true;
    this.render("Checking installed tools...");
    let refreshError: string | null = null;
    try {
      const [status, releases, systemToolchains] = await Promise.all([
        invoke<ToolchainStatus>("get_toolchain_status"),
        forceReleases || this.releases.length === 0
          ? invoke<TinymistRelease[]>("list_tinymist_releases")
          : Promise.resolve(this.releases),
        invoke<SystemToolchain[]>("list_system_tinymist_toolchains")
      ]);
      this.status = status;
      this.releases = releases;
      this.systemToolchains = systemToolchains;
      this.render();
    } catch (error) {
      refreshError = `Unable to refresh releases: ${String(error)}`;
    } finally {
      this.loading = false;
      this.render(refreshError ?? undefined, Boolean(refreshError));
    }
  }

  private async selectSystemToolchain(toolchain: SystemToolchain) {
    if (this.loading) return;
    this.loading = true;
    this.render(`Selecting Tinymist ${toolchain.tinymistVersion} from the system PATH...`);
    try {
      const status = await invoke<ToolchainStatus>("select_system_tinymist_toolchain", { path: toolchain.path });
      this.status = status;
      this.options.setSelectedVersion(toolchain.tinymistVersion);
      await this.options.onToolchainChanged(status);
    } catch (error) {
      await message(String(error), { title: t("Toolchain selection failed"), kind: "error" });
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async install(version: string) {
    if (this.loading) return;
    this.loading = true;
    this.render(`Downloading Tinymist ${version}...`);
    try {
      const status = await invoke<ToolchainStatus>("install_tinymist_toolchain", { version });
      this.status = status;
      this.options.setSelectedVersion(version);
      await this.options.onToolchainChanged(status);
    } catch (error) {
      try {
        const status = await invoke<ToolchainStatus>("get_toolchain_status");
        this.status = status;
        if (status.tinymistVersion === version) this.options.setSelectedVersion(version);
        await this.options.onToolchainChanged(status);
      } catch (statusError) {
        console.error("Failed to recover toolchain status after installation error", statusError);
      }
      await message(String(error), { title: t("Toolchain installation failed"), kind: "error" });
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(overrideMessage?: string, isError = false) {
    const select = document.getElementById("settings-tinymist-version") as HTMLSelectElement | null;
    if (select) {
      const current = this.status?.tinymistVersion;
      const versions = [...this.releases];
      if (current && /^\d+\.\d+\.\d+$/.test(current) && !versions.some(release => release.version === current)) {
        versions.unshift({ version: current, publishedAt: null });
      }
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = this.loading && versions.length === 0
        ? t("Loading stable releases...")
        : t("Select a stable version");
      const systemGroup = document.createElement("optgroup");
      systemGroup.label = t("System PATH");
      this.systemToolchains.forEach((toolchain, index) => {
        const option = document.createElement("option");
        option.value = `system:${index}`;
        option.textContent = t`${toolchain.tinymistVersion} · Typst ${toolchain.typstVersion}`;
        option.title = toolchain.path;
        systemGroup.appendChild(option);
      });
      const managedGroup = document.createElement("optgroup");
      managedGroup.label = t("Managed downloads");
      managedGroup.append(...versions.map(release => {
        const option = document.createElement("option");
        option.value = release.version;
        option.textContent = release.version === current
          ? t`${release.version} (current)`
          : release.version;
        return option;
      }));
      select.replaceChildren(
        placeholder,
        ...(this.systemToolchains.length > 0 ? [systemGroup] : []),
        managedGroup
      );
      const selectedSystemIndex = this.systemToolchains.findIndex(toolchain =>
        this.status?.tinymistSource?.includes(toolchain.path)
      );
      select.value = selectedSystemIndex >= 0
        ? `system:${selectedSystemIndex}`
        : current ?? this.options.getSelectedVersion() ?? "";
      select.disabled = this.loading;
    }

    const typstMeta = document.getElementById("settings-typst-current") as HTMLInputElement | null;
    if (typstMeta) typstMeta.value = this.status?.typstVersion ?? t("Not available");
    const tinymistMeta = document.getElementById("settings-tinymist-current");
    if (tinymistMeta) tinymistMeta.textContent = this.status?.tinymistVersion
      ? t`Current: ${this.status.tinymistVersion} · ${this.status.tinymistSource ?? t("Unknown source")}`
      : t("Tinymist is not installed");
    const status = document.getElementById("settings-toolchain-status");
    if (status) {
      status.textContent = overrideMessage ?? (this.status?.message ? t(this.status.message) : t("Open this panel to check tool versions."));
      status.classList.toggle("error", isError);
      status.classList.toggle("warning", !isError && Boolean(this.status && !this.status.lspAvailable));
    }
    const refresh = document.getElementById("settings-toolchain-refresh") as HTMLButtonElement | null;
    if (refresh) refresh.disabled = this.loading;
  }
}
