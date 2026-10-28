export type PreviewFreshness = {
  status: "current" | "outdated" | "compiling" | "failed";
  externalFiles: readonly string[];
  lspErrors?: boolean;
};

type CompilationToken = { revision: number; id: number };

/** Tracks source revisions independently of language-server health. */
export class PreviewFreshnessController {
  private revision = 0;
  private nextCompilationId = 0;
  private active: CompilationToken | null = null;
  private externalFiles = new Set<string>();
  private status: PreviewFreshness["status"] = "current";
  private editorChanges = new Map<string, { baseline: string; current: string }>();
  private untrackedChange = false;
  private lspErrors = false;
  constructor(private readonly publish: (state: PreviewFreshness) => void = () => {}) {}
  get state(): PreviewFreshness { return { status: this.status, externalFiles: [...this.externalFiles], ...(this.lspErrors ? { lspErrors: true } : {}) }; }
  setLspErrors(hasErrors: boolean): void {
    if (this.lspErrors === hasErrors) return;
    this.lspErrors = hasErrors;
    this.publish(this.state);
  }
  changed(path?: string, external = false): void {
    this.revision++;
    this.untrackedChange = true;
    if (external && path) this.externalFiles.add(path);
    if (this.status !== "compiling") this.status = "outdated";
    this.publish(this.state);
  }
  editorChanged(path: string, before: string, after: string): void {
    this.revision++;
    if (!this.editorChanges.size && this.status !== "current" && this.status !== "compiling") this.untrackedChange = true;
    if (!this.untrackedChange) {
      const change = this.editorChanges.get(path) ?? { baseline: before, current: before };
      change.current = after;
      this.editorChanges.set(path, change);
    }
    if (this.status !== "compiling") {
      this.status = !this.untrackedChange && [...this.editorChanges.values()].every(change => change.current === change.baseline)
        ? "current" : "outdated";
    }
    this.publish(this.state);
  }
  begin(): CompilationToken {
    this.active = { revision: this.revision, id: ++this.nextCompilationId };
    this.status = "compiling"; this.publish(this.state); return this.active;
  }
  finish(token: CompilationToken, success: boolean): void {
    if (token.id !== this.active?.id) return;
    this.active = null;
    this.status = success ? token.revision === this.revision ? "current" : "outdated" : "failed";
    if (this.status === "current") {
      this.externalFiles.clear();
      this.editorChanges.clear();
      this.untrackedChange = false;
    } else if (success) {
      // A completed compile may include edits made since the old preview.
      // Its exact source baseline is unknown when newer edits raced it.
      this.editorChanges.clear();
      this.untrackedChange = true;
    }
    this.publish(this.state);
  }
  interrupted(token?: CompilationToken): void {
    if (token?.id !== this.active?.id || !this.active) return;
    this.active = null;
    this.status = !this.untrackedChange && this.editorChanges.size > 0
      && [...this.editorChanges.values()].every(change => change.current === change.baseline) ? "current" : "outdated";
    this.publish(this.state);
  }
  reset(): void { this.active = null; this.revision++; this.externalFiles.clear(); this.editorChanges.clear(); this.untrackedChange = false; this.lspErrors = false; this.status = "current"; this.publish(this.state); }
}

export function renderPreviewFreshnessBanner(state: PreviewFreshness, root: Document = document): void {
  const toolbarButton = root.getElementById("preview-recompile-btn") as HTMLButtonElement | null;
  if (toolbarButton) {
    toolbarButton.disabled = state.status === "compiling" || !!state.lspErrors;
    toolbarButton.title = state.lspErrors ? "Fix source errors reported by the language server before recompiling." : "Recompile preview";
  }
  const banner = root.getElementById("preview-status-banner");
  if (!banner) return;
  banner.hidden = (state.status === "current" && !state.lspErrors)
    || root.getElementById("preview-container-wrapper")?.dataset.previewStatusEnabled === "false";
  banner.dataset.status = state.status;
  const label = banner.querySelector<HTMLElement>("[data-preview-status-label]");
  if (label) label.textContent = state.status === "compiling" ? "Compiling preview..."
    : state.status === "failed" ? "Compilation failed - showing previous preview"
    : "Source changed - preview outdated";
  const detail = banner.querySelector<HTMLElement>("[data-preview-status-detail]");
  if (detail) {
    const count = state.externalFiles.length;
    detail.textContent = count ? `${count} file${count === 1 ? "" : "s"} changed externally. Recompile when external editing is complete.` : "";
    detail.title = state.externalFiles.join("\n");
  }
  const button = banner.querySelector<HTMLButtonElement>("[data-preview-status-recompile]");
  if (button) {
    button.disabled = state.status === "compiling" || !!state.lspErrors;
    button.title = state.lspErrors ? "Fix source errors reported by the language server before recompiling." : "Recompile preview";
    button.onclick = () => {
      if (!button.disabled) root.getElementById("preview-recompile-btn")?.click();
    };
  }
}
