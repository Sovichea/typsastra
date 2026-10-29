import { filePathKey } from "../platform/paths";
import { wrapEditorCaretInput } from "../ui/editorCaretInput";
import {
  ProjectTextRequestCancelled,
  textRevisionToken,
  type ProjectTextService,
  type ProjectTextSkippedFile,
} from "../workspace/projectTextService";
import {
  PROJECT_SEARCH_DEBOUNCE_MS,
  PROJECT_SEARCH_MAX_RESULTS,
  PROJECT_SEARCH_REGEX_TIMEOUT_MS,
  parseProjectSearchGlobs,
  projectSearchFileMatchesFilters,
  type ProjectSearchFileInput,
  type ProjectSearchFileResult,
  type ProjectSearchLineMatch,
  type ProjectSearchMode,
  type ProjectSearchOptions,
  type ProjectSearchWorkerRequest,
  type ProjectSearchWorkerResponse,
} from "./projectSearch";
import {
  isGraphemeSafeReplacementRange,
  previewSearchReplacement,
  projectReplacementMatchKey,
  type ProjectReplacementFileRequest,
  type ProjectReplacementRequest,
  type ProjectReplacementResult,
} from "./projectReplacement";

export type ProjectSearchNavigationTarget = {
  path: string;
  revision: string;
  textRevision: string;
  from: number;
  to: number;
  kind: "content" | "path";
};

export interface ProjectSearchControllerDependencies {
  workspaceRootPath(): string | null;
  pinnedMainFilePath(): string | null;
  projectText(): ProjectTextService;
  openResult(target: ProjectSearchNavigationTarget): Promise<void> | void;
  applyReplacement(request: ProjectReplacementRequest): Promise<ProjectReplacementResult>;
  undoReplacement(): Promise<ProjectReplacementResult>;
  replacementUndoAvailable(): boolean;
  resetReplacementBatch(): void;
}

type SearchState = {
  options: ProjectSearchOptions;
  searching: boolean;
  truncated: boolean;
  incomplete: boolean;
  error: string | null;
  notice: string | null;
};

const DEFAULT_OPTIONS: ProjectSearchOptions = {
  query: "",
  mode: "literal",
  caseSensitive: false,
  wholeWord: false,
  matchDiacritics: true,
  includeIgnored: false,
  mainDocumentOnly: true,
  includeGlobs: [],
  excludeGlobs: [],
};

export class ProjectSearchController {
  private initialized = false;
  private worker: Worker | null = null;
  private debounceTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private renderFrame: number | null = null;
  private generation = 0;
  private requestCounter = 0;
  private activeRequestId = 0;
  private readAbort: AbortController | null = null;
  private readonly fileResults = new Map<string, ProjectSearchFileResult>();
  private readonly selectedMatches = new Set<string>();
  private reviewingReplacement = false;
  private applyingReplacement = false;
  private suppressSelectionDefaults = false;
  private skippedFiles: readonly ProjectTextSkippedFile[] = [];
  private state: SearchState = {
    options: { ...DEFAULT_OPTIONS },
    searching: false,
    truncated: false,
    incomplete: false,
    error: null,
    notice: null,
  };

  constructor(private readonly deps: ProjectSearchControllerDependencies) {}

  public show(): void {
    this.initialize();
    requestAnimationFrame(() => {
      const input = this.queryInput();
      input?.focus();
      input?.select();
    });
  }

  public reset(): void {
    this.cancelWork();
    this.generation += 1;
    this.fileResults.clear();
    this.selectedMatches.clear();
    this.reviewingReplacement = false;
    this.applyingReplacement = false;
    this.suppressSelectionDefaults = false;
    this.skippedFiles = [];
    this.deps.resetReplacementBatch();
    this.state = {
      options: { ...DEFAULT_OPTIONS },
      searching: false,
      truncated: false,
      incomplete: false,
      error: null,
      notice: null,
    };
    const input = this.queryInput();
    if (input) input.value = "";
    const replacement = this.replacementInput();
    if (replacement) replacement.value = "";
    this.resetOptionControls();
    this.scheduleRender();
  }

  public focusQuery(focusReplace = false): void {
    this.initialize();
    (focusReplace ? this.replacementInput() : this.queryInput())?.focus();
  }

  public refreshReplacementControls(): void {
    if (!this.initialized) return;
    this.updateReplacementControls();
  }

  /** Match Image Tools: the same shell, typography, and caret for search fields. */
  private wrapSearchField(input: HTMLInputElement | null): void {
    if (!input || input.closest(".typsastra-caret-input-shell")) return;
    const marker = document.createComment("project-search-input");
    input.replaceWith(marker);
    marker.replaceWith(wrapEditorCaretInput(input, {
      shellClass: "sidebar-tool-search-shell",
    }));
  }

  private initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    const input = this.queryInput();
    if (!input) return;
    this.wrapSearchField(input);
    this.wrapSearchField(this.replacementInput());
    input.addEventListener("input", () => this.scheduleSearch());
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.scheduleSearch(0);
      }
    });
    this.modeSelect()?.addEventListener("change", () => {
      this.updateModeControls();
      this.scheduleSearch(0);
    });
    for (const element of [
      this.caseCheckbox(),
      this.wholeWordCheckbox(),
      this.diacriticsCheckbox(),
      this.includeIgnoredCheckbox(),
      this.mainDocumentOnlyCheckbox(),
    ]) {
      element?.addEventListener("change", () => this.scheduleSearch(0));
    }
    for (const element of [this.includeGlobsInput(), this.excludeGlobsInput()]) {
      element?.addEventListener("input", () => this.scheduleSearch());
    }
    this.replacementInput()?.addEventListener("input", () => {
      if (this.reviewingReplacement) this.scheduleRender();
    });
    document.getElementById("project-search-replace-all")
      ?.addEventListener("click", () => this.requestReplacement(true));
    document.getElementById("project-search-review-replace")
      ?.addEventListener("click", () => this.startReplacementReview());
    document.getElementById("project-search-undo-replace")
      ?.addEventListener("click", () => {
        if (this.applyingReplacement) return;
        void this.undoReplacementBatch();
      });
    document.getElementById("project-search-clear")?.addEventListener("click", () => {
      const field = this.queryInput();
      if (field) field.value = "";
      this.cancelWork();
      this.generation += 1;
      this.fileResults.clear();
      this.selectedMatches.clear();
      this.reviewingReplacement = false;
      this.suppressSelectionDefaults = false;
      this.skippedFiles = [];
      this.state.options = { ...this.state.options, query: "" };
      this.state.searching = false;
      this.state.error = null;
      this.state.truncated = false;
      this.state.incomplete = false;
      this.state.notice = null;
      this.scheduleRender();
      field?.focus();
    });
    this.resultsElement()?.addEventListener("click", event => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-search-path]");
      if (!button) return;
      void this.openResultButton(button);
    });
    this.updateModeControls();
    this.render();
  }

  private scheduleSearch(delay = PROJECT_SEARCH_DEBOUNCE_MS): void {
    this.initialize();
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.cancelWork();
    this.generation += 1;
    const options = this.readOptions();
    this.state = {
      options,
      searching: options.query.trim().length > 0,
      truncated: false,
      incomplete: false,
      error: null,
      notice: null,
    };
    this.fileResults.clear();
    this.selectedMatches.clear();
    this.reviewingReplacement = false;
    this.suppressSelectionDefaults = false;
    this.skippedFiles = [];
    this.scheduleRender();
    if (!options.query.trim()) return;
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.runSearch();
    }, Math.max(0, delay));
  }

  private async runSearch(): Promise<void> {
    const options = this.readOptions();
    if (!options.query.trim()) return;
    this.cancelWork();
    const generation = ++this.generation;
    this.fileResults.clear();
    this.skippedFiles = [];
    this.state = {
      options,
      searching: true,
      truncated: false,
      incomplete: false,
      error: null,
      notice: null,
    };
    if (options.mode === "regex") {
      try {
        new RegExp(options.query, options.caseSensitive ? "" : "i");
      } catch (error) {
        this.state.searching = false;
        this.state.error = `Invalid regular expression: ${String(error)}`;
        this.scheduleRender();
        return;
      }
    }
    this.scheduleRender();
    const rootPath = this.deps.workspaceRootPath();
    if (!rootPath) {
      this.finishSearch(false);
      return;
    }
    const abort = new AbortController();
    this.readAbort = abort;
    try {
      const inventory = await this.deps.projectText().inventory({ includeIgnored: options.includeIgnored });
      if (generation !== this.generation || this.deps.workspaceRootPath() !== rootPath) return;
      let relatedPaths: Set<string> | null = null;
      if (options.mainDocumentOnly) {
        const mainPath = this.deps.pinnedMainFilePath();
        if (!mainPath) {
          this.state.notice = "No main document is pinned; searching the whole project.";
        } else {
          try {
            const related = await this.deps.projectText().relatedFiles(mainPath);
            if (generation !== this.generation || this.deps.workspaceRootPath() !== rootPath) return;
            relatedPaths = new Set(related.map(filePathKey));
            if (relatedPaths.size === 0) {
              this.state.notice = "The pinned main document has no reachable source files.";
              this.finishSearch(false);
              return;
            }
          } catch (error) {
            if (generation !== this.generation) return;
            this.state.notice = `Could not resolve the pinned main document; searching the whole project. ${String(error)}`;
          }
        }
      }
      const allowed = (path: string) => !relatedPaths || relatedPaths.has(filePathKey(path));
      const files = inventory.files.filter(file =>
        allowed(file.path)
        && projectSearchFileMatchesFilters(file.relativePath, options.includeGlobs, options.excludeGlobs)
      );
      this.skippedFiles = inventory.skipped.filter(file =>
        allowed(file.path)
        && projectSearchFileMatchesFilters(file.relativePath, options.includeGlobs, options.excludeGlobs)
      );
      if (files.length === 0) {
        this.finishSearch(false);
        return;
      }
      const batch = await this.deps.projectText().readFiles(files, { signal: abort.signal });
      if (generation !== this.generation || this.deps.workspaceRootPath() !== rootPath) return;
      this.skippedFiles = [...this.skippedFiles, ...batch.skipped];
      const inputs: ProjectSearchFileInput[] = batch.snapshots.map(snapshot => ({
        path: snapshot.file.path,
        relativePath: snapshot.file.relativePath,
        revision: snapshot.revision,
        textRevision: textRevisionToken(snapshot.text),
        text: snapshot.text,
      }));
      if (inputs.length === 0) {
        this.finishSearch(false);
        return;
      }
      this.startWorker(options, inputs, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof ProjectTextRequestCancelled) {
        this.finishSearch(false);
        return;
      }
      this.state.searching = false;
      this.state.error = String(error);
      this.scheduleRender();
    } finally {
      if (this.readAbort === abort) this.readAbort = null;
    }
  }

  private startWorker(
    options: ProjectSearchOptions,
    files: readonly ProjectSearchFileInput[],
    generation: number,
  ): void {
    const requestId = ++this.requestCounter;
    this.activeRequestId = requestId;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./projectSearchWorker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      this.state.searching = false;
      this.state.error = `Project search worker failed to start: ${String(error)}`;
      this.scheduleRender();
      return;
    }
    this.worker = worker;
    worker.onmessage = event => {
      if (generation !== this.generation || requestId !== this.activeRequestId) return;
      this.handleWorkerMessage(event.data as ProjectSearchWorkerResponse);
    };
    worker.onerror = event => {
      if (generation !== this.generation || requestId !== this.activeRequestId) return;
      this.state.error = event.message || "Project search worker failed.";
      this.finishSearch(false);
    };
    const request: ProjectSearchWorkerRequest = {
      type: "search",
      requestId,
      options,
      files,
      limit: PROJECT_SEARCH_MAX_RESULTS,
    };
    worker.postMessage(request);
  }

  private handleWorkerMessage(message: ProjectSearchWorkerResponse): void {
    if (message.requestId !== this.activeRequestId) return;
    if (message.type === "file-start") {
      if (this.state.options.mode === "regex") this.startRegexWatchdog(message.requestId);
      return;
    }
    if (message.type === "file-result") {
      this.fileResults.set(filePathKey(message.result.path), message.result);
      if (message.result.error) this.state.error = message.result.error;
      if (!this.suppressSelectionDefaults && this.state.options.mode !== "fuzzy") {
        for (const match of this.fileMatchRanges(message.result)) {
          if (match.safe) {
            this.selectedMatches.add(projectReplacementMatchKey(
              message.result.path,
              match.from,
              match.to,
            ));
          }
        }
      }
      this.scheduleRender();
      return;
    }
    if (message.type === "error") {
      this.state.error = message.message;
      this.finishSearch(this.state.truncated);
      return;
    }
    this.finishSearch(message.truncated);
  }

  private startRegexWatchdog(requestId: number): void {
    this.clearWatchdog();
    this.watchdogTimer = window.setTimeout(() => {
      this.watchdogTimer = null;
      if (requestId !== this.activeRequestId || !this.worker) return;
      this.state.incomplete = true;
      this.state.error = "A regular expression exceeded the 1 second per-file limit. Results are incomplete.";
      const worker = this.worker;
      this.worker = null;
      this.activeRequestId = 0;
      worker.terminate();
      this.state.searching = false;
      this.scheduleRender();
    }, PROJECT_SEARCH_REGEX_TIMEOUT_MS + 100);
  }

  private finishSearch(truncated: boolean): void {
    this.state.searching = false;
    this.state.truncated = this.state.truncated || truncated;
    this.clearWatchdog();
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.activeRequestId = 0;
    this.pruneSelectedMatches();
    this.scheduleRender();
  }

  /** Drop selections that no longer correspond to a current safe match. */
  private pruneSelectedMatches(): void {
    if (this.selectedMatches.size === 0) return;
    const valid = new Set<string>();
    for (const file of this.fileResults.values()) {
      for (const range of this.fileMatchRanges(file)) {
        if (!range.safe) continue;
        valid.add(projectReplacementMatchKey(file.path, range.from, range.to));
      }
    }
    for (const key of this.selectedMatches) {
      if (!valid.has(key)) this.selectedMatches.delete(key);
    }
  }

  private cancelWork(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.clearWatchdog();
    this.readAbort?.abort();
    this.readAbort = null;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.activeRequestId = 0;
    this.deps.projectText().cancel();
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleRender(): void {
    if (this.renderFrame !== null) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      this.render();
    });
  }

  private render(): void {
    this.renderStatus();
    this.updateReplacementControls();
    const results = this.resultsElement();
    if (!results) return;
    if (this.reviewingReplacement) {
      this.renderReplacementReview(results);
      return;
    }
    const files = [...this.fileResults.values()].sort((left, right) => {
      if (this.state.options.mode === "fuzzy") {
        const leftScore = left.pathMatch?.score ?? left.contentMatches[0]?.score ?? 0;
        const rightScore = right.pathMatch?.score ?? right.contentMatches[0]?.score ?? 0;
        if (leftScore !== rightScore) return rightScore - leftScore;
      }
      return left.relativePath.localeCompare(right.relativePath);
    });
    const pathMatches = files.filter(file => file.pathMatch);
    const contentFiles = files.filter(file => file.contentMatchCount > 0);
    const nodes: HTMLElement[] = [];
    if (this.state.notice) nodes.push(this.notice(this.state.notice, "info"));
    if (this.state.error) nodes.push(this.notice(this.state.error, "error"));
    if (this.state.truncated) {
      nodes.push(this.notice(
        `Showing the first ${PROJECT_SEARCH_MAX_RESULTS.toLocaleString()} matches. Narrow the query to continue.`,
        "warning",
      ));
    }
    if (this.state.incomplete) {
      nodes.push(this.notice("Search results are incomplete.", "warning"));
    }
    if (this.skippedFiles.length > 0) {
      const counts = new Map<string, number>();
      for (const file of this.skippedFiles) counts.set(file.reason, (counts.get(file.reason) ?? 0) + 1);
      const detail = [...counts.entries()]
        .map(([reason, count]) => `${count} ${reason}`)
        .join(", ");
      nodes.push(this.notice(`${this.skippedFiles.length} file${this.skippedFiles.length === 1 ? "" : "s"} skipped (${detail}).`, "info"));
    }
    if (pathMatches.length > 0) {
      const section = document.createElement("section");
      section.className = "project-search-path-section";
      const heading = document.createElement("div");
      heading.className = "project-search-section-title";
      heading.textContent = `Path matches (${pathMatches.length})`;
      section.append(heading, ...pathMatches.map(file => this.renderPathMatch(file)));
      nodes.push(section);
    }
    for (const file of contentFiles) nodes.push(this.renderFile(file));
    if (!nodes.length && !this.state.searching) {
      const empty = document.createElement("div");
      empty.className = "project-search-empty";
      empty.textContent = this.state.options.query.trim() ? "No results." : "Type to search the project.";
      nodes.push(empty);
    }
    results.replaceChildren(...nodes);
  }

  private renderStatus(): void {
    const status = document.getElementById("project-search-status");
    if (!status) return;
    const total = [...this.fileResults.values()].reduce((sum, file) => sum + file.contentMatchCount, 0);
    const pathTotal = [...this.fileResults.values()].filter(file => file.pathMatch).length;
    if (!this.state.options.query.trim()) {
      status.textContent = "Type to search the project.";
      return;
    }
    if (this.state.searching) {
      status.textContent = total > 0
        ? `${total.toLocaleString()} match${total === 1 ? "" : "es"} · searching…`
        : "Searching…";
      return;
    }
    if (this.state.error && total === 0 && pathTotal === 0) {
      status.textContent = "Search failed.";
      return;
    }
    const files = [...this.fileResults.values()].filter(file => file.contentMatchCount > 0).length;
    const parts = [`${total.toLocaleString()} match${total === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}`];
    if (pathTotal > 0) parts.push(`${pathTotal} path match${pathTotal === 1 ? "" : "es"}`);
    if (this.state.truncated) parts.push("truncated");
    if (this.state.incomplete) parts.push("incomplete");
    status.textContent = parts.join(" · ");
  }

  private renderFile(file: ProjectSearchFileResult): HTMLElement {
    const section = document.createElement("section");
    section.className = "project-search-file";
    const header = document.createElement("div");
    header.className = "project-search-file-header";
    if (this.state.options.mode !== "fuzzy") {
      const ranges = this.fileMatchRanges(file).filter(range => range.safe);
      const checked = ranges.filter(range =>
        this.selectedMatches.has(projectReplacementMatchKey(file.path, range.from, range.to)));
      const select = document.createElement("input");
      select.type = "checkbox";
      select.className = "project-search-select";
      select.checked = ranges.length > 0 && checked.length === ranges.length;
      select.indeterminate = checked.length > 0 && checked.length < ranges.length;
      select.disabled = ranges.length === 0;
      select.title = "Select all replaceable matches in this file";
      select.setAttribute("aria-label", `Select matches in ${file.relativePath}`);
      select.addEventListener("change", () => {
        for (const range of ranges) {
          const key = projectReplacementMatchKey(file.path, range.from, range.to);
          if (select.checked) this.selectedMatches.add(key);
          else this.selectedMatches.delete(key);
        }
        this.scheduleRender();
      });
      header.appendChild(select);
    }
    const path = document.createElement("span");
    path.className = "project-search-file-path";
    path.textContent = file.relativePath;
    path.title = file.path;
    const count = document.createElement("span");
    count.className = "project-search-file-count";
    count.textContent = String(file.contentMatchCount);
    header.append(path, count);
    section.append(header);
    for (const match of file.contentMatches) {
      if (this.state.options.mode === "fuzzy") {
        section.append(this.renderContentMatch(file, match, match.from, match.to, match.ranges));
        continue;
      }
      for (const range of match.ranges) {
        section.append(this.renderContentMatch(
          file,
          match,
          match.lineFrom + range.from,
          match.lineFrom + range.to,
          [range],
        ));
      }
    }
    return section;
  }

  private renderContentMatch(
    file: ProjectSearchFileResult,
    match: ProjectSearchLineMatch,
    from: number,
    to: number,
    ranges: readonly { from: number; to: number }[],
  ): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "project-search-match-row";
    const safe = isGraphemeSafeReplacementRange(
      match.lineText,
      from - match.lineFrom,
      to - match.lineFrom,
    );
    if (this.state.options.mode !== "fuzzy") {
      const select = document.createElement("input");
      select.type = "checkbox";
      select.className = "project-search-select project-search-select-match";
      const key = projectReplacementMatchKey(file.path, from, to);
      select.checked = this.selectedMatches.has(key);
      select.disabled = !safe;
      select.title = safe
        ? "Include this match in the replacement"
        : "This match splits a grapheme cluster and cannot be replaced safely";
      select.setAttribute("aria-label", `Select ${file.relativePath}:${match.lineNumber}`);
      select.addEventListener("change", () => {
        if (select.checked) this.selectedMatches.add(key);
        else this.selectedMatches.delete(key);
        this.scheduleRender();
      });
      if (!safe) wrapper.classList.add("unsafe");
      wrapper.appendChild(select);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-search-match";
    button.dataset.searchPath = file.path;
    button.dataset.searchRevision = file.revision;
    button.dataset.searchTextRevision = file.textRevision;
    button.dataset.searchFrom = String(from);
    button.dataset.searchTo = String(to);
    button.dataset.searchKind = "content";
    button.title = !safe
      ? "This match splits a grapheme cluster and cannot be replaced safely"
      : `${file.relativePath}:${match.lineNumber}`;
    const lineNumber = document.createElement("span");
    lineNumber.className = "project-search-line-number";
    lineNumber.textContent = String(match.lineNumber);
    const excerpt = document.createElement("span");
    excerpt.className = "project-search-excerpt";
    this.appendHighlightedExcerpt(excerpt, match.lineText, ranges, {
      from: from - match.lineFrom,
      to: to - match.lineFrom,
    });
    button.append(lineNumber, excerpt);
    wrapper.appendChild(button);
    return wrapper;
  }

  private renderPathMatch(file: ProjectSearchFileResult): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-search-path-match";
    button.dataset.searchPath = file.path;
    button.dataset.searchRevision = file.revision;
    button.dataset.searchTextRevision = file.textRevision;
    button.dataset.searchFrom = "0";
    button.dataset.searchTo = "0";
    button.dataset.searchKind = "path";
    button.title = file.path;
    const path = document.createElement("span");
    path.className = "project-search-path-text";
    appendHighlighted(path, file.relativePath, file.pathMatch?.ranges ?? [], 0, file.relativePath.length);
    button.append(path);
    return button;
  }

  private appendHighlightedExcerpt(
    container: HTMLElement,
    text: string,
    ranges: readonly { from: number; to: number }[],
    anchor: { from: number; to: number },
  ): void {
    if (ranges.length === 0) {
      container.textContent = text;
      return;
    }
    let from = Math.max(0, anchor.from - 24);
    let to = Math.min(text.length, anchor.to + 36);
    // Keep the excerpt from clipping a word at either edge.
    if (from > 0) {
      const boundary = text.indexOf(" ", from);
      if (boundary >= 0 && boundary < anchor.from) from = boundary + 1;
    }
    if (to < text.length) {
      const boundary = text.lastIndexOf(" ", to);
      if (boundary > anchor.to) to = boundary;
    }
    if (from > 0) container.append("…");
    appendHighlighted(container, text, ranges, from, to);
    if (to < text.length) container.append("…");
  }

  private notice(text: string, kind: "info" | "warning" | "error"): HTMLElement {
    const element = document.createElement("div");
    element.className = `project-search-notice ${kind}`;
    element.textContent = text;
    return element;
  }

  private async openResultButton(button: HTMLButtonElement): Promise<void> {
    const path = button.dataset.searchPath;
    const revision = button.dataset.searchRevision;
    const textRevision = button.dataset.searchTextRevision;
    if (!path || !revision || !textRevision) return;
    const target: ProjectSearchNavigationTarget = {
      path,
      revision,
      textRevision,
      from: Number(button.dataset.searchFrom ?? 0),
      to: Number(button.dataset.searchTo ?? 0),
      kind: button.dataset.searchKind === "path" ? "path" : "content",
    };
    try {
      const current = await this.deps.projectText().snapshot(path);
      if (current.kind !== "snapshot"
        || textRevisionToken(current.snapshot.text) !== target.textRevision) {
        this.state.error = "The file changed since these results were produced. Refreshing results.";
        this.scheduleRender();
        void this.runSearch();
        return;
      }
      await this.deps.openResult(target);
    } catch (error) {
      this.state.error = String(error);
      this.scheduleRender();
    }
  }

  private fileMatchRanges(file: ProjectSearchFileResult): Array<{
    from: number;
    to: number;
    safe: boolean;
    match: ProjectSearchLineMatch;
  }> {
    const ranges: Array<{ from: number; to: number; safe: boolean; match: ProjectSearchLineMatch }> = [];
    for (const match of file.contentMatches) {
      for (const range of match.ranges) {
        const from = match.lineFrom + range.from;
        const to = match.lineFrom + range.to;
        ranges.push({
          from,
          to,
          safe: isGraphemeSafeReplacementRange(match.lineText, range.from, range.to),
          match,
        });
      }
    }
    return ranges;
  }

  private replacementInput(): HTMLInputElement | null {
    return document.getElementById("project-search-replace") as HTMLInputElement | null;
  }

  private updateReplacementControls(): void {
    const fuzzy = this.state.options.mode === "fuzzy";
    const row = document.getElementById("project-search-replace-row");
    row?.classList.toggle("hidden", fuzzy);
    const replaceAll = document.getElementById("project-search-replace-all") as HTMLButtonElement | null;
    if (replaceAll) {
      replaceAll.disabled = !this.canReplaceAll();
      replaceAll.title = replaceAll.disabled
        ? "Wait for a complete literal or regex search with replaceable matches"
        : "Replace every safe match in these results";
    }
    const review = document.getElementById("project-search-review-replace") as HTMLButtonElement | null;
    if (review) {
      review.disabled = !this.canApplyReplacement();
      review.title = review.disabled
        ? "Select replaceable matches after a complete literal or regex search"
        : "Review the selected matches before replacing";
    }
    const undo = document.getElementById("project-search-undo-replace") as HTMLButtonElement | null;
    if (undo) {
      const available = !this.applyingReplacement && this.deps.replacementUndoAvailable();
      undo.classList.toggle("hidden", !available);
      undo.disabled = !available;
    }
  }

  private canReplaceAll(): boolean {
    return this.replacementReady() && this.hasReplaceableMatches();
  }

  private canApplyReplacement(): boolean {
    return this.replacementReady() && this.selectedMatches.size > 0;
  }

  private replacementReady(): boolean {
    return this.state.options.mode !== "fuzzy"
      && this.state.options.query.trim().length > 0
      && !this.state.searching
      && !this.state.truncated
      && !this.state.incomplete
      && !this.state.error
      && !this.applyingReplacement;
  }

  private hasReplaceableMatches(): boolean {
    for (const file of this.fileResults.values()) {
      if (this.fileMatchRanges(file).some(range => range.safe)) return true;
    }
    return false;
  }

  private buildReplacementRequest(all = false): ProjectReplacementRequest | null {
    const files: ProjectReplacementFileRequest[] = [];
    for (const file of this.fileResults.values()) {
      const matches = this.fileMatchRanges(file)
        .filter(range => range.safe
          && (all || this.selectedMatches.has(projectReplacementMatchKey(file.path, range.from, range.to))))
        .map(range => ({ from: range.from, to: range.to }));
      if (matches.length === 0) continue;
      files.push({
        path: file.path,
        relativePath: file.relativePath,
        textRevision: file.textRevision,
        matches,
      });
    }
    if (files.length === 0) return null;
    return {
      options: this.state.options,
      replacement: this.replacementInput()?.value ?? "",
      files,
    };
  }

  private startReplacementReview(): void {
    if (!this.canApplyReplacement() || !this.buildReplacementRequest()) return;
    this.reviewingReplacement = true;
    this.scheduleRender();
  }

  /** Apply now: `all` ignores checkboxes, otherwise the reviewed selection is used. */
  private requestReplacement(all: boolean): boolean {
    if (all ? !this.canReplaceAll() : !this.canApplyReplacement()) return false;
    const request = this.buildReplacementRequest(all);
    if (!request) return false;
    this.applyingReplacement = true;
    this.updateReplacementControls();
    void this.applyReplacementRequest(request).finally(() => {
      this.applyingReplacement = false;
      this.updateReplacementControls();
    });
    return true;
  }

  private renderReplacementReview(container: HTMLElement): void {
    const request = this.buildReplacementRequest();
    if (!request) {
      this.reviewingReplacement = false;
      this.render();
      return;
    }
    const section = document.createElement("section");
    section.className = "project-search-review";
    const title = document.createElement("div");
    title.className = "project-search-review-title";
    title.textContent = `Review replacement in ${request.files.length} file${request.files.length === 1 ? "" : "s"}`;
    const summary = document.createElement("div");
    summary.className = "project-search-review-summary";
    const total = request.files.reduce((sum, file) => sum + file.matches.length, 0);
    summary.textContent = `${total} match${total === 1 ? "" : "es"} selected. Source files are not written until you save.`;
    section.append(title, summary);
    let previewCount = 0;
    let previewTruncated = false;
    const maxPreviewLines = 500;

    for (const requestFile of request.files) {
      const file = this.fileResults.get(filePathKey(requestFile.path));
      if (!file) continue;
      const fileHeading = document.createElement("div");
      fileHeading.className = "project-search-review-file";
      fileHeading.textContent = `${file.relativePath} (${requestFile.matches.length})`;
      section.appendChild(fileHeading);
      for (const match of file.contentMatches) {
        const selected = match.ranges
          .map(range => ({
            range,
            from: match.lineFrom + range.from,
            to: match.lineFrom + range.to,
          }))
          .filter(range => requestFile.matches.some(requested =>
            requested.from === range.from && requested.to === range.to));
        if (selected.length === 0) continue;
        if (previewCount >= maxPreviewLines) {
          previewTruncated = true;
          break;
        }
        previewCount += 1;
        let afterLine = match.lineText;
        for (const selectedRange of [...selected].sort((left, right) => right.range.from - left.range.from)) {
          const replacement = previewSearchReplacement(
            this.state.options,
            request.replacement,
            match.lineText.slice(selectedRange.range.from, selectedRange.range.to),
          );
          afterLine = afterLine.slice(0, selectedRange.range.from)
            + replacement
            + afterLine.slice(selectedRange.range.to);
        }
        const line = document.createElement("div");
        line.className = "project-search-review-line";
        const lineNumber = document.createElement("span");
        lineNumber.className = "project-search-line-number";
        lineNumber.textContent = String(match.lineNumber);
        const before = document.createElement("code");
        before.className = "project-search-review-before";
        before.textContent = `- ${match.lineText}`;
        const after = document.createElement("code");
        after.className = "project-search-review-after";
        after.textContent = `+ ${afterLine}`;
        line.append(lineNumber, before, after);
        section.appendChild(line);
      }
      if (previewTruncated) break;
    }
    if (previewTruncated) {
      const notice = this.notice(
        `Showing the first ${maxPreviewLines} changed lines. Apply still replaces every selected match.`,
        "info",
      );
      section.appendChild(notice);
    }

    const actions = document.createElement("div");
    actions.className = "project-search-review-actions";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Back";
    back.addEventListener("click", () => {
      this.reviewingReplacement = false;
      this.scheduleRender();
    });
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary";
    apply.textContent = "Apply Replacement";
    apply.addEventListener("click", () => {
      apply.disabled = true;
      if (!this.requestReplacement(false)) apply.disabled = false;
    });
    actions.append(back, apply);
    section.appendChild(actions);
    container.replaceChildren(section);
  }

  private async applyReplacementRequest(request: ProjectReplacementRequest): Promise<void> {
    const result = await this.deps.applyReplacement(request);
    this.reviewingReplacement = false;
    this.selectedMatches.clear();
    if (!result.ok) {
      this.suppressSelectionDefaults = true;
      void this.runSearch();
      this.state.error = result.message ?? "Project replacement failed.";
      this.scheduleRender();
      return;
    }
    const notice = `Replaced ${result.matches ?? 0} match${result.matches === 1 ? "" : "es"} in ${result.files ?? 0} file${result.files === 1 ? "" : "s"}. Save to keep the changes, or choose Undo Replace to revert.`;
    this.suppressSelectionDefaults = true;
    void this.runSearch();
    this.state.notice = notice;
    this.scheduleRender();
  }

  private async undoReplacementBatch(): Promise<void> {
    if (this.applyingReplacement) return;
    this.applyingReplacement = true;
    this.updateReplacementControls();
    let result: ProjectReplacementResult;
    try {
      result = await this.deps.undoReplacement();
    } finally {
      this.applyingReplacement = false;
    }
    this.reviewingReplacement = false;
    this.selectedMatches.clear();
    this.suppressSelectionDefaults = true;
    void this.runSearch();
    if (!result.ok) {
      this.state.error = result.message ?? "Undo Replace failed.";
    } else {
      this.state.notice = "Undo Replace restored the previous file contents.";
    }
    this.updateReplacementControls();
    this.scheduleRender();
  }

  private readOptions(): ProjectSearchOptions {
    const query = this.queryInput()?.value ?? "";
    return {
      query,
      mode: (this.modeSelect()?.value as ProjectSearchMode | undefined) ?? "literal",
      caseSensitive: this.caseCheckbox()?.checked ?? false,
      wholeWord: this.wholeWordCheckbox()?.checked ?? false,
      matchDiacritics: this.diacriticsCheckbox()?.checked ?? true,
      includeIgnored: this.includeIgnoredCheckbox()?.checked ?? false,
      mainDocumentOnly: this.mainDocumentOnlyCheckbox()?.checked ?? true,
      includeGlobs: parseProjectSearchGlobs(this.includeGlobsInput()?.value ?? ""),
      excludeGlobs: parseProjectSearchGlobs(this.excludeGlobsInput()?.value ?? ""),
    };
  }

  private updateModeControls(): void {
    const mode = (this.modeSelect()?.value as ProjectSearchMode | undefined) ?? "literal";
    const fuzzy = mode === "fuzzy";
    const regex = mode === "regex";
    const wholeWord = this.wholeWordCheckbox();
    if (wholeWord) wholeWord.disabled = fuzzy;
    const diacritics = this.diacriticsCheckbox();
    if (diacritics) {
      diacritics.disabled = fuzzy || regex;
      if (regex) diacritics.checked = true;
    }
    const input = this.queryInput();
    if (input) input.placeholder = fuzzy ? "Fuzzy search project" : "Search project";
  }

  private resetOptionControls(): void {
    const mode = this.modeSelect();
    if (mode) mode.value = "literal";
    const caseField = this.caseCheckbox();
    if (caseField) caseField.checked = false;
    const wholeWord = this.wholeWordCheckbox();
    if (wholeWord) wholeWord.checked = false;
    const diacritics = this.diacriticsCheckbox();
    if (diacritics) diacritics.checked = true;
    const ignored = this.includeIgnoredCheckbox();
    if (ignored) ignored.checked = false;
    const mainOnly = this.mainDocumentOnlyCheckbox();
    if (mainOnly) mainOnly.checked = true;
    const include = this.includeGlobsInput();
    if (include) include.value = "";
    const exclude = this.excludeGlobsInput();
    if (exclude) exclude.value = "";
    this.updateModeControls();
  }

  private queryInput(): HTMLInputElement | null {
    return document.getElementById("project-search-input") as HTMLInputElement | null;
  }

  private modeSelect(): HTMLSelectElement | null {
    return document.getElementById("project-search-mode") as HTMLSelectElement | null;
  }

  private caseCheckbox(): HTMLInputElement | null {
    return document.getElementById("project-search-case") as HTMLInputElement | null;
  }

  private wholeWordCheckbox(): HTMLInputElement | null {
    return document.getElementById("project-search-whole-word") as HTMLInputElement | null;
  }

  private diacriticsCheckbox(): HTMLInputElement | null {
    return document.getElementById("project-search-diacritics") as HTMLInputElement | null;
  }

  private includeIgnoredCheckbox(): HTMLInputElement | null {
    return document.getElementById("project-search-include-ignored") as HTMLInputElement | null;
  }

  private mainDocumentOnlyCheckbox(): HTMLInputElement | null {
    return document.getElementById("project-search-main-only") as HTMLInputElement | null;
  }

  private includeGlobsInput(): HTMLInputElement | null {
    return document.getElementById("project-search-include") as HTMLInputElement | null;
  }

  private excludeGlobsInput(): HTMLInputElement | null {
    return document.getElementById("project-search-exclude") as HTMLInputElement | null;
  }

  private resultsElement(): HTMLElement | null {
    return document.getElementById("project-search-results");
  }
}

function appendHighlighted(
  container: HTMLElement,
  text: string,
  ranges: readonly { from: number; to: number }[],
  from: number,
  to: number,
): void {
  let cursor = Math.max(0, Math.min(from, text.length));
  const end = Math.max(cursor, Math.min(to, text.length));
  for (const range of ranges) {
    const rangeFrom = Math.max(cursor, Math.min(range.from, end));
    const rangeTo = Math.max(rangeFrom, Math.min(range.to, end));
    if (rangeTo <= rangeFrom) continue;
    if (rangeFrom > cursor) container.append(text.slice(cursor, rangeFrom));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(rangeFrom, rangeTo);
    container.append(mark);
    cursor = rangeTo;
  }
  if (cursor < end) container.append(text.slice(cursor, end));
}
