import { describe, expect, test } from "bun:test";
import { SourceLocationController } from "../src/navigation/sourceLocationController";
import { filePathKey } from "../src/platform/paths";

function navigationController(options: {
  loadFile: (path: string) => Promise<void>;
  resolveOpenTabPath?: (path: string) => string | null;
  activeFilePath?: string | null;
}) {
  return new SourceLocationController({
    workspaceRootPath: () => "C:\\Projects\\Demo",
    cacheRootPath: () => "C:\\cache",
    activeFilePath: () => options.activeFilePath ?? null,
    editor: () => {
      throw new Error("editor should not be touched");
    },
    lspClient: () => undefined,
    loadFile: options.loadFile,
    activeTabContentLoaded: () => false,
    generatedPreviewText: async () => "",
    resolveOpenTabPath: options.resolveOpenTabPath,
  });
}

describe("LSP URI navigation path identity", () => {
  test("prefers an open tab's native path for a Ctrl+click URI", async () => {
    const nativePath = "C:\\Projects\\Demo\\chapters\\one.typ";
    const loaded: string[] = [];
    const controller = navigationController({
      loadFile: async path => {
        loaded.push(path);
      },
      resolveOpenTabPath: path =>
        filePathKey(path) === filePathKey(nativePath) ? nativePath : null,
    });

    await controller.navigateToLspLocation(
      "file:///C:/Projects/Demo/chapters/one.typ",
      0,
      0,
    );

    expect(loaded).toEqual([nativePath]);
  });

  test("normalizes a URI-derived path when the file has no open tab", async () => {
    const loaded: string[] = [];
    const controller = navigationController({
      loadFile: async path => {
        loaded.push(path);
      },
    });

    await controller.navigateToLspLocation(
      "file:///C:/Projects/Demo/chapters/one.typ",
      0,
      0,
    );

    expect(loaded).toEqual(["C:\\Projects\\Demo\\chapters\\one.typ"]);
  });

  test("skips loading when the resolved path is already active", async () => {
    const loaded: string[] = [];
    const controller = navigationController({
      loadFile: async path => {
        loaded.push(path);
      },
      activeFilePath: "c:/projects/demo/chapters/one.typ",
    });

    await controller.navigateToLspLocation(
      "file:///C:/Projects/Demo/chapters/one.typ",
      0,
      0,
    );

    expect(loaded).toEqual([]);
  });
});

describe("source location cache mapping", () => {
  test("recognizes Rust-escaped mirror paths in Unicode workspaces", () => {
    const khmer = String.fromCodePoint(0x1781, 0x17d2, 0x1798, 0x17c2, 0x179a);
    const workspaceRoot = `C:\\Projects\\${khmer} DJI Matrice 4T`;
    const cacheRoot = "C:\\Users\\Tester\\AppData\\Local\\com.typsastra.editor\\workspace-cache\\0123456789abcdef";
    const controller = new SourceLocationController({
      workspaceRootPath: () => workspaceRoot,
      cacheRootPath: () => cacheRoot,
      activeFilePath: () => null,
      editor: () => { throw new Error("unused"); },
      lspClient: () => undefined,
      loadFile: async () => {},
      activeTabContentLoaded: () => false,
      generatedPreviewText: async () => "",
    });
    const escapedCachePath = `${cacheRoot}\\render\\03_sources\\lib.typ`;

    expect(controller.isRenderCachePath(escapedCachePath)).toBe(true);
    expect(controller.mapToOriginalPath(escapedCachePath)).toBe(
      `${workspaceRoot}/03_sources/lib.typ`,
    );
  });

  test("maps Windows extended-length cache paths back to the workspace", () => {
    const workspaceRoot = "C:\\Users\\Sovichea\\Documents\\Typsastra Stress Test";
    const cacheRoot = "C:\\Users\\Sovichea\\AppData\\Local\\com.typsastra.editor\\workspace-cache\\0123456789abcdef";
    const controller = new SourceLocationController({
      workspaceRootPath: () => workspaceRoot,
      cacheRootPath: () => cacheRoot,
      activeFilePath: () => null,
      editor: () => { throw new Error("unused"); },
      lspClient: () => undefined,
      loadFile: async () => {},
      activeTabContentLoaded: () => false,
      generatedPreviewText: async () => "",
    });
    const extendedCachePath = String.raw`\\?\C:\Users\Sovichea\AppData\Local\com.typsastra.editor\workspace-cache\0123456789abcdef\render\long_documents\typsastra_sync_stress_1500_pages.typ`;

    expect(controller.isRenderCachePath(extendedCachePath)).toBe(true);
    expect(controller.mapToOriginalPath(extendedCachePath)).toBe(
      `${workspaceRoot}/long_documents/typsastra_sync_stress_1500_pages.typ`,
    );
  });
});
