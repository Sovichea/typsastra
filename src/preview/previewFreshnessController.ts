export type PreviewFreshness = {
  status: "current" | "outdated" | "compiling" | "failed";
  externalFiles: readonly string[];
};

type CompilationToken = { revision: number; id: number };

/** Tracks source revisions independently of language-server health. */
export class PreviewFreshnessController {
  private revision = 0;
  private nextCompilationId = 0;
  private active: CompilationToken | null = null;
  private externalFiles = new Set<string>();
  private status: PreviewFreshness["status"] = "current";
  constructor(private readonly publish: (state: PreviewFreshness) => void = () => {}) {}
  get state(): PreviewFreshness { return { status: this.status, externalFiles: [...this.externalFiles] }; }
  changed(path?: string, external = false): void {
    this.revision++;
    if (external && path) this.externalFiles.add(path);
    if (this.status !== "compiling") this.status = "outdated";
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
    if (this.status === "current") this.externalFiles.clear();
    this.publish(this.state);
  }
  interrupted(token?: CompilationToken): void {
    if (token?.id !== this.active?.id || !this.active) return;
    this.active = null; this.status = "outdated"; this.publish(this.state);
  }
  reset(): void { this.active = null; this.revision++; this.externalFiles.clear(); this.status = "current"; this.publish(this.state); }
}

export function renderPreviewFreshnessBanner(state: PreviewFreshness, root: Document = document): void {
  const banner = root.getElementById("preview-status-banner");
  if (!banner) return;
  banner.hidden = state.status === "current"
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
    button.disabled = state.status === "compiling";
    button.onclick = () => root.getElementById("preview-recompile-btn")?.click();
  }
}
