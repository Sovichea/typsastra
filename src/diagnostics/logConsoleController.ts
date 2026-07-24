import { createAppIcon } from "../ui/icons";
import { filePathKey } from "../platform/paths";

export type LogEntryKind = "error" | "warning" | "info" | "log" | "hint";
export type LogEntryChannel = "lsp" | "spellcheck" | "dev";
type LogConsoleTab = "all" | LogEntryChannel;

export type LogConsoleLocationInput = {
  filePath?: string;
  fileName?: string;
  line: number;
  column: number;
  offset?: number;
  toOffset?: number;
};

export type LogConsoleEntryInput = {
  kind: LogEntryKind;
  message: string;
  source: string;
  filePath?: string;
  fileName?: string;
  line?: number;
  column?: number;
  offset?: number;
  toOffset?: number;
  channel?: LogEntryChannel;
  counted?: boolean;
  locations?: LogConsoleLocationInput[];
};

type LogConsoleEntry = LogConsoleEntryInput & {
  id: number;
  timestamp: Date;
};

export function duplicatesStructuredDiagnostic(
  entry: Pick<LogConsoleEntryInput, "channel" | "message">,
  diagnostics: readonly Pick<LogConsoleEntryInput, "message">[]
): boolean {
  if (entry.channel === "dev") return false;
  const message = canonicalDiagnosticMessage(entry.message);
  return message.length > 0 && diagnostics.some(
    diagnostic => canonicalDiagnosticMessage(diagnostic.message) === message
  );
}

export function spellcheckConsoleGroupKey(sourceText: string, ignored: boolean): string {
  return `${ignored ? "ignored" : "unknown"}:${sourceText}`;
}

function canonicalDiagnosticMessage(message: string): string {
  let msg = message
    .normalize("NFKC")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // strip ANSI escape codes
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();

  // Normalize path-like components to just their last components (basenames)
  // to avoid duplication due to absolute cache path vs original workspace path mismatches
  msg = msg.split(" ").map(word => {
    if (word.includes("/") || word.includes("\\")) {
      const lastSlash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
      return word.slice(lastSlash + 1);
    }
    return word;
  }).join(" ");

  msg = msg.toLowerCase();

  // Strip prefixes
  let oldMsg;
  do {
    oldMsg = msg;
    msg = msg
      .replace(/^(?:error|warning|info|hint|typst|tinymist|problem|log)[:\s\-]+/g, "")
      .replace(/^\[(?:error|warning|info|hint|typst|tinymist|problem|log)\][:\s\-]*/g, "")
      .trim();
  } while (msg !== oldMsg);

  // Strip trailing period/colon/brackets/whitespaces
  msg = msg.replace(/[.:\s\-\]\[]+$/, "");

  return msg;
}

export class LogConsoleController {
  private nextEntryId = 1;
  private diagnostics: LogConsoleEntry[] = [];
  private diagnosticsByFile = new Map<string, LogConsoleEntry[]>();
  private spellcheckIssues: LogConsoleEntry[] = [];
  private expandedSpellcheckEntries = new Set<string>();
  private activeSpellcheckLocation: { filePath: string; offset: number; toOffset: number } | null = null;
  private logs: LogConsoleEntry[] = [];
  private activeTab: LogConsoleTab = "all";
  private visible = false;
  private readonly console = document.getElementById("log-console")!;
  private readonly body = document.getElementById("log-console-body")!;
  private readonly toggleButton = document.getElementById("log-console-toggle") as HTMLButtonElement;
  private readonly closeButton = document.getElementById("log-console-close") as HTMLButtonElement;
  private readonly clearButton = document.getElementById("log-console-clear") as HTMLButtonElement;
  private readonly errorCount = document.getElementById("diagnostic-error-count")!;
  private readonly warningCount = document.getElementById("diagnostic-warning-count")!;
  private readonly tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-log-console-tab]")];
  private renderFrame: number | null = null;
  private renderPending = false;

  constructor(private readonly onNavigate: (entry: LogConsoleEntryInput) => void | Promise<void>) {}

  public initialize(): void {
    this.toggleButton.addEventListener("click", () => this.toggle());
    this.closeButton.addEventListener("click", () => this.setVisible(false));
    this.clearButton.addEventListener("click", () => this.clearLogs());
    for (const tab of this.tabs) {
      tab.addEventListener("click", () => {
        this.activeTab = tab.dataset.logConsoleTab as LogConsoleTab;
        this.renderNow();
      });
    }
    this.renderNow();
    this.setVisible(false);
  }

  public getErrorCount(): number {
    return this.diagnostics.filter(entry => entry.kind === "error").length;
  }

  public setDiagnostics(filePath: string, entries: LogConsoleEntryInput[]): void {
    const filtered = entries.filter(entry => entry.source !== "preview" && entry.source !== "preview iframe" && entry.source !== "inverse sync");
    // Filter out duplicates in incoming diagnostics
    const seen = new Set<string>();
    const uniqueEntries: LogConsoleEntryInput[] = [];
    for (const entry of filtered) {
      const key = `${entry.filePath}:${entry.line}:${entry.column}:${canonicalDiagnosticMessage(entry.message)}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueEntries.push(entry);
      }
    }

    const mappedEntries = uniqueEntries.map(entry => this.createEntry({ ...entry, channel: "lsp" }));
    const fileKey = filePath.toLowerCase();
    if (mappedEntries.length > 0) {
      this.diagnosticsByFile.set(fileKey, mappedEntries);
    } else {
      this.diagnosticsByFile.delete(fileKey);
    }

    this.diagnostics = Array.from(this.diagnosticsByFile.values()).flat();
    this.logs = this.logs.filter(log => !duplicatesStructuredDiagnostic(log, this.diagnostics));
    this.requestRender();
  }

  public setSpellcheckIssues(entries: LogConsoleEntryInput[]): void {
    this.spellcheckIssues = entries.map(entry => this.createEntry({ ...entry, channel: "spellcheck" }));
    this.requestRender();
  }

  public setActiveSpellcheckLocation(filePath: string | null, offset?: number, toOffset?: number): void {
    this.activeSpellcheckLocation = filePath !== null && offset !== undefined
      ? { filePath, offset, toOffset: toOffset ?? offset }
      : null;
    this.body.querySelectorAll<HTMLElement>(".log-entry-location").forEach(item => {
      item.classList.toggle("active", this.locationElementIsActive(item));
    });
  }

  public appendLog(entry: LogConsoleEntryInput): void {
    if (entry.channel !== "dev"
      && (entry.source === "preview" || entry.source === "preview iframe" || entry.source === "inverse sync")) return;
    const log = this.createEntry({ ...entry, channel: entry.channel ?? "lsp" });
    if (duplicatesStructuredDiagnostic(log, this.diagnostics)) return;

    // Filter duplicates within current log entries
    const canonical = canonicalDiagnosticMessage(log.message);
    if (this.logs.some(existing => canonicalDiagnosticMessage(existing.message) === canonical)) {
      return;
    }

    this.logs.unshift(log);
    this.logs = this.logs.slice(0, 100);
    this.requestRender();
  }

  public clearDiagnostics(): void {
    this.diagnosticsByFile.clear();
    this.diagnostics = [];
    this.requestRender();
  }

  public clearLogs(): void {
    this.logs = [];
    this.requestRender();
  }

  public toggle(): void {
    this.setVisible(!this.visible);
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.console.classList.toggle("hidden", !visible);
    document.getElementById("log-console-resizer")?.classList.toggle("hidden", !visible);
    this.updateCount();
    if (visible && this.renderPending) this.renderNow();
  }

  private createEntry(entry: LogConsoleEntryInput): LogConsoleEntry {
    return { ...entry, id: this.nextEntryId++, timestamp: new Date() };
  }

  private requestRender(): void {
    this.renderPending = true;
    this.updateCount();
    // Compiler messages and diagnostics often arrive in bursts. Rebuilding a
    // hidden console—or rebuilding a visible one for every message—competes
    // directly with pointer and keyboard input.
    if (!this.visible || this.renderFrame !== null) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      if (this.visible && this.renderPending) this.renderNow();
    });
  }

  private renderNow(): void {
    if (this.renderFrame !== null) {
      cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
    this.renderPending = false;
    this.updateCount();
    this.body.replaceChildren();
    for (const tab of this.tabs) {
      const selected = tab.dataset.logConsoleTab === this.activeTab;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
    }
    const entries = this.filteredEntries();
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "log-console-empty";
      empty.textContent = "No problems";
      this.body.appendChild(empty);
      return;
    }

    const groups = new Map<string, LogConsoleEntry[]>();
    for (const entry of entries) {
      const key = entry.filePath ?? entry.source ?? "Other";
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const [key, group] of groups) this.body.appendChild(this.createGroup(key, group));
  }

  private filteredEntries(): LogConsoleEntry[] {
    const structured = this.diagnostics.filter(entry => entry.filePath && entry.line !== undefined);
    const visibleLogs = this.logs.filter(log =>
      (log.filePath && log.line !== undefined)
      || !duplicatesStructuredDiagnostic(log, structured)
    );
    const all = [...this.diagnostics, ...this.spellcheckIssues, ...visibleLogs];
    if (this.activeTab === "all") return all;
    return all.filter(entry => entry.channel === this.activeTab);
  }

  private createGroup(groupKey: string, entries: LogConsoleEntry[]): HTMLElement {
    const container = document.createElement("div");
    container.className = "log-group";
    const header = document.createElement("button");
    header.className = "log-group-header";
    header.type = "button";

    const first = entries[0];
    const fileName = first.fileName ?? groupKey;
    const directory = first.filePath ? this.dirname(first.filePath) : "";
    const name = document.createElement("span");
    name.className = "log-group-filename";
    name.textContent = fileName;
    const directoryName = document.createElement("span");
    directoryName.className = "log-group-dirname";
    directoryName.textContent = directory;
    const count = document.createElement("span");
    count.className = "log-group-count";
    count.textContent = String(entries.length);
    header.append(name, directoryName, count);

    const items = document.createElement("div");
    items.className = "log-group-items";
    for (const entry of entries) items.appendChild(this.createItem(entry));
    header.addEventListener("click", () => items.classList.toggle("hidden"));
    container.append(header, items);
    return container;
  }

  private createItem(entry: LogConsoleEntry): HTMLElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `log-entry log-entry-${entry.kind}`;
    const icon = document.createElement("span");
    icon.className = "log-entry-icon";
    icon.appendChild(createAppIcon(
      entry.kind === "error" ? "circleX" : entry.kind === "warning" ? "triangleAlert" : "info",
      { size: 14 }
    ));
    const message = document.createElement("span");
    message.className = "log-entry-message";
    message.textContent = entry.message;
    const source = document.createElement("span");
    source.className = "log-entry-source";
    source.textContent = entry.source ? `typst(${entry.source})` : "";
    const location = document.createElement("span");
    location.className = "log-entry-position";
    if (entry.locations?.length) {
      location.textContent = `${entry.locations.length} location${entry.locations.length === 1 ? "" : "s"}`;
    } else if (entry.line) {
      location.textContent = `[Ln ${entry.line}, Col ${entry.column ?? 1}]`;
    }
    item.append(icon, message, source, location);
    if (!entry.locations?.length) {
      item.addEventListener("click", () => { void this.onNavigate(entry); });
      return item;
    }

    const cluster = document.createElement("div");
    cluster.className = "log-entry-cluster";
    const locations = document.createElement("div");
    const expansionKey = this.spellcheckExpansionKey(entry);
    const initiallyExpanded = this.expandedSpellcheckEntries.has(expansionKey);
    locations.className = `log-entry-locations${initiallyExpanded ? "" : " hidden"}`;
    item.setAttribute("aria-expanded", String(initiallyExpanded));
    item.addEventListener("click", () => {
      const expanded = !locations.classList.toggle("hidden");
      item.setAttribute("aria-expanded", String(expanded));
      if (expanded) this.expandedSpellcheckEntries.add(expansionKey);
      else this.expandedSpellcheckEntries.delete(expansionKey);
    });
    for (const occurrence of entry.locations) {
      const occurrenceButton = document.createElement("button");
      occurrenceButton.type = "button";
      occurrenceButton.className = "log-entry log-entry-location";
      occurrenceButton.dataset.filePath = occurrence.filePath ?? entry.filePath ?? "";
      occurrenceButton.dataset.offset = String(occurrence.offset ?? "");
      occurrenceButton.dataset.toOffset = String(occurrence.toOffset ?? occurrence.offset ?? "");
      occurrenceButton.classList.toggle("active", this.locationElementIsActive(occurrenceButton));
      occurrenceButton.textContent = `Ln ${occurrence.line}, Col ${occurrence.column}`;
      occurrenceButton.addEventListener("click", () => {
        this.setActiveSpellcheckLocation(
          occurrence.filePath ?? entry.filePath ?? null,
          occurrence.offset,
          occurrence.toOffset
        );
        void this.onNavigate({ ...entry, ...occurrence, locations: undefined });
      });
      locations.appendChild(occurrenceButton);
    }
    cluster.append(item, locations);
    return cluster;
  }

  private spellcheckExpansionKey(entry: LogConsoleEntry): string {
    return `${entry.filePath ?? ""}\u0000${entry.message}`;
  }

  private locationElementIsActive(item: HTMLElement): boolean {
    const active = this.activeSpellcheckLocation;
    if (!active || filePathKey(item.dataset.filePath ?? "") !== filePathKey(active.filePath)) return false;
    return Number(item.dataset.offset) === active.offset
      && Number(item.dataset.toOffset) === active.toOffset;
  }

  private updateCount(): void {
    const errors = this.diagnostics.filter(entry => entry.kind === "error").length;
    const warnings = this.diagnostics.filter(entry => entry.kind === "warning").length;
    const total = this.diagnostics.length;
    const spellcheck = this.spellcheckIssues.filter(entry => entry.counted !== false).length;
    const problems = total + spellcheck;
    const totalWarnings = warnings + spellcheck;

    this.errorCount.textContent = errors > 99 ? "99+" : String(errors);
    this.warningCount.textContent = totalWarnings > 99 ? "99+" : String(totalWarnings);

    // Toggle active state classes on parent items
    const errorItem = this.errorCount.closest(".status-count-item");
    if (errorItem) {
      errorItem.classList.toggle("active", errors > 0);
    }
    const warningItem = this.warningCount.closest(".status-count-item");
    if (warningItem) {
      warningItem.classList.toggle("active", totalWarnings > 0);
    }

    this.setTabCount("all", problems);
    this.setTabCount("lsp", total);
    this.setTabCount("spellcheck", spellcheck);
    this.setTabCount("dev", this.logs.filter(entry => entry.channel === "dev").length);
    this.toggleButton.dataset.state = errors ? "error" : totalWarnings ? "warning" : "ok";
    this.toggleButton.setAttribute("aria-expanded", String(this.visible));
    this.toggleButton.setAttribute("aria-label", `${this.visible ? "Hide" : "Show"} log console, ${errors} error${errors === 1 ? "" : "s"}, ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}`);
  }

  private setTabCount(tab: LogConsoleTab, value: number): void {
    const count = document.querySelector<HTMLElement>(`[data-log-console-count="${tab}"]`);
    if (count) count.textContent = value > 99 ? "99+" : String(value);
  }

  private dirname(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash > 0 ? normalized.slice(0, lastSlash) : "";
  }
}
