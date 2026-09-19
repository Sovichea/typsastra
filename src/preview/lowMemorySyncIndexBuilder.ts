import { invoke } from "@tauri-apps/api/core";
import type { TinymistLspClient } from "../compiler/lsp";
import { filePathToUri } from "../platform/paths";
import type { LowMemorySyncAnchor, LowMemorySyncIndex } from "./lowMemorySyncIndex";

type Instrumentation = {
  rootPath: string;
  workspaceRootPath: string;
  files: string[];
  anchorCount: number;
};
type QueryLength = number | string;
type QueryEntry = {
  file?: number;
  line?: number;
  pos?: {
    // Tinymist serializes a `location` position as `page`, `x`, and `y`.
    // Dimensions are emitted as strings such as `"56.69pt"`.
    page?: number;
    page_no?: number;
    x?: QueryLength;
    y?: QueryLength;
  };
};

function pdfPoints(value: QueryLength | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))pt$/u.exec(value.trim());
  if (!match) return null;
  const points = Number.parseFloat(match[1]);
  return Number.isFinite(points) ? points : null;
}

/** Converts Tinymist's JSON `metadata` query output into PDF anchors. */
export function parseLowMemorySyncQuery(raw: string): LowMemorySyncAnchor[] {
  const values = JSON.parse(raw) as QueryEntry[];
  if (!Array.isArray(values)) return [];
  return values.flatMap(value => {
    const pos = value.pos;
    const pageNo = pos?.page ?? pos?.page_no;
    const x = pdfPoints(pos?.x);
    const y = pdfPoints(pos?.y);
    return Number.isInteger(value.file) && Number.isInteger(value.line)
      && Number.isInteger(pageNo) && pageNo! > 0 && x !== null && y !== null
      ? [{ fileId: value.file!, line: value.line!, pageNo: pageNo!, x, y }]
      : [];
  });
}

/** Builds the index through an isolated Tinymist session rooted in the staged render tree. */
export async function buildLowMemorySyncIndex(options: {
  createClient(workspaceRootPath: string): TinymistLspClient;
  workspaceRootPath: string;
  preparedRootPath: string;
  generationId: string;
  pdfHash: string;
}): Promise<LowMemorySyncIndex> {
  const staging = await invoke<Instrumentation>("prepare_low_memory_sync_instrumentation", {
    workspaceRootPath: options.workspaceRootPath,
    inputPath: options.preparedRootPath,
    generationId: options.generationId,
  });
  const client = options.createClient(staging.workspaceRootPath);
  try {
    await client.connect();
    await client.openTextDocument(filePathToUri(staging.rootPath), await invoke<string>("read_workspace_file", { path: staging.rootPath }), 1);
    const queryPath = await client.exportQueryToFile(staging.rootPath, {
      // `tinymist.exportQuery` receives ExportQueryOpts directly. The dotted
      // `query.*` keys belong to task configuration, and are ignored by the
      // LSP command, leaving its required selector empty.
      format: "json",
      // Query the metadata function directly. A label placed after a
      // contextual expression is not a queryable metadata selector on all
      // Tinymist/Typst versions, while `metadata` is.
      selector: "metadata",
      field: "value",
      pretty: false,
    });
    const raw = await invoke<string>("read_workspace_file", { path: queryPath });
    const anchors = parseLowMemorySyncQuery(raw);
    return { version: 1, rootFile: options.preparedRootPath, generationId: options.generationId, pdfHash: options.pdfHash, files: staging.files, anchors };
  } finally {
    await client.stop().catch(() => undefined);
    client.dispose();
  }
}
