import { describe, expect, test } from "bun:test";
import { nextDocumentSidebarPane, spellcheckSidebarEntries } from "../src/diagnostics/spellcheckSidebarPane";
import { normalizeWorkspaceMetadata } from "../src/workspace/workspaceStateStore";

describe("spellcheck sidebar pane", () => {
  test("groups occurrences by exact word and sorts unknown words before ignored words", () => {
    const location = (offset: number) => ({
      filePath: "book.typ", fileName: "book.typ", line: 1, column: offset + 1,
      offset, toOffset: offset + 3,
    });
    const entries = spellcheckSidebarEntries([
      { issue: { sourceText: "សាលា", ignored: true, provider: "khmer-segmenter" },
        providers: new Set(["khmer-segmenter"]), locations: [location(12)] },
      { issue: { sourceText: "សាលា", ignored: false, provider: "khmer-segmenter" },
        providers: new Set(["khmer-segmenter"]), locations: [location(0), location(7)] },
    ]);
    expect(entries.map(entry => [entry.word, entry.ignored, entry.locations.length])).toEqual([
      ["សាលា", false, 2], ["សាលា", true, 1],
    ]);
    expect(entries[0].locations.map(occurrence => occurrence.offset)).toEqual([0, 7]);
    expect(entries[0].key).not.toBe(entries[1].key);
  });

  test("restores exactly one document pane per workspace and defaults older projects to Outline", () => {
    const normalized = (value: unknown) => normalizeWorkspaceMetadata({
      project: null, workspace: { layout: { activeDocumentPane: value } },
    }).workspace.layout.activeDocumentPane;
    expect(normalized("outline")).toBe("outline");
    expect(normalized("spellcheck")).toBe("spellcheck");
    expect(normalized("none")).toBe("none");
    expect(normalized(undefined)).toBe("outline");
    expect(normalized("invalid")).toBe("outline");
    expect(nextDocumentSidebarPane("outline", "spellcheck")).toBe("spellcheck");
    expect(nextDocumentSidebarPane("spellcheck", "outline")).toBe("outline");
    expect(nextDocumentSidebarPane("spellcheck", "spellcheck")).toBe("none");
    expect(nextDocumentSidebarPane("none", "outline")).toBe("outline");
  });
});
