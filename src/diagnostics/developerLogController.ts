import type { LspLogEntry } from "../compiler/lsp";
import type { SpellcheckDebugEvent } from "../editor/spellcheck";
import type { DeveloperLogCategory } from "../settings";
import { fileNameFromPath } from "../platform/paths";
import type { LogConsoleController } from "./logConsoleController";

export interface DeveloperLogDependencies {
  logConsole(): LogConsoleController;
  activeFilePath(): string | null;
  developerLogging(): {
    enabled: boolean;
    categories: Record<DeveloperLogCategory, boolean>;
  };
}

/** Owns LSP/developer/spellcheck diagnostic log routing and filtering. */
export class DeveloperLogController {
  constructor(private readonly deps: DeveloperLogDependencies) {}

  appendLsp(entry: LspLogEntry): void {
    this.deps.logConsole().appendLog({
      kind: entry.kind,
      source: entry.source ?? "tinymist",
      message: entry.message,
      channel: "lsp",
    });
  }

  appendDeveloper(entry: LspLogEntry): void {
    const source = entry.source ?? "developer";
    if (!this.isEnabled(this.categoryFor(source))) return;
    this.deps.logConsole().appendLog({
      kind: entry.kind,
      source,
      message: entry.message,
      channel: "dev",
      // Developer entries are opt-in per category, so they must be marked
      // counted or the console filters them out of every rendered list.
      counted: true,
    });
  }

  appendSpellcheckDebug(event: SpellcheckDebugEvent): void {
    if (!this.isEnabled("spellcheck")) return;
    const message = `${event.stage} [revision ${event.revision}]: ${JSON.stringify(event.detail)}`;
    console.info(`[spellcheck debug] ${event.documentKey || "no-document"} ${message}`);
    const filePath = this.deps.activeFilePath() ?? undefined;
    this.deps.logConsole().appendLog({
      kind: event.stage.endsWith("failed") ? "warning" : "info",
      source: "spellcheck debug",
      message,
      channel: "dev",
      filePath,
      fileName: filePath ? fileNameFromPath(filePath) : undefined,
    });
  }

  private categoryFor(source: string): DeveloperLogCategory {
    const normalized = source.toLocaleLowerCase();
    if (normalized.includes("inverse sync")) return "inverseSync";
    if (normalized.includes("forward sync")) return "forwardSync";
    if (normalized.includes("memory")) return "memory";
    if (normalized.includes("performance")) return "performance";
    if (normalized.includes("preview")) return "preview";
    if (normalized.includes("lsp") || normalized.includes("tinymist") || normalized.includes("toolchain")) return "lsp";
    if (normalized.includes("spellcheck") || normalized.includes("language scope") || normalized.includes("document script")) return "spellcheck";
    return "general";
  }

  isEnabled(category: DeveloperLogCategory): boolean {
    const logging = this.deps.developerLogging();
    return logging.enabled && logging.categories[category];
  }
}
