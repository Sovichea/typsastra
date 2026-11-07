import { describe, expect, test } from "bun:test";
import { citationSnippet } from "../src/references/citationInsertion";
import {
  bibliographyBlockText,
  bibliographyInsertion,
  bibliographySourcesRelativeTo,
} from "../src/references/bibliographyBlock";
import { typstSourceContextAt } from "../src/editor/typstLanguage";
import { ReferencesService } from "../src/references/referencesService";
import { scanTypstReferences } from "../src/references/typstReferences";
import type { ProjectTextService } from "../src/workspace/projectTextService";

describe("Typst reference scanning", () => {
  test("collects markup citations and cite calls while ignoring comments and strings", () => {
    const source = [
      "= Intro <intro>",
      "Cited @typst2024 and #cite(<research2025>).",
      "// @ignored",
      '#let quoted = "@quoted"',
      "#let value = cite(<codekey>)",
    ].join("\n");
    const scan = scanTypstReferences(source);

    expect(scan.citations.map(citation => citation.key)).toEqual([
      "typst2024",
      "research2025",
      "codekey",
    ]);
    expect(scan.citations.map(citation => citation.line)).toEqual([2, 2, 5]);
  });

  test("finds single and multiple bibliography sources with a style", () => {
    const single = scanTypstReferences('#bibliography("refs.bib", style: "apa")');
    expect(single.bibliographyCalls).toHaveLength(1);
    expect(single.bibliographyCalls[0].sources).toEqual(["refs.bib"]);
    expect(single.bibliographyCalls[0].style).toBe("apa");

    const multiple = scanTypstReferences(
      '#bibliography(("refs.bib", "chapters/more.bib"), style: "ieee")',
    );
    expect(multiple.bibliographyCalls[0].sources).toEqual(["refs.bib", "chapters/more.bib"]);
    expect(multiple.bibliographyCalls[0].style).toBe("ieee");
  });
});

describe("project references service", () => {
  test("aggregates bibliography calls and citations across Typst files", async () => {
    const sources = [
      {
        path: "C:/project/main.typ",
        relativePath: "main.typ",
        text: '#bibliography("refs.bib", style: "apa")\r\n',
      },
      {
        path: "C:/project/chapter.typ",
        relativePath: "chapter.typ",
        text: "Text @one and #cite(<two>).\r\n",
      },
    ];
    const projectText = {
      inventory: async () => ({
        workspaceRootPath: "C:/project",
        includeIgnored: false,
        files: sources.map(source => ({
          path: source.path,
          relativePath: source.relativePath,
          identity: source.path,
          sizeBytes: source.text.length,
          modifiedMs: 0,
        })),
        skipped: [],
        binaryFileCount: 0,
        tooLargeFileCount: 0,
        unreadableFileCount: 0,
      }),
      readFiles: async () => ({
        outcomes: [],
        snapshots: sources.map(source => ({
          file: {
            path: source.path,
            relativePath: source.relativePath,
            identity: source.path,
            sizeBytes: source.text.length,
            modifiedMs: 0,
          },
          text: source.text,
          revision: "test",
          source: "disk" as const,
          dirty: false,
          version: null,
          hasBom: false,
          lineEnding: "crlf" as const,
        })),
        skipped: [],
      }),
    } as unknown as ProjectTextService;

    const service = new ReferencesService({
      workspaceRootPath: () => "C:/project",
      projectText: () => projectText,
      loadBibliography: async workspaceRootPath => ({
        workspaceRootPath,
        files: [{ path: "C:/project/refs.bib", relativePath: "refs.bib", entryCount: 0 }],
        entries: [],
        diagnostics: [],
      }),
    });

    const index = await service.load();
    expect(index.citations.map(citation => citation.key)).toEqual(["one", "two"]);
    expect(index.bibliographyCalls).toHaveLength(1);
    expect(index.bibliographyCalls[0].style).toBe("apa");
    expect(index.bibliographyCalls[0].sources).toEqual(["refs.bib"]);
  });
});

describe("Typst insertion context", () => {
  test("distinguishes markup, math, and code positions", () => {
    const source = "Text #emph[inner] @key";
    expect(typstSourceContextAt(source, source.indexOf("inner")).mode).toBe("markup");
    expect(typstSourceContextAt(source, source.indexOf("@key")).mode).toBe("markup");
    expect(typstSourceContextAt("$ x + y $", 2).mode).toBe("math");
    expect(typstSourceContextAt("#let x = 1", 8).mode).toBe("code");
  });

  test("uses valid citation syntax for each mode", () => {
    expect(citationSnippet("typst2024", { mode: "markup", token: null, insideToken: null })).toBe("@typst2024");
    expect(citationSnippet("typst2024", { mode: "math", token: null, insideToken: null })).toBe("#cite(<typst2024>)");
    expect(citationSnippet("typst2024", { mode: "code", token: null, insideToken: null })).toBe("cite(<typst2024>)");
    expect(citationSnippet("weird.key", { mode: "markup", token: null, insideToken: null }))
      .toBe('#cite(label("weird.key"))');
  });
});

describe("bibliography block insertion", () => {
  test("builds single and multiple source blocks", () => {
    expect(bibliographyBlockText("apa", ["refs.bib"]))
      .toBe('#bibliography("refs.bib", style: "apa")');
    expect(bibliographyBlockText("ieee", ["refs.bib", "more.bib"]))
      .toBe('#bibliography(("refs.bib", "more.bib"), style: "ieee")');
  });

  test("appends the block with stable offsets", () => {
    const insertion = bibliographyInsertion("= Project\n\nBody", "apa", ["refs.bib"]);
    expect(insertion.from).toBe("= Project\n\nBody".length);
    expect(insertion.text).toBe('\n\n#bibliography("refs.bib", style: "apa")\n');
    expect(insertion.blockFrom).toBe(insertion.from + 2);
    expect(insertion.blockTo).toBe(insertion.blockFrom + '#bibliography("refs.bib", style: "apa")'.length);
  });

  test("resolves bibliography paths relative to the main document", () => {
    const workspace = "C:/project";
    expect(bibliographySourcesRelativeTo(
      workspace,
      `${workspace}/chapters/main.typ`,
      [`${workspace}/refs.bib`],
    )).toEqual(["../refs.bib"]);
    expect(bibliographySourcesRelativeTo(
      workspace,
      `${workspace}/main.typ`,
      [`${workspace}/refs.bib`, `${workspace}/chapters/more.bib`],
    )).toEqual(["refs.bib", "chapters/more.bib"]);
  });
});
