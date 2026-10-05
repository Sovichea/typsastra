import { createAppIcon } from "../ui/icons";
import { filePathKey } from "../platform/paths";
import { spellcheckConsoleGroupKey, type LogConsoleEntryInput } from "./logConsoleController";

export type SpellcheckSidebarEntry = {
  key: string;
  word: string;
  ignored: boolean;
  providers: string[];
  locations: Array<{
    filePath: string;
    fileName: string;
    line: number;
    column: number;
    offset: number;
    toOffset: number;
  }>;
};

export type DocumentSidebarPane = "outline" | "spellcheck" | "none";

export function nextDocumentSidebarPane(
  active: DocumentSidebarPane,
  clicked: Exclude<DocumentSidebarPane, "none">,
): DocumentSidebarPane {
  return active === clicked ? "none" : clicked;
}

/**
 * Renders unknown words beside the Outline as a collapsible sidebar section.
 *
 * Spellcheck used to live in the Problems console, which mixed dictionary
 * findings with compiler output. Selecting a word in the editor is the natural
 * follow-up action, so it belongs with the document structure.
 */
export class SpellcheckSidebarPane {
  private entries: SpellcheckSidebarEntry[] = [];
  private activeLocation: { filePath: string; offset: number; toOffset: number } | null = null;
  private renderFrame: number | null = null;
  private renderPending = false;
  private readonly section = document.getElementById("spellcheck-section") as HTMLElement | null;
  private readonly toggle = document.getElementById("spellcheck-toggle") as HTMLButtonElement | null;
  private readonly count = document.getElementById("spellcheck-count");
  private readonly list = document.getElementById("spellcheck-list");

  constructor(
    private readonly onNavigate: (entry: LogConsoleEntryInput) => void | Promise<void>,
  ) {}

  public initialize(): void {
    if (!this.toggle || !this.section) return;
    this.renderNow();
  }

  /** Unknown, non-ignored words drive the badge; ignored words still list. */
  public setEntries(entries: SpellcheckSidebarEntry[]): void {
    this.entries = entries;
    this.requestRender();
  }

  public setActiveLocation(filePath: string | null, offset?: number, toOffset?: number): void {
    this.activeLocation = filePath !== null && offset !== undefined
      ? { filePath, offset, toOffset: toOffset ?? offset }
      : null;
    this.list?.querySelectorAll<HTMLElement>(".spellcheck-location").forEach(item => {
      item.classList.toggle("active", this.locationIsActive(item));
    });
  }

  public clear(): void {
    this.entries = [];
    this.activeLocation = null;
    this.requestRender();
  }

  public getCount(): number {
    return this.entries.filter(entry => !entry.ignored).length;
  }

  private requestRender(): void {
    this.renderPending = true;
    if (this.count) {
      const counted = this.getCount();
      this.count.textContent = counted > 99 ? "99+" : String(counted);
    }
    // The sidebar is always on screen, so rebuild on the next frame to avoid
    // competing with typing for layout work on every analysis result.
    if (this.renderFrame !== null) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      if (this.renderPending) this.renderNow();
    });
  }

  private renderNow(): void {
    if (this.renderFrame !== null) {
      cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
    this.renderPending = false;
    if (!this.list) return;
    this.list.replaceChildren();
    if (!this.entries.length) {
      const empty = document.createElement("div");
      empty.className = "outline-empty";
      empty.textContent = "No unknown words in the active document.";
      this.list.appendChild(empty);
      return;
    }
    for (const entry of this.entries) this.list.appendChild(this.createRow(entry));
  }

  private createRow(entry: SpellcheckSidebarEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "spellcheck-row";

    const word = document.createElement("button");
    word.type = "button";
    word.className = "spellcheck-word";
    if (entry.ignored) word.classList.add("ignored");
    word.title = entry.ignored
      ? `Ignored unknown word: “${entry.word}”`
      : `Unknown word: “${entry.word}”`;
    word.appendChild(createAppIcon(
      entry.ignored ? "info" : "triangleAlert",
      { size: 12, className: "spellcheck-word-icon" },
    ));
    const label = document.createElement("span");
    label.className = "spellcheck-word-label";
    label.textContent = entry.word;
    word.appendChild(label);
    const occurrences = document.createElement("span");
    occurrences.className = "spellcheck-occurrences";
    occurrences.textContent = String(entry.locations.length);
    word.appendChild(occurrences);
    row.appendChild(word);

    const locations = document.createElement("div");
    locations.className = "spellcheck-locations";
    word.setAttribute("aria-expanded", "true");
    word.addEventListener("click", () => {
      const expanded = locations.classList.toggle("hidden");
      word.setAttribute("aria-expanded", String(!expanded));
    });
    for (const occurrence of entry.locations) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "spellcheck-location";
      item.dataset.filePath = occurrence.filePath;
      item.dataset.offset = String(occurrence.offset);
      item.dataset.toOffset = String(occurrence.toOffset);
      item.classList.toggle("active", this.locationIsActive(item));
      item.textContent = `${occurrence.fileName}:${occurrence.line}`;
      item.title = `${occurrence.fileName}, line ${occurrence.line}, column ${occurrence.column}`;
      item.addEventListener("click", () => {
        this.setActiveLocation(
          occurrence.filePath,
          occurrence.offset,
          occurrence.toOffset,
        );
        void this.onNavigate({
          kind: entry.ignored ? "info" : "warning",
          message: `${entry.ignored ? "Ignored unknown word" : "Unknown word"}: “${entry.word}”`,
          source: entry.providers.join(", "),
          filePath: occurrence.filePath,
          fileName: occurrence.fileName,
          line: occurrence.line,
          column: occurrence.column,
          offset: occurrence.offset,
          toOffset: occurrence.toOffset,
        });
      });
      locations.appendChild(item);
    }
    row.appendChild(locations);
    return row;
  }

  private locationIsActive(item: HTMLElement): boolean {
    const active = this.activeLocation;
    if (!active || filePathKey(item.dataset.filePath ?? "") !== filePathKey(active.filePath)) return false;
    return Number(item.dataset.offset) === active.offset
      && Number(item.dataset.toOffset) === active.toOffset;
  }
}

/** Group spelling issues into sidebar rows, preserving exact spelling and case. */
export function spellcheckSidebarEntries(
  grouped: Iterable<{
    issue: { sourceText: string; ignored: boolean; provider: string };
    providers: Set<string>;
    locations: SpellcheckSidebarEntry["locations"];
  }>,
): SpellcheckSidebarEntry[] {
  const entries: SpellcheckSidebarEntry[] = [];
  for (const group of grouped) {
    entries.push({
      key: spellcheckConsoleGroupKey(group.issue.sourceText, group.issue.ignored),
      word: group.issue.sourceText,
      ignored: group.issue.ignored,
      providers: [...group.providers],
      locations: group.locations,
    });
  }
  entries.sort((left, right) => {
    if (left.ignored !== right.ignored) return left.ignored ? 1 : -1;
    return right.locations.length - left.locations.length || left.word.localeCompare(right.word);
  });
  return entries;
}
