import { invoke } from "@tauri-apps/api/core";
import {
  parsePreviewCompilerDiagnostic,
  typstPackageEntrypoint,
  typstPackageImports,
  type PreviewCompilerFailure,
  type TypstPackageImport,
  type TypstPackageReference,
} from "../compiler/previewError";
import { fileNameFromPath, filePathKey } from "../platform/paths";
import type { LogConsoleController } from "./logConsoleController";

export type PreviewPackageFailureHint = {
  message: string;
  projectImport: TypstPackageImport;
};

export interface PreviewFailureControllerPort {
  mapToOriginalPath(path: string): string;
  sourceForPath(path: string): Promise<string>;
  isRenderCachePath(path: string): boolean;
  includePrimaryCompilerDiagnostic(): boolean;
  setCompilerRelatedDiagnostics(entries: PreviewCompilerRelatedDiagnostic[]): void;
}

export type PreviewCompilerRelatedDiagnostic = {
  filePath: string;
  line: number;
  column: number;
  message: string;
  severity?: "error" | "warning" | "related";
};

/** Resolves package dependency failures and publishes user-facing compiler problems. */
export class PreviewFailureController {
  constructor(
    private readonly logConsole: LogConsoleController,
    private readonly port: PreviewFailureControllerPort,
  ) {}

  async packageFailureHint(
    failure: PreviewCompilerFailure,
    reachableSourcePaths: readonly string[],
  ): Promise<PreviewPackageFailureHint | null> {
    if (!failure.package || !failure.packageCacheRoot || reachableSourcePaths.length === 0) return null;

    const projectImports: TypstPackageImport[] = [];
    for (const path of reachableSourcePaths.slice(0, 128)) {
      const originalPath = this.port.mapToOriginalPath(path);
      const source = await this.port.sourceForPath(originalPath);
      projectImports.push(...typstPackageImports(source, originalPath));
    }

    const uniqueImports = projectImports.filter((entry, index, entries) =>
      entries.findIndex(candidate =>
        candidate.package.spec === entry.package.spec
        && filePathKey(candidate.filePath) === filePathKey(entry.filePath)
        && candidate.line === entry.line
      ) === index
    );
    for (const projectImport of uniqueImports) {
      const chain = await this.packageDependencyChain(
        projectImport.package,
        failure.package,
        failure.packageCacheRoot,
      );
      if (!chain) continue;
      const relation = chain.length === 1
        ? `${projectImport.package.spec} is the package that failed.`
        : `${projectImport.package.spec} loads ${chain.slice(1).map(entry => entry.spec).join(" → ")}.`;
      return {
        projectImport,
        message: `${relation}\nUpdate ${projectImport.package.spec} to a release compatible with the selected Typst version.`,
      };
    }
    return null;
  }

  publish(
    failure: PreviewCompilerFailure,
    packageHint: PreviewPackageFailureHint | null,
    displayedMessage = failure.message,
  ): void {
    this.logConsole.clearLogsBySource(["compiler call site"]);
    const diagnostic = parsePreviewCompilerDiagnostic(displayedMessage);
    const primary = diagnostic?.frames[0] ?? null;
    const primaryEntry: PreviewCompilerRelatedDiagnostic[] = primary
      && this.port.includePrimaryCompilerDiagnostic()
      && !this.port.isRenderCachePath(primary.filePath)
      ? [{
          filePath: primary.filePath,
          line: primary.line,
          column: primary.column,
          message: diagnostic?.summary ?? failure.message,
          severity: "error",
        }]
      : [];
    const related: PreviewCompilerRelatedDiagnostic[] = (diagnostic?.frames.slice(1) ?? [])
      .filter(frame => !this.port.isRenderCachePath(frame.filePath))
      .filter(frame => !primary || frame.filePath !== primary.filePath
        || frame.line !== primary.line || frame.column !== primary.column)
      .map(frame => ({
        filePath: frame.filePath,
        line: frame.line,
        column: frame.column,
        message: frame.label
          ? `Related compiler location: ${frame.label}`
          : "Related compiler call site",
        severity: "related" as const,
      }));
    this.port.setCompilerRelatedDiagnostics([...primaryEntry, ...related]);
    for (const location of related) {
      this.logConsole.appendLog({
        kind: "error",
        source: "compiler call site",
        message: location.message,
        channel: "lsp",
        counted: false,
        persistent: true,
        filePath: location.filePath,
        fileName: fileNameFromPath(location.filePath),
        line: location.line,
        column: location.column,
      });
    }
    const failureComesFromRenderMirror = failure.location !== null
      && this.port.isRenderCachePath(failure.location.filePath);
    if (!failureComesFromRenderMirror) {
      this.logConsole.appendLog({
        kind: "error",
        source: "compiler",
        message: failure.message,
        channel: "lsp",
        counted: true,
        filePath: failure.location?.filePath,
        fileName: failure.location ? fileNameFromPath(failure.location.filePath) : undefined,
        line: failure.location?.line,
        column: failure.location?.column,
      });
    }
    if (!packageHint) return;
    this.logConsole.appendLog({
      kind: "error",
      source: "package compatibility",
      message: packageHint.message,
      channel: "lsp",
      counted: true,
      filePath: packageHint.projectImport.filePath,
      fileName: fileNameFromPath(packageHint.projectImport.filePath),
      line: packageHint.projectImport.line,
      column: packageHint.projectImport.column,
    });
  }

  clear(): void {
    this.port.setCompilerRelatedDiagnostics([]);
    this.logConsole.clearLogsBySource(["compiler call site"]);
  }

  publishSuccessfulDiagnostics(message: string): void {
    this.logConsole.clearLogsBySource(["compiler", "compiler call site"]);
    const blocks = message
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/(?=^(?:warning|error):\s)/gim)
      .map(block => block.trim())
      .filter(Boolean);
    const entries: PreviewCompilerRelatedDiagnostic[] = [];
    for (const block of blocks) {
      const diagnostic = parsePreviewCompilerDiagnostic(block);
      const primary = diagnostic?.frames[0];
      if (!diagnostic || !primary || this.port.isRenderCachePath(primary.filePath)) continue;
      const severity = /^error:/i.test(block) ? "error" as const : "warning" as const;
      entries.push({
        filePath: primary.filePath,
        line: primary.line,
        column: primary.column,
        message: diagnostic.summary,
        severity,
      });
      this.logConsole.appendLog({
        kind: severity,
        source: "compiler",
        message: diagnostic.summary,
        channel: "lsp",
        counted: true,
        filePath: primary.filePath,
        fileName: fileNameFromPath(primary.filePath),
        line: primary.line,
        column: primary.column,
      });
    }
    this.port.setCompilerRelatedDiagnostics(entries);
  }

  private async packageDependencyChain(
    root: TypstPackageReference,
    target: TypstPackageReference,
    packageCacheRoot: string,
  ): Promise<TypstPackageReference[] | null> {
    const targetSpec = target.spec.toLocaleLowerCase();
    const queue: TypstPackageReference[][] = [[root]];
    const visited = new Set<string>();
    while (queue.length > 0 && visited.size < 64) {
      const chain = queue.shift()!;
      const current = chain[chain.length - 1];
      const key = current.spec.toLocaleLowerCase();
      if (key === targetSpec) return chain;
      if (visited.has(key) || chain.length >= 5) continue;
      visited.add(key);

      const packageDirectory = `${packageCacheRoot}/${current.namespace}/${current.name}/${current.version}`;
      const manifest = await invoke<string>("read_workspace_file", {
        path: `${packageDirectory}/typst.toml`,
      }).catch(() => "");
      const entrypoint = typstPackageEntrypoint(manifest);
      if (!entrypoint) continue;
      const entrypointPath = `${packageDirectory}/${entrypoint}`;
      const packageSource = await invoke<string>("read_workspace_file", {
        path: entrypointPath,
      }).catch(() => "");
      for (const dependency of typstPackageImports(packageSource, entrypointPath)) {
        queue.push([...chain, dependency.package]);
      }
    }
    return null;
  }
}
