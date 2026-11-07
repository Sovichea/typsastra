import { setLocalizedHtml, t } from "../i18n";
import { filePathKey } from "../platform/paths";
import { wrapEditorCaretInput } from "../ui/editorCaretInput";
import type { BibliographyDiagnostic, BibliographyEntry } from "../references/bibliography";
import {
  bibliographySourcesRelativeTo,
  type BibliographyInsertRequest,
  type BibliographyInsertResult,
  type BibliographyLocation,
} from "../references/bibliographyBlock";
import {
  BIBLIOGRAPHY_STYLES,
  DEFAULT_BIBLIOGRAPHY_STYLE,
  bibliographyStyleLabel,
} from "../references/bibliographyStyles";
import type { CitationInsertResult } from "../references/citationInsertion";
import {
  filterReferenceEntries,
  type ReferenceFilter,
} from "../references/referenceFilters";
import type {
  ProjectBibliographyCall,
  ProjectCitationSite,
  ReferencesProjectIndex,
} from "../references/referencesService";

export interface ReferencesControllerDependencies {
  workspaceRootPath(): string | null;
  mainFilePath(): string | null;
  loadIndex(): Promise<ReferencesProjectIndex>;
  insertCitation(key: string): CitationInsertResult | Promise<CitationInsertResult>;
  insertBibliography(request: BibliographyInsertRequest): Promise<BibliographyInsertResult>;
  openLocation(path: string, fromUtf16: number, toUtf16: number): Promise<void>;
  log?(kind: "info" | "warning", message: string): void;
}

type ExistingBibliography = {
  path: string;
  relativePath: string;
  fromUtf16: number;
  toUtf16: number;
  sources: string[];
  style: string | null;
};

/**
 * The References sidebar owns only its own chrome and details. It deliberately
 * leaves the document preview visible, unlike Image Tools and Table Tools.
 */
export class ReferencesController {
  private index: ReferencesProjectIndex | null = null;
  private loading = false;
  private error: string | null = null;
  private query = "";
  private filter: ReferenceFilter = "all";
  private selectedId: string | null = null;
  private style = DEFAULT_BIBLIOGRAPHY_STYLE;
  private localBibliography: BibliographyLocation | null = null;
  private status = "";
  private generation = 0;
  private mounted = false;
  private visible = false;

  private list!: HTMLElement;
  private details!: HTMLElement;
  private bibliography!: HTMLElement;
  private footer!: HTMLElement;
  private search!: HTMLInputElement;
  private filterField!: HTMLSelectElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly deps: ReferencesControllerDependencies,
  ) {}

  public show(): void {
    if (this.visible) return;
    this.visible = true;
    this.mount();
    this.render();
    void this.refresh();
  }

  public hide(): void {
    this.visible = false;
  }

  public reset(): void {
    this.generation += 1;
    this.visible = false;
    this.index = null;
    this.loading = false;
    this.error = null;
    this.query = "";
    this.filter = "all";
    this.selectedId = null;
    this.localBibliography = null;
    this.status = "";
    if (this.mounted) {
      this.search.value = "";
      this.filterField.value = "all";
      this.render();
    }
  }

  private async refresh(): Promise<void> {
    if (!this.deps.workspaceRootPath()) {
      this.generation += 1;
      this.index = null;
      this.loading = false;
      this.error = null;
      this.render();
      return;
    }

    const generation = ++this.generation;
    this.loading = true;
    this.error = null;
    this.status = "";
    this.render();

    try {
      const index = await this.deps.loadIndex();
      if (generation !== this.generation) return;
      this.index = index;
      this.localBibliography = null;
      if (this.selectedId && !index.bibliography.entries.some(entry => entryId(entry) === this.selectedId)) {
        this.selectedId = null;
      }
      const existingStyle = this.existingBibliography()?.style;
      if (existingStyle && BIBLIOGRAPHY_STYLES.some(style => style.id === existingStyle)) {
        this.style = existingStyle;
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.index = null;
      this.error = String(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private mount(): void {
    if (this.mounted) return;
    document.getElementById("references-refresh")?.addEventListener("click", () => {
      void this.refresh();
    });
    const controls = document.createElement("div");
    controls.className = "sidebar-tool-controls";
    setLocalizedHtml(controls, `
      <input class="sidebar-tool-search" type="search" placeholder="Search references" aria-label="Search project references" autocomplete="off" />
      <select class="sidebar-tool-filter" aria-label="Filter project references">
        <option value="all">All references</option>
        <option value="cited">Cited</option>
        <option value="uncited">Uncited</option>
        <option value="problems">Problems</option>
      </select>`);

    const list = document.createElement("div");
    list.className = "sidebar-tool-list references-list";
    list.tabIndex = 0;
    list.setAttribute("role", "tree");
    list.setAttribute("aria-label", t("Project references"));

    const details = document.createElement("div");
    details.className = "references-details";
    details.setAttribute("role", "region");
    details.setAttribute("aria-label", t("Reference details"));
    const bibliography = document.createElement("div");
    bibliography.className = "references-bibliography";
    bibliography.setAttribute("role", "region");
    bibliography.setAttribute("aria-label", t("Bibliography"));
    const footer = document.createElement("div");
    footer.className = "sidebar-tool-footer";

    const search = controls.querySelector<HTMLInputElement>(".sidebar-tool-search")!;
    if (!search.closest(".sidebar-tool-search-shell")) {
      const marker = document.createComment("sidebar-tool-search");
      search.replaceWith(marker);
      marker.replaceWith(wrapEditorCaretInput(search, { shellClass: "sidebar-tool-search-shell" }));
    }
    const filter = controls.querySelector<HTMLSelectElement>(".sidebar-tool-filter")!;

    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
      if (this.selectedId && !this.entryRows().some(row => row.dataset.referenceId === this.selectedId)) {
        this.selectedId = null;
        this.renderDetails();
      }
      this.renderFooter();
    });
    filter.addEventListener("change", () => {
      this.filter = filter.value as ReferenceFilter;
      this.selectedId = null;
      this.render();
    });

    list.addEventListener("pointerdown", event => {
      if (!(event.target as HTMLElement).closest("input, textarea, select, button")) {
        list.focus({ preventScroll: true });
      }
    });
    list.addEventListener("keydown", event => this.handleListKeydown(event));

    this.host.replaceChildren(controls, list, details, bibliography, footer);
    this.list = list;
    this.details = details;
    this.bibliography = bibliography;
    this.footer = footer;
    this.search = search;
    this.filterField = filter;
    this.mounted = true;
  }

  private render(): void {
    if (!this.mounted) return;
    this.renderList();
    this.renderDetails();
    this.renderBibliography();
    this.renderFooter();
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (!this.deps.workspaceRootPath()) {
      this.showEmpty(t("Open a project to inspect its bibliography."));
      return;
    }
    if (this.loading && !this.index) {
      this.showEmpty(t("Loading references…"));
      return;
    }
    if (this.error) {
      this.showEmpty(t`Could not load references: ${this.error}`);
      return;
    }
    if (!this.index) {
      this.showEmpty(t("References will load when the project is ready."));
      return;
    }

    if (this.filter === "problems") {
      this.renderProblems(this.index.bibliography.diagnostics);
      return;
    }

    const entries = filterReferenceEntries(this.index.bibliography.entries, {
      query: this.query,
      filter: this.filter,
      citedKeys: this.citedKeys(),
    });
    if (entries.length === 0) {
      this.showEmpty(this.index.bibliography.entries.length === 0
        ? this.index.bibliography.files.length === 0
          ? t("No .bib files found in this project.")
          : t("No valid bibliography entries found. Check the Problems filter.")
        : t("No references match this view."));
      return;
    }

    for (const entry of entries) {
      this.list.appendChild(this.entryRow(entry));
    }
    this.syncSelection();
  }

  private renderProblems(diagnostics: readonly BibliographyDiagnostic[]): void {
    if (diagnostics.length === 0) {
      this.showEmpty(t("No bibliography problems found."));
      return;
    }
    for (const diagnostic of diagnostics) {
      const item = document.createElement("div");
      item.className = "tree-item explorer-item-target references-problem";
      item.setAttribute("role", "treeitem");
      item.tabIndex = 0;

      const severity = document.createElement("span");
      severity.className = `references-problem-severity ${diagnostic.severity}`;
      severity.textContent = diagnostic.severity.toUpperCase();
      const text = document.createElement("span");
      text.className = "references-problem-text";
      const message = document.createElement("span");
      message.className = "references-problem-message";
      message.textContent = diagnostic.message;
      const meta = document.createElement("span");
      meta.className = "references-problem-meta";
      meta.textContent = `${diagnostic.relativePath} · ${diagnostic.code}`;
      text.append(message, meta);
      item.append(severity, text);
      item.addEventListener("click", () => {
        void this.deps.openLocation(diagnostic.path, diagnostic.fromUtf16, diagnostic.toUtf16);
      });
      item.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void this.deps.openLocation(diagnostic.path, diagnostic.fromUtf16, diagnostic.toUtf16);
      });
      this.list.appendChild(item);
    }
  }

  private entryRow(entry: BibliographyEntry): HTMLElement {
    const item = document.createElement("div");
    item.className = "tree-item explorer-item-target references-entry";
    item.dataset.referenceId = entryId(entry);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-selected", String(entryId(entry) === this.selectedId));

    const heading = document.createElement("span");
    heading.className = "references-entry-heading";
    const type = document.createElement("span");
    type.className = "references-entry-type";
    type.textContent = entry.entryType.toUpperCase();
    const title = document.createElement("span");
    title.className = "references-entry-title";
    title.textContent = entry.title || entry.key;
    heading.append(type, title);

    const authorLine = [
      entry.authors.join(", "),
      entry.year ?? "",
    ].filter(Boolean).join(" · ");
    const authors = document.createElement("span");
    authors.className = "references-entry-authors";
    authors.textContent = authorLine;

    const meta = document.createElement("span");
    meta.className = "references-entry-meta";
    const key = document.createElement("span");
    key.className = "references-entry-key";
    key.textContent = entry.key;
    const source = document.createElement("span");
    source.className = "references-entry-source";
    source.textContent = entry.relativePath;
    meta.append(key, source);
    if (this.citedKeys().has(entry.key)) {
      const count = this.citationSitesFor(entry.key).length;
      const status = document.createElement("span");
      status.className = "references-entry-cited";
      status.textContent = t`Cited ${count}×`;
      meta.appendChild(status);
    }

    item.append(heading, ...(authorLine ? [authors] : []), meta);
    item.addEventListener("click", () => this.selectEntry(entryId(entry)));
    item.addEventListener("dblclick", () => {
      this.selectEntry(entryId(entry));
      void this.insertCitation(entry);
    });
    return item;
  }

  private renderDetails(): void {
    this.details.replaceChildren();
    if (this.loading && !this.index) {
      this.details.appendChild(this.emptyElement(t("Loading reference details…")));
      return;
    }
    const entry = this.selectedEntry();
    if (!entry) {
      this.details.appendChild(this.emptyElement(t("Select a reference to inspect it.")));
      return;
    }

    const header = document.createElement("div");
    header.className = "references-detail-header";
    const heading = document.createElement("div");
    heading.className = "references-detail-heading";
    const type = document.createElement("span");
    type.className = "references-entry-type";
    type.textContent = entry.entryType.toUpperCase();
    const title = document.createElement("h2");
    title.textContent = entry.title || entry.key;
    heading.append(type, title);
    header.appendChild(heading);

    const meta = document.createElement("div");
    meta.className = "references-detail-meta";
    this.addMeta(meta, t("Key"), entry.key);
    this.addMeta(meta, t("Authors"), entry.authors.join(", ") || t("None"));
    this.addMeta(meta, t("Year"), entry.year ?? t("Unknown"));
    this.addMeta(meta, t("Source"), entry.relativePath);

    const actions = document.createElement("div");
    actions.className = "references-actions";
    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "primary";
    insert.textContent = t("Insert Citation");
    insert.addEventListener("click", () => void this.insertCitation(entry));
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = t("Open .bib");
    open.addEventListener("click", () => {
      void this.deps.openLocation(entry.path, entry.fromUtf16, entry.toUtf16);
    });
    actions.append(insert, open);

    const fields = document.createElement("dl");
    fields.className = "references-fields";
    for (const [name, value] of Object.entries(entry.fields)) {
      if (["title", "author", "editor", "year", "date"].includes(name)) continue;
      const term = document.createElement("dt");
      term.textContent = name;
      const description = document.createElement("dd");
      description.textContent = value;
      fields.append(term, description);
    }

    const sites = this.citationSitesFor(entry.key);
    const citations = document.createElement("section");
    citations.className = "references-citations";
    const citationHeading = document.createElement("h3");
    citationHeading.textContent = t("Citation sites");
    citations.appendChild(citationHeading);
    if (sites.length === 0) {
      citations.appendChild(this.emptyElement(t("Not cited yet.")));
    } else {
      for (const site of sites) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "references-citation-site";
        button.textContent = t`${site.relativePath} · Ln ${site.line}, Col ${site.column}`;
        button.addEventListener("click", () => {
          void this.deps.openLocation(site.path, site.from, site.to);
        });
        citations.appendChild(button);
      }
    }

    this.details.append(header, meta, actions, fields, citations);
  }

  private renderBibliography(): void {
    this.bibliography.replaceChildren();
    if (!this.deps.workspaceRootPath()) {
      this.bibliography.appendChild(this.emptyElement(t("Open a project to inspect its bibliography.")));
      return;
    }
    if (this.error) {
      this.bibliography.appendChild(this.emptyElement(t`Could not load references: ${this.error}`));
      return;
    }
    if (!this.index) {
      this.bibliography.appendChild(this.emptyElement(t("Loading bibliography…")));
      return;
    }

    const existing = this.existingBibliography();
    const files = this.index?.bibliography.files ?? [];
    const mainPath = this.deps.mainFilePath();
    const workspaceRoot = this.deps.workspaceRootPath();

    const heading = document.createElement("h3");
    heading.textContent = t("Bibliography");
    this.bibliography.appendChild(heading);

    if (existing) {
      const found = document.createElement("div");
      found.className = "references-bibliography-note";
      found.textContent = t`Found in ${existing.relativePath}${existing.style ? ` · ${bibliographyStyleLabel(existing.style)}` : ""}`;
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.textContent = t("Reveal Bibliography");
      reveal.addEventListener("click", () => {
        this.status = t`Revealed the bibliography in ${existing.relativePath}.`;
        this.renderBibliography();
        void this.deps.openLocation(existing.path, existing.fromUtf16, existing.toUtf16);
      });
      this.bibliography.append(found, reveal);
    } else if (files.length === 0) {
      this.bibliography.appendChild(this.emptyElement(t("No .bib files found in this project.")));
    } else if (!mainPath) {
      this.bibliography.appendChild(this.emptyElement(t("Set a main document before inserting a bibliography.")));
    } else {
      const styleRow = document.createElement("label");
      styleRow.className = "references-style";
      const label = document.createElement("span");
      label.textContent = t("Style");
      const select = document.createElement("select");
      select.className = "sidebar-tool-filter";
      select.setAttribute("aria-label", t("Bibliography style"));
      for (const style of BIBLIOGRAPHY_STYLES) {
        const option = document.createElement("option");
        option.value = style.id;
        option.textContent = style.label;
        select.appendChild(option);
      }
      select.value = this.style;
      select.addEventListener("change", () => {
        this.style = select.value;
      });
      styleRow.append(label, select);
      const insert = document.createElement("button");
      insert.type = "button";
      insert.className = "primary";
      insert.textContent = t("Insert Bibliography");
      insert.addEventListener("click", () => void this.insertBibliography(workspaceRoot, mainPath, files));
      this.bibliography.append(styleRow, insert);
    }

    if (this.status) {
      const status = document.createElement("div");
      status.className = "references-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.textContent = this.status;
      this.bibliography.appendChild(status);
    }
  }

  private async insertBibliography(
    workspaceRoot: string | null,
    mainPath: string,
    files: readonly { path: string }[],
  ): Promise<void> {
    if (!workspaceRoot) return;
    const sources = bibliographySourcesRelativeTo(
      workspaceRoot,
      mainPath,
      files.map(file => file.path),
    );
    if (sources.length === 0) {
      this.status = t("Could not resolve a bibliography path relative to the main document.");
      this.renderBibliography();
      return;
    }
    try {
      const result = await this.deps.insertBibliography({ mainPath, sources, style: this.style });
      if (result.ok) {
        this.localBibliography = result.call;
        this.style = result.call.style;
        this.status = result.revealed
          ? t`Revealed the bibliography in ${result.call.relativePath}.`
          : t`Inserted the bibliography in ${result.call.relativePath}.`;
      } else {
        this.status = result.message;
      }
    } catch (error) {
      this.status = t`Could not insert the bibliography: ${String(error)}`;
    }
    this.renderBibliography();
  }

  private async insertCitation(entry: BibliographyEntry): Promise<void> {
    try {
      const result = await this.deps.insertCitation(entry.key);
      this.status = result.ok ? t`Inserted @${entry.key}.` : result.message;
    } catch (error) {
      this.status = t`Could not insert the citation: ${String(error)}`;
    }
    this.renderBibliography();
  }

  private renderFooter(): void {
    if (this.loading && !this.index) {
      this.footer.textContent = t("Loading references…");
      return;
    }
    if (this.error) {
      this.footer.textContent = t("References unavailable.");
      return;
    }
    if (!this.index) {
      this.footer.textContent = "";
      return;
    }
    const total = this.index.bibliography.entries.length;
    const cited = this.citedKeys().size;
    const problems = this.index.bibliography.diagnostics.length;
    this.footer.textContent = t`${total} entries · ${cited} cited · ${problems} problems`;
  }

  private handleListKeydown(event: KeyboardEvent): void {
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(event.key)) return;
    const rows = this.entryRows();
    if (rows.length === 0) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Enter") {
      const entry = this.selectedEntry();
      if (entry) void this.insertCitation(entry);
      return;
    }

    const found = rows.findIndex(row => row.dataset.referenceId === this.selectedId);
    let index = found >= 0
      ? found
      : event.key === "ArrowUp" || event.key === "End" ? rows.length : -1;
    if (event.key === "ArrowUp") index = Math.max(0, index - 1);
    else if (event.key === "ArrowDown") index = Math.min(rows.length - 1, index + 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = rows.length - 1;

    const next = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (next?.dataset.referenceId) this.selectEntry(next.dataset.referenceId);
  }

  private selectEntry(id: string): void {
    this.selectedId = id;
    this.syncSelection();
    this.renderDetails();
    this.renderBibliography();
  }

  private syncSelection(): void {
    for (const row of this.entryRows()) {
      const selected = row.dataset.referenceId === this.selectedId;
      row.classList.toggle("selected", selected);
      row.setAttribute("aria-selected", String(selected));
      if (selected) row.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  private selectedEntry(): BibliographyEntry | null {
    if (!this.selectedId || !this.index) return null;
    return this.index.bibliography.entries.find(entry => entryId(entry) === this.selectedId) ?? null;
  }

  private entryRows(): HTMLElement[] {
    return [...this.list.querySelectorAll<HTMLElement>(".references-entry[data-reference-id]")];
  }

  private citedKeys(): Set<string> {
    const keys = new Set(this.index?.bibliography.entries.map(entry => entry.key) ?? []);
    return new Set(
      (this.index?.citations ?? [])
        .filter(site => keys.has(site.key))
        .map(site => site.key),
    );
  }

  private citationSitesFor(key: string): ProjectCitationSite[] {
    return (this.index?.citations ?? []).filter(site => site.key === key);
  }

  private existingBibliography(): ExistingBibliography | null {
    if (this.localBibliography) {
      return {
        path: this.localBibliography.path,
        relativePath: this.localBibliography.relativePath,
        fromUtf16: this.localBibliography.fromUtf16,
        toUtf16: this.localBibliography.toUtf16,
        sources: this.localBibliography.sources,
        style: this.localBibliography.style,
      };
    }
    const mainPath = this.deps.mainFilePath();
    const call: ProjectBibliographyCall | undefined = (
      mainPath
        ? this.index?.bibliographyCalls.find(candidate =>
          filePathKey(candidate.path) === filePathKey(mainPath))
        : undefined
    ) ?? this.index?.bibliographyCalls[0];
    if (!call) return null;
    return {
      path: call.path,
      relativePath: call.relativePath,
      fromUtf16: call.from,
      toUtf16: call.to,
      sources: call.sources,
      style: call.style,
    };
  }

  private showEmpty(message: string): void {
    this.list.appendChild(this.emptyElement(message));
  }

  private emptyElement(message: string): HTMLElement {
    const empty = document.createElement("div");
    empty.className = "image-tool-empty";
    empty.textContent = message;
    return empty;
  }

  private addMeta(parent: HTMLElement, label: string, value: string): void {
    const term = document.createElement("span");
    term.textContent = label;
    const description = document.createElement("strong");
    description.textContent = value;
    parent.append(term, description);
  }
}

function entryId(entry: BibliographyEntry): string {
  return JSON.stringify([entry.relativePath, entry.fromUtf16, entry.key]);
}
