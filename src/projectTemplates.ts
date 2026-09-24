/** A template entry from the Typst Universe package index. */
export type UniverseTemplate = {
  name: string;
  version: string;
  description: string;
  authors: string[];
  categories: string[];
  keywords: string[];
  disciplines: string[];
  repository: string;
  compiler: string;
  updatedAt: number;
  templatePath: string;
  templateEntrypoint: string;
  thumbnailUrl: string;
};

/** A template that exists locally (downloaded Universe or user supplied). */
export type LocalTemplate = {
  id: string;
  name: string;
  version: string;
  description: string;
  authors: string[];
  categories: string[];
  source: "universe" | "user";
  archive: string;
  thumbnail: string | null;
};

export type CreatedProject = {
  workspacePath: string;
  mainFilePath: string;
  projectName: string;
};

/** The Universe template catalog plus its cache/network provenance. */
export type TemplateCatalog = {
  templates: UniverseTemplate[];
  cachedAt: number | null;
  fromCache: boolean;
  offline: boolean;
};

export function templateCatalogStatus(catalog: TemplateCatalog): string {
  if (catalog.offline) {
    const when = catalog.cachedAt
      ? ` (cached ${new Date(catalog.cachedAt * 1000).toLocaleDateString()})`
      : "";
    return `You are offline — showing cached templates${when}. Downloaded templates still work.`;
  }
  if (catalog.fromCache && catalog.templates.length === 0) {
    return "No Typst Universe templates are cached yet. Connect to the internet to load them.";
  }
  return "";
}

export type TemplateTab = "all" | "offline" | "user";

export const TEMPLATE_TABS: ReadonlyArray<{ id: TemplateTab; label: string }> = [
  { id: "all", label: "All templates" },
  { id: "offline", label: "Downloaded" },
  { id: "user", label: "User templates" },
];

export const UNIVERSE_TEMPLATES_URL = "https://typst.app/universe/search/?kind=templates";

type SearchableTemplate = {
  name: string;
  description?: string;
  authors?: readonly string[];
  categories?: readonly string[];
  keywords?: readonly string[];
};

function haystack(item: SearchableTemplate): string {
  return [
    item.name,
    item.description ?? "",
    ...(item.authors ?? []),
    ...(item.categories ?? []),
    ...(item.keywords ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

/** Case-insensitive search; name matches rank before other fields. */
export function filterTemplates<T extends SearchableTemplate>(
  items: readonly T[],
  query: string,
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return [...items];
  const terms = trimmed.split(/\s+/u);
  return items
    .filter(item => {
      const text = haystack(item);
      return terms.every(term => text.includes(term));
    })
    .sort((left, right) => {
      const leftName = left.name.toLowerCase().includes(trimmed) ? 0 : 1;
      const rightName = right.name.toLowerCase().includes(trimmed) ? 0 : 1;
      if (leftName !== rightName) return leftName - rightName;
      return left.name.localeCompare(right.name);
    });
}

export function templateSubtitle(item: SearchableTemplate & { version?: string }): string {
  const version = item.version ? `v${item.version}` : "";
  return [item.name, version].filter(Boolean).join(" ");
}

export function localTemplateKey(source: LocalTemplate["source"], id: string): string {
  return `${source}:${id}`;
}

export function findDownloadedTemplate(
  offline: readonly LocalTemplate[],
  name: string,
  version: string,
): LocalTemplate | null {
  return offline.find(template => template.name === name && template.version === version) ?? null;
}
