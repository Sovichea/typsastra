import { describe, expect, test } from "bun:test";
import { SourceLocationController } from "../src/navigation/sourceLocationController";

describe("source location cache mapping", () => {
  test("recognizes Rust-escaped mirror paths in Unicode workspaces", () => {
    const khmer = String.fromCodePoint(0x1781, 0x17d2, 0x1798, 0x17c2, 0x179a);
    const workspaceRoot = `C:\\Projects\\${khmer} DJI Matrice 4T`;
    const controller = new SourceLocationController({
      workspaceRootPath: () => workspaceRoot,
      activeFilePath: () => null,
      editor: () => { throw new Error("unused"); },
      lspClient: () => undefined,
      loadFile: async () => {},
      activeTabContentLoaded: () => false,
      generatedPreviewText: async () => "",
    });
    const escapedCachePath = String.raw`C:\Projects\\u{1781}\u{17d2}\u{1798}\u{17c2}\u{179a} DJI Matrice 4T\.typsastra\cache\render\03_sources\lib.typ`;

    expect(controller.isRenderCachePath(escapedCachePath)).toBe(true);
    expect(controller.mapToOriginalPath(escapedCachePath)).toBe(
      `${workspaceRoot}/03_sources/lib.typ`,
    );
  });

  test("maps Windows extended-length cache paths back to the workspace", () => {
    const workspaceRoot = "C:\\Users\\Sovichea\\Documents\\Typsastra Stress Test";
    const controller = new SourceLocationController({
      workspaceRootPath: () => workspaceRoot,
      activeFilePath: () => null,
      editor: () => { throw new Error("unused"); },
      lspClient: () => undefined,
      loadFile: async () => {},
      activeTabContentLoaded: () => false,
      generatedPreviewText: async () => "",
    });
    const extendedCachePath = String.raw`\\?\C:\Users\Sovichea\Documents\Typsastra Stress Test\.typsastra\cache\render\long_documents\typsastra_sync_stress_1500_pages.typ`;

    expect(controller.isRenderCachePath(extendedCachePath)).toBe(true);
    expect(controller.mapToOriginalPath(extendedCachePath)).toBe(
      `${workspaceRoot}/long_documents/typsastra_sync_stress_1500_pages.typ`,
    );
  });
});
