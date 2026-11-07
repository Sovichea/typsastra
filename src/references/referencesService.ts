import { normalizeEditorText } from "../editor/editorFileContentController";
import { isTypstDocumentPath } from "../platform/fileTypes";
import type { ProjectTextService } from "../workspace/projectTextService";
import {
  loadProjectBibliography,
  type BibliographyIndex,
} from "./bibliography";
import {
  scanTypstReferences,
  type BibliographyCall,
  type CitationSite,
} from "./typstReferences";

export type ProjectCitationSite = CitationSite & {
  path: string;
  relativePath: string;
};

export type ProjectBibliographyCall = BibliographyCall & {
  path: string;
  relativePath: string;
};

export type ReferencesProjectIndex = {
  bibliography: BibliographyIndex;
  citations: ProjectCitationSite[];
  bibliographyCalls: ProjectBibliographyCall[];
};

export interface ReferencesServiceDependencies {
  workspaceRootPath(): string | null;
  projectText(): ProjectTextService;
  loadBibliography?(workspaceRootPath: string): Promise<BibliographyIndex>;
}

/**
 * Builds the project-wide view used by the References sidebar. Bibliography
 * parsing stays in Rust; Typst citation sites come from the shared project text
 * service so open editor buffers win over disk contents.
 */
export class ReferencesService {
  constructor(private readonly deps: ReferencesServiceDependencies) {}

  public async load(): Promise<ReferencesProjectIndex> {
    const workspaceRootPath = this.deps.workspaceRootPath();
    if (!workspaceRootPath) {
      return {
        bibliography: {
          workspaceRootPath: "",
          files: [],
          entries: [],
          diagnostics: [],
        },
        citations: [],
        bibliographyCalls: [],
      };
    }

    const loadBibliography = this.deps.loadBibliography ?? loadProjectBibliography;
    const [bibliography, inventory] = await Promise.all([
      loadBibliography(workspaceRootPath),
      this.deps.projectText().inventory(),
    ]);
    const typstFiles = inventory.files.filter(file => isTypstDocumentPath(file.path));
    const result = await this.deps.projectText().readFiles(typstFiles, { concurrency: 4 });
    const citations: ProjectCitationSite[] = [];
    const bibliographyCalls: ProjectBibliographyCall[] = [];

    for (const snapshot of result.snapshots) {
      // Editor tabs normalize line endings before presenting text. Normalize
      // disk snapshots the same way so citation ranges and lines match the
      // ranges used by navigation.
      const scan = scanTypstReferences(normalizeEditorText(snapshot.text));
      for (const citation of scan.citations) {
        citations.push({
          ...citation,
          path: snapshot.file.path,
          relativePath: snapshot.file.relativePath,
        });
      }
      for (const call of scan.bibliographyCalls) {
        bibliographyCalls.push({
          ...call,
          path: snapshot.file.path,
          relativePath: snapshot.file.relativePath,
        });
      }
    }

    citations.sort(compareLocations);
    bibliographyCalls.sort(compareLocations);

    return { bibliography, citations, bibliographyCalls };
  }
}

function compareLocations(
  left: { relativePath: string; from: number },
  right: { relativePath: string; from: number },
): number {
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  return left.from - right.from;
}
