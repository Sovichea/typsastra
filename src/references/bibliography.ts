import { invoke } from "@tauri-apps/api/core";

export type BibliographyEntry = {
  key: string;
  entryType: string;
  fields: Record<string, string>;
  title: string;
  authors: string[];
  year: string | null;
  path: string;
  relativePath: string;
  fromUtf16: number;
  toUtf16: number;
  raw: string;
};

export type BibliographyFile = {
  path: string;
  relativePath: string;
  entryCount: number;
};

export type BibliographyDiagnostic = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path: string;
  relativePath: string;
  fromUtf16: number;
  toUtf16: number;
};

export type BibliographyIndex = {
  workspaceRootPath: string;
  files: BibliographyFile[];
  entries: BibliographyEntry[];
  diagnostics: BibliographyDiagnostic[];
};

export function loadProjectBibliography(
  workspaceRootPath: string,
): Promise<BibliographyIndex> {
  return invoke<BibliographyIndex>("get_project_bibliography", { workspaceRootPath });
}
