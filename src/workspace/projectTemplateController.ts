import { invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import { open as openExternalUrl } from "@tauri-apps/plugin-shell";
import type { LspStatus } from "../compiler/lsp";
import { projectImportDestinationNameError } from "../projectArchive";
import {
  UNIVERSE_TEMPLATES_URL,
  filterTemplates,
  findDownloadedTemplate,
  templateCatalogStatus,
  type CreatedProject,
  type LocalTemplate,
  type TemplateCatalog,
  type TemplateTab,
  type UniverseTemplate,
} from "../projectTemplates";

export interface ProjectTemplateControllerPort {
  setStatus(status: LspStatus): void;
  completeCreatedProject(project: CreatedProject): Promise<boolean>;
}

type Selection =
  | { kind: "blank" }
  | { kind: "universe"; item: UniverseTemplate }
  | { kind: "local"; item: LocalTemplate };

type Elements = {
  overlay: HTMLElement;
  close: HTMLButtonElement;
  cancel: HTMLButtonElement;
  back: HTMLButtonElement;
  create: HTMLButtonElement;
  search: HTMLInputElement;
  universe: HTMLButtonElement;
  refresh: HTMLButtonElement;
  add: HTMLButtonElement;
  status: HTMLElement;
  list: HTMLElement;
  browser: HTMLElement;
  destination: HTMLElement;
  chosen: HTMLElement;
  name: HTMLInputElement;
  nameError: HTMLElement;
  path: HTMLElement;
  location: HTMLButtonElement;
  parent: HTMLElement;
  tabs: HTMLButtonElement[];
};

/** Owns the "Create New Project" template browser and destination flow. */
export class ProjectTemplateController {
  private elements: Elements | null = null;
  private universe: UniverseTemplate[] = [];
  private offline: LocalTemplate[] = [];
  private user: LocalTemplate[] = [];
  private activeTab: TemplateTab = "all";
  private query = "";
  private selection: Selection | null = null;
  private step: "browse" | "destination" = "browse";
  private parentPath: string | null = null;
  private busy = false;
  private loaded = false;
  private universeOffline = false;
  private universeError = false;

  constructor(private readonly port: ProjectTemplateControllerPort) {}

  initialize(): void {
    const overlay = document.getElementById("project-template-overlay");
    const close = document.getElementById("project-template-close") as HTMLButtonElement | null;
    const cancel = document.getElementById("project-template-cancel") as HTMLButtonElement | null;
    const back = document.getElementById("project-template-back") as HTMLButtonElement | null;
    const create = document.getElementById("project-template-create") as HTMLButtonElement | null;
    const search = document.getElementById("project-template-search") as HTMLInputElement | null;
    const universe = document.getElementById("project-template-universe") as HTMLButtonElement | null;
    const refresh = document.getElementById("project-template-refresh") as HTMLButtonElement | null;
    const add = document.getElementById("project-template-add") as HTMLButtonElement | null;
    const status = document.getElementById("project-template-status");
    const list = document.getElementById("project-template-list");
    const browser = overlay?.querySelector<HTMLElement>(".project-template-browser") ?? null;
    const destination = overlay?.querySelector<HTMLElement>(".project-template-destination") ?? null;
    const chosen = document.getElementById("project-template-chosen");
    const name = document.getElementById("project-template-name") as HTMLInputElement | null;
    const nameError = document.getElementById("project-template-name-error");
    const path = document.getElementById("project-template-path");
    const location = document.getElementById("project-template-location") as HTMLButtonElement | null;
    const parent = document.getElementById("project-template-parent");
    const tabs = [...(overlay?.querySelectorAll<HTMLButtonElement>(".project-template-tab") ?? [])];
    if (
      !overlay || !close || !cancel || !back || !create || !search || !universe || !refresh || !add
      || !status || !list || !browser || !destination || !chosen || !name || !nameError
      || !path || !location || !parent
    ) {
      return;
    }
    this.elements = {
      overlay, close, cancel, back, create, search, universe, refresh, add, status, list, browser,
      destination, chosen, name, nameError, path, location, parent, tabs,
    };

    close.addEventListener("click", () => this.close());
    cancel.addEventListener("click", () => this.close());
    back.addEventListener("click", () => this.showBrowse());
    create.addEventListener("click", () => void this.advance());
    location.addEventListener("click", () => void this.chooseLocation());
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
    });
    universe.addEventListener("click", () => {
      void openExternalUrl(UNIVERSE_TEMPLATES_URL);
    });
    refresh.addEventListener("click", () => void this.load(true));
    add.addEventListener("click", () => void this.addUserTemplate());
    overlay.addEventListener("pointerdown", event => {
      if (event.target === overlay) this.close();
    });
    for (const tab of tabs) {
      tab.addEventListener("click", () => this.setTab((tab.dataset.templateTab ?? "all") as TemplateTab));
    }
    name.addEventListener("input", () => this.validateName());
  }

  open(): void {
    const elements = this.elements;
    if (!elements) return;
    this.query = "";
    elements.search.value = "";
    this.selection = null;
    this.parentPath = null;
    this.showBrowse();
    elements.overlay.classList.remove("hidden");
    void this.load();
    requestAnimationFrame(() => elements.search.focus());
  }

  private close(): void {
    this.elements?.overlay.classList.add("hidden");
  }

  private setTab(tab: TemplateTab): void {
    this.activeTab = tab;
    this.selection = null;
    this.renderTabs();
    this.renderList();
    this.syncCreateButton();
  }

  private renderTabs(): void {
    const elements = this.elements;
    if (!elements) return;
    for (const tab of elements.tabs) {
      const active = tab.dataset.templateTab === this.activeTab;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    elements.add.classList.toggle("hidden", this.activeTab !== "user");
  }

  private async load(refresh = false): Promise<void> {
    const elements = this.elements;
    if (!elements) return;
    this.renderTabs();
    this.renderList();
    if (refresh || !this.loaded) {
      elements.status.textContent = refresh
        ? "Refreshing Typst Universe templates…"
        : "Loading Typst Universe templates…";
      try {
        const catalog = await invoke<TemplateCatalog>("fetch_universe_templates", { refresh });
        this.universe = catalog.templates;
        this.universeOffline = catalog.offline;
        this.universeError = false;
        elements.status.textContent = templateCatalogStatus(catalog);
      } catch (error) {
        this.universeOffline = true;
        this.universeError = true;
        elements.status.textContent =
          `Could not load Typst Universe templates: ${String(error)}. `
          + "Downloaded and user templates are still available.";
      }
    }
    try {
      this.offline = await invoke<LocalTemplate[]>("list_offline_templates");
      this.user = await invoke<LocalTemplate[]>("list_user_templates");
    } catch (error) {
      this.port.setStatus({ kind: "error", message: `Could not read the template library: ${String(error)}` });
    }
    this.loaded = true;
    this.renderList();
  }

  private itemsForTab(): Selection[] {
    if (this.activeTab === "offline") {
      return filterTemplates(this.offline, this.query).map(item => ({ kind: "local", item }));
    }
    if (this.activeTab === "user") {
      return filterTemplates(this.user, this.query).map(item => ({ kind: "local", item }));
    }
    return filterTemplates(this.universe, this.query).map(item => ({ kind: "universe", item }));
  }

  private renderList(): void {
    const elements = this.elements;
    if (!elements) return;
    elements.list.replaceChildren();
    const blank = this.createCard({ kind: "blank" });
    elements.list.appendChild(blank);
    const items = this.itemsForTab();
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "project-template-empty";
      empty.textContent = this.activeTab === "offline"
        ? "No templates downloaded yet. Create a project from the All templates tab to keep a downloaded copy."
        : this.activeTab === "user"
          ? "No user templates yet. Add a .typsastra file to reuse it as a starting point."
          : this.universe.length === 0 && (this.universeOffline || this.universeError)
            ? "Typst Universe templates are unavailable offline. Downloaded templates still work."
            : "No templates match your search.";
      elements.list.appendChild(empty);
      return;
    }
    for (const selection of items) {
      elements.list.appendChild(this.createCard(selection));
    }
  }

  private createCard(selection: Selection): HTMLElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "project-template-card";
    card.setAttribute("role", "listitem");

    const isSelected = this.isSelected(selection);
    card.classList.toggle("is-selected", isSelected);
    card.setAttribute("aria-pressed", String(isSelected));

    const thumb = document.createElement("span");
    thumb.className = "project-template-thumb";
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => {
      image.remove();
      thumb.classList.add("is-fallback");
      thumb.textContent = "▤";
    });
    thumb.appendChild(image);

    const body = document.createElement("span");
    body.className = "project-template-body";
    const title = document.createElement("span");
    title.className = "project-template-name";

    if (selection.kind === "blank") {
      title.textContent = "Blank project";
      const description = document.createElement("span");
      description.className = "project-template-description";
      description.textContent = "Start with an empty main.typ.";
      body.append(title, description);
      thumb.classList.add("is-blank");
      thumb.textContent = "＋";
    } else if (selection.kind === "universe") {
      const item = selection.item;
      title.textContent = item.version ? `${item.name}  ·  v${item.version}` : item.name;
      const description = document.createElement("span");
      description.className = "project-template-description";
      description.textContent = item.description || "No description provided.";
      const meta = document.createElement("span");
      meta.className = "project-template-meta";
      meta.textContent = [
        item.authors.length > 0 ? item.authors[0].replace(/<[^>]*>/gu, "").trim() : "",
        ...item.categories.slice(0, 3),
      ].filter(Boolean).join("  ·  ");
      body.append(title, description);
      if (meta.textContent) body.appendChild(meta);
      if (findDownloadedTemplate(this.offline, item.name, item.version)) {
        const badge = document.createElement("span");
        badge.className = "project-template-badge";
        badge.textContent = "Downloaded";
        body.appendChild(badge);
      }
      image.src = item.thumbnailUrl;
    } else {
      const item = selection.item;
      title.textContent = item.version ? `${item.name}  ·  v${item.version}` : item.name;
      const description = document.createElement("span");
      description.className = "project-template-description";
      description.textContent = item.description || "No description provided.";
      const meta = document.createElement("span");
      meta.className = "project-template-meta";
      meta.textContent = [
        item.authors.length > 0 ? item.authors[0].replace(/<[^>]*>/gu, "").trim() : "",
        ...item.categories.slice(0, 3),
      ].filter(Boolean).join("  ·  ");
      body.append(title, description);
      if (meta.textContent) body.appendChild(meta);
      void this.loadLocalThumbnail(image, item);
      card.classList.add("has-remove");
      const remove = document.createElement("span");
      remove.className = "project-template-remove";
      remove.setAttribute("role", "button");
      remove.tabIndex = 0;
      remove.textContent = "Remove";
      remove.addEventListener("click", event => {
        event.stopPropagation();
        void this.removeTemplate(item);
      });
      card.appendChild(remove);
    }

    card.append(thumb, body);
    card.addEventListener("click", () => this.select(selection));
    return card;
  }

  private isSelected(selection: Selection): boolean {
    if (!this.selection) return false;
    if (this.selection.kind !== selection.kind) return false;
    if (selection.kind === "blank") return true;
    if (selection.kind === "universe" && this.selection.kind === "universe") {
      return selection.item.name === this.selection.item.name
        && selection.item.version === this.selection.item.version;
    }
    if (selection.kind === "local" && this.selection.kind === "local") {
      return selection.item.id === this.selection.item.id;
    }
    return false;
  }

  private async loadLocalThumbnail(image: HTMLImageElement, item: LocalTemplate): Promise<void> {
    try {
      const dataUrl = await invoke<string | null>("project_template_thumbnail", {
        source: item.source,
        id: item.id,
      });
      if (dataUrl) image.src = dataUrl;
    } catch {
      // A missing thumbnail is fine; the placeholder stays.
    }
  }

  private select(selection: Selection): void {
    this.selection = selection;
    this.renderList();
    this.syncCreateButton();
  }

  private syncCreateButton(): void {
    const elements = this.elements;
    if (!elements) return;
    elements.create.disabled = this.selection === null || this.busy;
    if (this.step === "browse") {
      elements.create.textContent = "Continue";
    }
  }

  private showBrowse(): void {
    const elements = this.elements;
    if (!elements) return;
    this.step = "browse";
    elements.browser.classList.remove("hidden");
    elements.destination.classList.add("hidden");
    elements.back.classList.add("hidden");
    elements.parent.textContent = "";
    this.syncCreateButton();
  }

  private showDestination(): void {
    const elements = this.elements;
    if (!elements || !this.selection) return;
    this.step = "destination";
    elements.browser.classList.add("hidden");
    elements.destination.classList.remove("hidden");
    elements.back.classList.remove("hidden");
    elements.chosen.textContent = this.selection.kind === "blank"
      ? "Blank project"
      : `${this.selection.item.name}${this.selection.kind === "universe" ? `  ·  v${this.selection.item.version}` : ""}`;
    elements.name.value = this.defaultName();
    elements.parent.textContent = this.parentPath ? `In ${this.parentPath}` : "";
    elements.create.textContent = "Create Project";
    this.validateName();
    requestAnimationFrame(() => {
      elements.name.focus();
      elements.name.select();
    });
  }

  private defaultName(): string {
    if (!this.selection || this.selection.kind === "blank") return "Untitled";
    return this.selection.item.name;
  }

  private async advance(): Promise<void> {
    const elements = this.elements;
    if (!elements || !this.selection || this.busy) return;
    if (this.step === "browse") {
      if (!this.parentPath) {
        const chosen = await this.promptLocation();
        if (!chosen) return;
      }
      this.showDestination();
      return;
    }
    await this.createProject();
  }

  private async chooseLocation(): Promise<void> {
    const chosen = await this.promptLocation();
    if (!chosen) return;
    const elements = this.elements;
    if (elements) elements.parent.textContent = `In ${chosen}`;
    this.validateName();
  }

  private async promptLocation(): Promise<boolean> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose where to create the project",
    });
    if (typeof selected !== "string") return false;
    this.parentPath = selected;
    return true;
  }

  private validateName(): void {
    const elements = this.elements;
    if (!elements) return;
    const name = elements.name.value;
    elements.nameError.textContent = "";
    elements.create.disabled = true;
    if (!this.parentPath) return;
    const localError = projectImportDestinationNameError(name);
    if (localError) {
      elements.nameError.textContent = localError;
      elements.name.setAttribute("aria-invalid", "true");
      return;
    }
    elements.name.removeAttribute("aria-invalid");
    elements.path.textContent = this.previewPath(name);
    elements.create.disabled = this.busy;
    void invoke<string>("validate_project_template_destination", {
      parentPath: this.parentPath,
      projectName: name,
    }).then(path => {
      if (this.step !== "destination" || elements.name.value !== name) return;
      elements.path.textContent = path;
      elements.create.disabled = this.busy;
    }).catch(error => {
      if (this.step !== "destination" || elements.name.value !== name) return;
      elements.name.setAttribute("aria-invalid", "true");
      elements.nameError.textContent = String(error);
      elements.create.disabled = true;
    });
  }

  private previewPath(name: string): string {
    const parent = this.parentPath ?? "";
    const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
    return `${parent.replace(/[\\/]+$/u, "")}${separator}${name}`;
  }

  private async createProject(): Promise<void> {
    const elements = this.elements;
    if (!elements || !this.selection || !this.parentPath) return;
    const name = elements.name.value.trim();
    if (projectImportDestinationNameError(name)) {
      this.validateName();
      return;
    }
    this.setBusy(true, "Preparing the project…");
    try {
      let project: CreatedProject;
      if (this.selection.kind === "blank") {
        project = await invoke<CreatedProject>("create_blank_project", {
          parentPath: this.parentPath,
          projectName: name,
        });
      } else if (this.selection.kind === "universe") {
        const downloaded = findDownloadedTemplate(this.offline, this.selection.item.name, this.selection.item.version);
        let id = downloaded?.id ?? "";
        if (!downloaded) {
          this.setBusy(true, "Downloading the template…");
          const entry = await invoke<LocalTemplate>("download_universe_template", {
            name: this.selection.item.name,
            version: this.selection.item.version,
          });
          id = entry.id;
          this.offline = await invoke<LocalTemplate[]>("list_offline_templates");
        }
        this.setBusy(true, "Creating the project…");
        project = await invoke<CreatedProject>("create_project_from_template", {
          source: "universe",
          id,
          parentPath: this.parentPath,
          projectName: name,
          operationId: crypto.randomUUID(),
        });
      } else {
        project = await invoke<CreatedProject>("create_project_from_template", {
          source: this.selection.item.source,
          id: this.selection.item.id,
          parentPath: this.parentPath,
          projectName: name,
          operationId: crypto.randomUUID(),
        });
      }
      const opened = await this.port.completeCreatedProject(project);
      this.close();
      if (!opened) {
        await message(`The project was created at:\n\n${project.workspacePath}`, {
          title: "Project Created",
          kind: "info",
        });
      }
    } catch (error) {
      this.port.setStatus({ kind: "error", message: `Project creation failed: ${error}` });
      await message(String(error), { title: "Could Not Create Project", kind: "error" });
    } finally {
      this.setBusy(false, "");
    }
  }

  private setBusy(busy: boolean, status: string): void {
    const elements = this.elements;
    if (!elements) return;
    this.busy = busy;
    elements.status.textContent = status;
    elements.create.disabled = busy || this.selection === null;
  }

  private async addUserTemplate(): Promise<void> {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Typsastra Project", extensions: ["typsastra"] }],
    });
    if (typeof selected !== "string") return;
    const elements = this.elements;
    this.setBusy(true, "Adding the template…");
    try {
      await invoke<LocalTemplate>("add_user_template", { archivePath: selected });
      this.user = await invoke<LocalTemplate[]>("list_user_templates");
      this.activeTab = "user";
      this.renderTabs();
      this.renderList();
    } catch (error) {
      if (elements) elements.status.textContent = `Could not add the template: ${String(error)}`;
      await message(String(error), { title: "Could Not Add Template", kind: "error" });
    } finally {
      this.setBusy(false, "");
    }
  }

  private async removeTemplate(item: LocalTemplate): Promise<void> {
    try {
      await invoke("remove_project_template", { source: item.source, id: item.id });
      this.offline = await invoke<LocalTemplate[]>("list_offline_templates");
      this.user = await invoke<LocalTemplate[]>("list_user_templates");
      if (this.isSelected({ kind: "local", item })) this.selection = null;
      this.renderList();
      this.syncCreateButton();
    } catch (error) {
      const elements = this.elements;
      if (elements) elements.status.textContent = `Could not remove the template: ${String(error)}`;
    }
  }
}
