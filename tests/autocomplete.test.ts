import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import {
  applyTextForHashPrefix,
  allowsLanguageWordCompletionOnLine,
  completionEditOffsets,
  completedEmptyCallCaret,
  contextualCompletionEditOffsets,
  deduplicateTypstCompletionVariants,
  displayLabelForHashPrefix,
  effectiveTypstCompletionSyntax,
  fontCompletionValueStart,
  isEmptyTypstFunctionCallAt,
  innermostTypstFunctionName,
  innermostTypstArgumentFieldName,
  isDirectMemberCompletion,
  isInsideTypstFunctionArgumentsAt,
  isNamedArgumentCompletion,
  isStaticTypstCompletionContextAt,
  isTypstMemberAccessAt,
  isTypstFunctionArgumentContextAt,
  isTypstRuleTargetAt,
  languageCompletionRange,
  liveTypstCompletionEditOffsets,
  liveTypstMemberCompletionEditOffsets,
  lspCompletionEditOffsets,
  normalizeCallableCompletionSnippet,
  preferContextualArgumentCompletions,
  preferContextualArgumentValueCompletions,
  isTypstFunctionArgumentValueContextAt,
  quotedTypstArgumentValueStart,
  quotedCompletionEditOffsets,
  readTypstCompletionPreferences,
  recordTypstCompletionPreference,
  typstArgumentDefaultSnippet,
  typstCompletionPreferenceBoost,
  typstCompletionRequestPosition,
  typstCompletionSyntax,
  typstCompletionVariantsByFamily,
  typstArgumentCompletionValidFor,
  typstMemberCompletionValidFor,
  typstCompletionValidFor
} from "../src/editor/autocomplete";
import {
  staticTypstFieldCompletions,
  staticTypstGlobalCompletions,
  staticTypstMemberCompletions,
  staticTypstValueCompletions,
} from "../src/editor/typstCompletionCatalog";

describe("language word completion context", () => {
  test("sends the personal dictionary to language completion", async () => {
    const source = await Bun.file(new URL("../src/editor/autocomplete.ts", import.meta.url)).text();
    expect(source).toContain("userDictionary: [...getUserDictionary()]");
  });

  test("mounts editor tooltips above preview overlays", async () => {
    const source = await Bun.file(new URL("../src/editor/extensions.ts", import.meta.url)).text();
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();

    expect(source).toContain("tooltips({ parent: document.body })");
    expect(css).toContain(".cm-tooltip {");
    expect(css).toContain("z-index: 12000 !important");
  });

  test("allows prose and content-block text", () => {
    expect(allowsLanguageWordCompletionOnLine("This paragraph has sch", 19)).toBe(true);
    expect(allowsLanguageWordCompletionOnLine('#figure(image("photo.png"))[The capt', 33)).toBe(true);
  });

  test("blocks Typst syntax and code strings", () => {
    expect(allowsLanguageWordCompletionOnLine('#include "stories/rabbit', 19)).toBe(false);
    expect(allowsLanguageWordCompletionOnLine('#import "templates/chapt', 19)).toBe(false);
    expect(allowsLanguageWordCompletionOnLine('#set text(font: "Fira', 18)).toBe(false);
    expect(allowsLanguageWordCompletionOnLine("#set p", 5)).toBe(false);
    expect(allowsLanguageWordCompletionOnLine("#show h", 6)).toBe(false);
    expect(allowsLanguageWordCompletionOnLine("#let previewRoot = tr", 5)).toBe(false);
  });

  test("blocks language completion in multiline function arguments", () => {
    const argument = Text.of(["#figure(", "  ga", ")"]);
    expect(isInsideTypstFunctionArgumentsAt(argument, argument.line(2).to)).toBe(true);

    const prose = Text.of(["A regular paragraph with ga"]);
    expect(isInsideTypstFunctionArgumentsAt(prose, prose.length)).toBe(false);

    const tuple = Text.of(["#let values = (", "  ga", ")"]);
    expect(isInsideTypstFunctionArgumentsAt(tuple, tuple.line(2).to)).toBe(false);
  });

  test("continues to Typst LSP completion when syntax rejects a language word", async () => {
    const source = await Bun.file(new URL("../src/editor/autocomplete.ts", import.meta.url)).text();
    expect(source).not.toContain(
      "if (!allowsLanguageWordCompletionOnLine(line.text, match.word.from - line.from)) return null;"
    );
    expect(source).toContain(
      "if (allowsLanguageWordCompletionOnLine(line.text, match.word.from - line.from)) {"
    );
  });
});

describe("LSP autocomplete edits", () => {
  test("provides a runtime-free Typst syntax catalog", () => {
    const globals = staticTypstGlobalCompletions();
    expect(globals.find(item => item.label === "figure")?.insertText).toBe("figure(${1:})");
    expect(globals.find(item => item.label === "figure.bracket")?.insertText).toBe("figure[${1:}]");
    expect(globals.some(item => item.label === "set")).toBe(true);
    expect(globals.length).toBeGreaterThan(200);
    for (const functionName of [
      "pagebreak",
      "colbreak",
      "linebreak",
      "bibliography",
      "cite",
      "footnote",
      "query",
      "counter",
      "state",
      "read",
      "json",
      "csv",
      "yaml",
      "toml",
      "xml",
      "cbor",
      "eval",
      "plugin",
    ]) {
      expect(globals.some(item => item.label === functionName)).toBe(true);
    }
    expect(globals.find(item => item.label === "pagebreak")?.insertText).toBe("pagebreak(${1:})");

    const imageFields = staticTypstFieldCompletions("image");
    expect(imageFields.find(item => item.label === "fit")?.insertText).toBe("fit: ");
    expect(imageFields.every(item => isNamedArgumentCompletion(item))).toBe(true);
    expect(staticTypstFieldCompletions("page").some(item => item.label === "margin")).toBe(true);
    expect(staticTypstFieldCompletions("pagebreak").map(item => item.label)).toEqual(["to", "weak"]);

    expect(staticTypstValueCompletions("fit").map(item => item.insertText)).toEqual([
      '"contain"',
      '"cover"',
      '"stretch"',
    ]);
    expect(staticTypstValueCompletions("justify").map(item => item.insertText)).toEqual([
      "true",
      "false",
    ]);
    expect(staticTypstMemberCompletions().some(item => item.label === "len")).toBe(true);
  });

  test("limits the static catalog to Typst code contexts", () => {
    const prose = Text.of(["A regular paragraph"]);
    expect(isStaticTypstCompletionContextAt(prose, prose.length)).toBe(false);

    const hashExpression = Text.of(["#fig"]);
    expect(isStaticTypstCompletionContextAt(hashExpression, hashExpression.length)).toBe(true);

    const argument = Text.of(["#image(fit: )"]);
    expect(isStaticTypstCompletionContextAt(argument, argument.length - 1)).toBe(true);

    const statement = Text.of(["#let preview = "]);
    expect(isStaticTypstCompletionContextAt(statement, statement.length)).toBe(true);

    const content = Text.of(["#emph[ordinary prose]"]);
    expect(isStaticTypstCompletionContextAt(content, content.length - 1)).toBe(false);
  });

  test("identifies the active named argument for static value completion", () => {
    const fit = Text.of(['#image(fit: "co")']);
    expect(innermostTypstArgumentFieldName(fit, fit.length - 2)).toBe("fit");

    const multiline = Text.of(["#set text(", '  lang: "k"', ")"]);
    expect(innermostTypstArgumentFieldName(multiline, multiline.line(2).to - 1)).toBe("lang");

    const unnamed = Text.of(['#image("asset.png")']);
    expect(innermostTypstArgumentFieldName(unnamed, unnamed.length - 2)).toBeNull();
  });

  test("adds editable defaults to named fields across Typst functions", () => {
    const direct = Text.of(["#par(", "  ", ")[Text]"]);
    const setRule = Text.of(["#set par(", "  ", ")"]);

    expect(innermostTypstFunctionName(direct, direct.line(2).to)).toBe("par");
    expect(innermostTypstFunctionName(setRule, setRule.line(2).to)).toBe("par");
    expect(typstArgumentDefaultSnippet("par", "leading")).toBe("leading: ${0.65em}");
    expect(typstArgumentDefaultSnippet("par", "justification-limits")).toBe(
      [
        "justification-limits: (",
        "  spacing: (min: ${85%}, max: ${115%}),",
        "  tracking: (min: ${-0.8pt}, max: ${0pt}),",
        ")"
      ].join("\n")
    );
    expect(typstArgumentDefaultSnippet("figure", "fit", "str")).toBe(
      'fit: "${contain}"'
    );
    expect(typstArgumentDefaultSnippet("grid", "columns", "array")).toBe(
      "columns: (${1fr},)"
    );
    expect(typstArgumentDefaultSnippet("custom", "entries", "array")).toBe(
      "entries: (${item},)"
    );
    expect(typstArgumentDefaultSnippet("custom", "metadata", "dictionary")).toBe(
      "metadata: (${key}: ${value})"
    );
    expect(typstArgumentDefaultSnippet("custom", "unknown")).toBe(
      "unknown: ${value}"
    );
  });

  test("presents Tinymist syntax variants as Typst source forms", () => {
    expect(typstCompletionSyntax("figure")).toEqual({
      family: "figure",
      variant: "bare",
      displayLabel: "figure"
    });
    expect(typstCompletionSyntax("figure.paren").displayLabel).toBe("figure()");
    expect(typstCompletionSyntax("#figure.bracket").displayLabel).toBe("#figure[]");
    expect(typstCompletionSyntax("figure()").variant).toBe("paren");
    expect(typstCompletionSyntax("figure[]").variant).toBe("bracket");
  });

  test("deduplicates equivalent Tinymist syntax aliases", () => {
    const items = deduplicateTypstCompletionVariants([
      { label: "figure", kind: 3 },
      { label: "#figure", kind: 3 },
      { label: "figure()" },
      { label: "figure.paren", insertText: "figure(${1:})" },
      { label: "figure[]" },
      { label: "figure.bracket", insertText: "figure[${1:}]" }
    ]);

    expect(items.map(item => item.label)).toEqual([
      "figure",
      "figure.bracket"
    ]);
  });

  test("merges a callable primary entry with its parenthesized alias", () => {
    const figureVariants = typstCompletionVariantsByFamily([
      "figure",
      "figure.paren",
      "figure.bracket"
    ]);
    expect(effectiveTypstCompletionSyntax(
      { label: "figure", kind: 3 },
      figureVariants
    )).toEqual({
      family: "figure",
      variant: "bare",
      displayLabel: "figure"
    });

    const emph = deduplicateTypstCompletionVariants([
      { label: "emph", kind: 3 },
      { label: "emph.bracket", kind: 3 }
    ]);
    const emphVariants = typstCompletionVariantsByFamily([
      "emph",
      "emph.bracket"
    ]);
    expect(emph.map(item => effectiveTypstCompletionSyntax(item, emphVariants).displayLabel))
      .toEqual(["emph", "emph[]"]);
  });

  test("learns global usage for a callable with only a bare visible form", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }
    };
    const variants = typstCompletionVariantsByFamily(["figure", "image"]);

    recordTypstCompletionPreference("figure", storage);
    recordTypstCompletionPreference("image", storage);
    recordTypstCompletionPreference("image", storage);
    const preferences = readTypstCompletionPreferences(storage);

    expect(typstCompletionPreferenceBoost("image", variants, preferences)).toBe(99);
    expect(typstCompletionPreferenceBoost("figure", variants, preferences)).toBeLessThan(99);
  });

  test("learns syntax-form preference globally with recent choices weighted higher", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }
    };
    const variants = typstCompletionVariantsByFamily([
      "figure",
      "figure.paren",
      "figure.bracket"
    ]);

    recordTypstCompletionPreference("figure.paren", storage);
    recordTypstCompletionPreference("figure.paren", storage);
    recordTypstCompletionPreference("figure.bracket", storage);
    const preferences = readTypstCompletionPreferences(storage);

    expect(typstCompletionPreferenceBoost("figure.paren", variants, preferences)).toBe(99);
    expect(typstCompletionPreferenceBoost("figure.bracket", variants, preferences)).toBeGreaterThan(0);
    expect(typstCompletionPreferenceBoost("figure", variants, preferences)).toBeUndefined();
    expect(typstCompletionPreferenceBoost("table.paren", variants, preferences)).toBeUndefined();

    recordTypstCompletionPreference("figure.bracket", storage);
    recordTypstCompletionPreference("figure.bracket", storage);
    const changedPreferences = readTypstCompletionPreferences(storage);
    expect(typstCompletionPreferenceBoost("figure.bracket", variants, changedPreferences)).toBe(99);
    expect(typstCompletionPreferenceBoost("figure.paren", variants, changedPreferences)).toBeLessThan(99);
  });

  test("keeps hash-triggered completion active while typing an identifier", () => {
    expect(typstCompletionValidFor.test("#")).toBe(true);
    expect(typstCompletionValidFor.test("#i")).toBe(true);
    expect(typstCompletionValidFor.test("#image")).toBe(true);
    expect(typstCompletionValidFor.test("#my-function")).toBe(true);
    expect(typstCompletionValidFor.test("#module")).toBe(true);
    expect(typstCompletionValidFor.test("#module.member")).toBe(false);
    expect(typstCompletionValidFor.test("#រូបភាព")).toBe(true);
    expect(typstCompletionValidFor.test("#image(")).toBe(false);
    expect(typstCompletionValidFor.test("#image ")).toBe(false);
  });

  test("attaches the Typst validity range to LSP and fallback results", async () => {
    const source = await Bun.file(new URL("../src/editor/autocomplete.ts", import.meta.url)).text();
    expect(source).toContain("validFor: typstCompletionValidFor");
    expect(source).toContain(": typstCompletionValidFor");
  });

  test("restarts an explicitly dismissed completion at the same token", async () => {
    const source = await Bun.file(new URL("../src/editor/extensions.ts", import.meta.url)).text();
    expect(source).toContain('event.ctrlKey && !event.altKey && !event.metaKey && event.code === "Space"');
    expect(source).toContain("view.dispatch({ selection: view.state.selection })");
    expect(source).toContain("queueMicrotask(() => startCompletion(view))");
  });

  test("keeps only Tinymist's contextual function arguments after a global fallback", () => {
    const items = [
      { label: "align", kind: 3, sortText: "008", insertText: "align" },
      { label: "array", kind: 9, sortText: "013", insertText: "array" },
      {
        label: "alt",
        kind: 5,
        sortText: "000",
        insertTextFormat: 2,
        textEdit: { newText: "alt: ${1:}", range: undefined }
      },
      {
        label: "fit",
        kind: 5,
        sortText: "001",
        insertTextFormat: 2,
        textEdit: { newText: "fit: ${1:}", range: undefined }
      },
      {
        label: "width",
        kind: 5,
        sortText: "007",
        insertTextFormat: 2,
        textEdit: { newText: "width: ${1:}", range: undefined }
      }
    ];

    expect(preferContextualArgumentCompletions(items).map(item => item.label))
      .toEqual(["alt", "fit", "width"]);
  });

  test("keeps only Tinymist's contextual argument values after a global fallback", () => {
    const items = [
      { label: "figure", kind: 3, sortText: "008", insertText: "figure" },
      { label: "none", kind: 6, sortText: "013", insertText: "none" },
      { label: '"contain"', kind: 12, sortText: "000", insertText: '"contain"' },
      { label: '"cover"', kind: 12, sortText: "001", insertText: '"cover"' },
      { label: '"stretch"', kind: 12, sortText: "002", insertText: '"stretch"' }
    ];

    expect(preferContextualArgumentValueCompletions(items).map(item => item.label))
      .toEqual(['"contain"', '"cover"', '"stretch"']);
    expect(preferContextualArgumentValueCompletions(items.slice(0, 2))).toEqual([]);
  });

  test("does not treat colon-bearing global snippets as function arguments", () => {
    const items = [
      {
        label: "show rule (everything)",
        kind: 15,
        textEdit: { newText: "show: ${1:}", range: undefined }
      },
      {
        label: "fill",
        kind: 5,
        textEdit: { newText: "fill: ${1:}", range: undefined }
      },
      {
        label: "width",
        kind: 10,
        textEdit: { newText: "width: ${1:}", range: undefined }
      }
    ];

    expect(preferContextualArgumentCompletions(items)).toEqual(items);
    const source = items.filter(isNamedArgumentCompletion);
    expect(source.map(item => item.label)).toEqual(["fill", "width"]);
  });

  test("does not suppress a normal completion list on an unrelated sort restart", () => {
    const items = [
      { label: "alpha", kind: 3, sortText: "100" },
      { label: "beta", kind: 3, sortText: "000" }
    ];

    expect(preferContextualArgumentCompletions(items)).toEqual(items);
  });

  test("preserves Tinymist ranking metadata on snippet completions", async () => {
    const source = await Bun.file(new URL("../src/editor/autocomplete.ts", import.meta.url)).text();
    expect(source).toMatch(
      /snippetCompletion\(callableSnippet\.template,\s*\{[\s\S]*?sortText:\s*item\.sortText[\s\S]*?\}\)/
    );
  });

  test("keeps a font completion range active across spaces", () => {
    const doc = Text.of(['#set text(font: "Khmer OS")']);
    expect(fontCompletionValueStart(doc, 22)).toBe(17);
    expect(fontCompletionValueStart(doc, 25)).toBe(17);
  });

  test("replaces the full quoted font value for a multi-word completion", () => {
    const doc = Text.of(['#set text(font: "Khmer")']);
    const offsets = lspCompletionEditOffsets(
      doc,
      {
        newText: '"Khmer OS Siemreap"',
        range: {
          start: { line: 0, character: 16 },
          end: { line: 0, character: 23 }
        }
      },
      (_text, character) => character
    );

    expect(offsets).toEqual({ from: 16, to: 23 });
    const completed = doc.sliceString(0, offsets!.from)
      + '"Khmer OS Siemreap"'
      + doc.sliceString(offsets!.to);
    expect(completed)
      .toBe('#set text(font: "Khmer OS Siemreap")');
  });

  test("uses the replace range from an LSP insert-replace edit", () => {
    const doc = Text.of(['#set text(font: "Khmer")']);
    const offsets = lspCompletionEditOffsets(
      doc,
      {
        newText: '"Khmer OS"',
        insert: {
          start: { line: 0, character: 17 },
          end: { line: 0, character: 22 }
        },
        replace: {
          start: { line: 0, character: 16 },
          end: { line: 0, character: 23 }
        }
      },
      (_text, character) => character
    );

    expect(offsets).toEqual({ from: 16, to: 23 });
  });

  test("replaces an existing quoted value when the server omits an edit range", () => {
    const closed = Text.of(['#set text(font: "Khmer OS")']);
    expect(quotedCompletionEditOffsets(closed, 25, '"Khmer OS Siemreap"'))
      .toEqual({ from: 16, to: 26 });

    const unfinished = Text.of(['#set text(font: "Khmer OS']);
    expect(quotedCompletionEditOffsets(unfinished, unfinished.length, '"Khmer OS Siemreap"'))
      .toEqual({ from: 16, to: unfinished.length });
  });

  test("preserves the opening quote when Tinymist only supplies a closing quote", () => {
    const doc = Text.of(['#set text(font: "Khmer OS")']);
    const beforeClosingQuote = quotedCompletionEditOffsets(doc, 25, 'Khmer OS Bokor"');
    const afterClosingQuote = quotedCompletionEditOffsets(doc, 26, 'Khmer OS Bokor"');

    expect(beforeClosingQuote).toEqual({ from: 17, to: 26 });
    expect(afterClosingQuote).toEqual({ from: 17, to: 26 });
    const completed = doc.sliceString(0, beforeClosingQuote!.from)
      + 'Khmer OS Bokor"'
      + doc.sliceString(beforeClosingQuote!.to);
    expect(completed).toBe('#set text(font: "Khmer OS Bokor")');
  });

  test("replaces the full font value even when Tinymist targets only the current token", () => {
    const doc = Text.of(['#set text(font: "Khmer OS")']);
    const edit = completionEditOffsets(
      doc,
      25,
      'Khmer OS Bokor"',
      {
        newText: 'Khmer OS Bokor"',
        range: {
          start: { line: 0, character: 23 },
          end: { line: 0, character: 25 }
        }
      },
      (_text, character) => character
    );

    expect(edit).toEqual({ from: 17, to: 26 });
    const completed = doc.sliceString(0, edit!.from)
      + 'Khmer OS Bokor"'
      + doc.sliceString(edit!.to);
    expect(completed).toBe('#set text(font: "Khmer OS Bokor")');
  });

  test("does not prepend an extra hash when Tinymist supplies the edit range", () => {
    expect(displayLabelForHashPrefix("set", "keyword", true)).toBe("#set");
    expect(applyTextForHashPrefix("set", "keyword", true, false)).toBe("#set");
    expect(applyTextForHashPrefix("set", "keyword", true, true)).toBe("set");
  });

  test("replaces existing quotes for a quoted snippet value", () => {
    const inside = Text.of(['#set text(lang: "")']);
    expect(quotedCompletionEditOffsets(inside, inside.length - 2, '${1:"km"}'))
      .toEqual({ from: 16, to: 18 });
    expect(quotedCompletionEditOffsets(inside, inside.length - 2, '${1:\\"km\\"}'))
      .toEqual({ from: 16, to: 18 });
    expect(quotedCompletionEditOffsets(inside, inside.length - 2, '\\"km\\"'))
      .toEqual({ from: 16, to: 18 });

    const after = Text.of(['#set text(lang: "")']);
    expect(quotedCompletionEditOffsets(after, after.length - 1, '${1:"km"}'))
      .toEqual({ from: 16, to: 18 });
  });

  test("replaces the complete local hash token instead of appending to it", () => {
    const doc = Text.of(["#pag"]);
    const replacement = contextualCompletionEditOffsets(
      doc,
      4,
      "#page()",
      {
        newText: "#page()",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 }
        }
      },
      (_text, character) => character,
      0,
      4,
      true
    );

    expect(replacement).toEqual({ from: 0, to: 4 });
    expect(
      doc.sliceString(0, replacement.from)
      + "#page()"
      + doc.sliceString(replacement.to)
    ).toBe("#page()");
  });

  test("replaces the complete set-rule target instead of retaining a stale suffix", () => {
    const doc = Text.of(["#set page"]);
    const replacement = contextualCompletionEditOffsets(
      doc,
      9,
      "page()",
      {
        newText: "page()",
        range: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 7 }
        }
      },
      (_text, character) => character,
      5,
      9,
      true
    );

    expect(replacement).toEqual({ from: 5, to: 9 });
    expect(
      doc.sliceString(0, replacement.from)
      + "page()"
      + doc.sliceString(replacement.to)
    ).toBe("#set page()");
  });

  test("replaces a complete live function token when the caret is before its suffix", () => {
    const doc = Text.of(["#figure"]);
    const replacement = liveTypstCompletionEditOffsets(doc, 4);

    expect(replacement).toEqual({ from: 0, to: 7 });
    expect(
      doc.sliceString(0, replacement!.from)
      + "#figure()"
      + doc.sliceString(replacement!.to)
    ).toBe("#figure()");
  });

  test("replaces a partial named field instead of retaining its typed prefix", () => {
    const doc = Text.of(["#figure(", "  ti", ")"]);
    const cursor = doc.line(2).to;
    const replacement = liveTypstCompletionEditOffsets(doc, cursor);

    expect(replacement).toEqual({ from: doc.line(2).from + 2, to: cursor });
    expect(
      doc.sliceString(0, replacement!.from)
      + "title: "
      + doc.sliceString(replacement!.to)
    ).toBe("#figure(\n  title: \n)");
  });

  test("places the caret inside an accepted empty function call", () => {
    expect(normalizeCallableCompletionSnippet("#page()${1:}", 3, undefined))
      .toEqual({ template: "#page(${})", opensArguments: true });
    expect(normalizeCallableCompletionSnippet("#figure", 3, undefined))
      .toEqual({ template: "#figure(${})", opensArguments: true });
    expect(normalizeCallableCompletionSnippet("#circle(${1:})", 3, undefined))
      .toEqual({ template: "#circle(${1:})", opensArguments: true });
    expect(normalizeCallableCompletionSnippet("#page(width: 10cm)", 3, undefined))
      .toEqual({ template: "#page(width: 10cm)", opensArguments: false });
    expect(completedEmptyCallCaret("#page()", "#page")).toBe(6);
    expect(completedEmptyCallCaret("before #align() after", "#align")).toBe(14);
  });

  test("recognizes an empty manually typed function argument context", () => {
    expect(isEmptyTypstFunctionCallAt("#page()", 6)).toBe(true);
    expect(isEmptyTypstFunctionCallAt("Text #page() after", 11)).toBe(true);
    expect(isEmptyTypstFunctionCallAt("#set align()", 11)).toBe(true);
    expect(isEmptyTypstFunctionCallAt("#show heading()", 14)).toBe(true);
    expect(isEmptyTypstFunctionCallAt("#page()", 7)).toBe(false);
    expect(isEmptyTypstFunctionCallAt("#page(width: 10cm)", 6)).toBe(false);
  });

  test("recognizes named-argument slots across function lines", () => {
    const empty = Text.of(["#figure(", "  ", ")"]);
    expect(isTypstFunctionArgumentContextAt(empty, empty.line(2).to)).toBe(true);

    const prefix = Text.of(["#figure(", "  capt", ")"]);
    expect(isTypstFunctionArgumentContextAt(prefix, prefix.line(2).to)).toBe(false);
    expect(isTypstFunctionArgumentContextAt(prefix, prefix.line(2).to, true)).toBe(true);

    const value = Text.of(["#figure(", "  caption: content", ")"]);
    expect(isTypstFunctionArgumentContextAt(value, value.line(2).to, true)).toBe(false);

    const tuple = Text.of(["#let value = (", "  ", ")"]);
    expect(isTypstFunctionArgumentContextAt(tuple, tuple.line(2).to, true)).toBe(false);
  });

  test("recognizes a function comma boundary but waits for spacing to reopen completion", async () => {
    const sameLine = Text.of(["#figure(caption: [Example],"]);
    expect(isTypstFunctionArgumentContextAt(sameLine, sameLine.length)).toBe(true);

    const multiline = Text.of(["#figure(", "  caption: [Example],", ")"]);
    expect(isTypstFunctionArgumentContextAt(multiline, multiline.line(2).to)).toBe(true);

    const tuple = Text.of(["#let values = (1,"]);
    expect(isTypstFunctionArgumentContextAt(tuple, tuple.length)).toBe(false);

    const source = await Bun.file(new URL("../src/editor/autocomplete.ts", import.meta.url)).text();
    expect(source).toContain('const isFunctionArgumentNameTrigger = lastChar === " "');
    expect(source).toContain('const isFunctionArgumentValueTrigger = lastChar === " "');
    expect(source).toContain(
      "const isFunctionArgumentTrigger = isFunctionArgumentNameTrigger"
    );
    expect(source).toContain("&& !isFunctionArgumentTrigger");
  });

  test("keeps argument completion open across spaces after a comma", () => {
    const afterSpace = Text.of(['#image(fit: "contain", )']);
    expect(isTypstFunctionArgumentContextAt(afterSpace, afterSpace.length - 1)).toBe(true);
    expect(typstArgumentCompletionValidFor.test("")).toBe(true);
    expect(typstArgumentCompletionValidFor.test("  ")).toBe(true);
    expect(typstArgumentCompletionValidFor.test("  ti")).toBe(true);
    expect(typstArgumentCompletionValidFor.test("title:")).toBe(false);
    expect(typstArgumentCompletionValidFor.test(", ")).toBe(false);
  });

  test("explicitly starts completion when typing into a fresh argument slot", async () => {
    const source = await Bun.file(new URL("../src/editor/extensions.ts", import.meta.url)).text();
    expect(source).toContain("const functionArgumentCompletionTrigger = EditorView.updateListener.of");
    expect(source).toContain("if (/[,\\s]$/u.test(inserted.toString())) enteredArgumentSlot = true");
    expect(source).toContain("if (completionStatus(update.view.state) === null) startCompletion(update.view)");
    expect(source).toContain("functionArgumentCompletionTrigger,");
  });

  test("queries before trailing whitespace when an argument slot touches the closing parenthesis", () => {
    const adjacent = Text.of(['#image(fit: "contain", )']);
    const cursor = adjacent.length - 1;
    expect(typstCompletionRequestPosition(adjacent, cursor, true)).toBe(cursor - 1);

    const trailingSpace = Text.of(['#image(fit: "contain",  )']);
    expect(typstCompletionRequestPosition(trailingSpace, cursor, true)).toBe(cursor);

    const outsideFunction = Text.of(["Text )"]);
    expect(typstCompletionRequestPosition(outsideFunction, 5, false)).toBe(5);
  });

  test("recognizes function argument value slots", () => {
    const emptyValue = Text.of(["#image(fit: )"]);
    expect(isTypstFunctionArgumentValueContextAt(emptyValue, 12)).toBe(true);

    const partialValue = Text.of(["#image(fit: \"con\")"]);
    expect(isTypstFunctionArgumentValueContextAt(partialValue, 16)).toBe(true);

    const argumentName = Text.of(["#image(fit)"]);
    expect(isTypstFunctionArgumentValueContextAt(argumentName, 10)).toBe(false);
  });

  test("queries quoted argument values from their opening quote", () => {
    const empty = Text.of(['#image(fit: "")']);
    expect(quotedTypstArgumentValueStart(empty, empty.length - 2)).toBe(12);

    const partial = Text.of(['#image(fit: "co")']);
    expect(quotedTypstArgumentValueStart(partial, partial.length - 2)).toBe(12);

    const prose = Text.of(['#image("asset.png")']);
    expect(quotedTypstArgumentValueStart(prose, prose.length - 2)).toBeNull();
  });

  test("prefers the complete quoted value over an insertion-only LSP edit", () => {
    const doc = Text.of(['#image(fit: "")']);
    expect(completionEditOffsets(
      doc,
      doc.length - 2,
      '"contain"',
      {
        newText: '"contain"',
        range: {
          start: { line: 0, character: 12 },
          end: { line: 0, character: 12 }
        }
      },
      (_text, character) => character
    )).toEqual({ from: 12, to: 14 });
  });

  test("places the caret after accepted non-callable argument values", async () => {
    const source = await Bun.file(new URL("../src/editor/autocomplete.ts", import.meta.url)).text();
    expect(source).toContain(
      "if (isFunctionArgumentValue && !callableSnippet.opensArguments)"
    );
    expect(source).toContain("const documentLengthBeforeApply = view.state.doc.length");
    expect(source).toContain("const anchor = edit.from + insertedLength");
  });

  test("uses Tab and Enter to accept completions and Ctrl+Enter for argument newlines", async () => {
    const source = await Bun.file(new URL("../src/editor/extensions.ts", import.meta.url)).text();
    expect(source).toContain('event.key === "Tab" && completionActive');
    expect(source).toContain("handled = acceptCompletion(view)");
    expect(source).not.toContain("namedArgumentSelected");
    expect(source).not.toContain("closeCompletion(view)");
    expect(source).toContain('event.key === "Enter" && event.ctrlKey && insideFunctionArguments');
    expect(source).not.toContain('event.key === "Enter" && namedArgumentSelected');
    expect(source).toContain('else if (event.key === "Enter")');
    expect(source).toContain("handled = insertNewlineAndIndent(view)");
    expect(source).toContain("queueMicrotask(() => startCompletion(view))");
  });

  test("allows explicit field completion after a partial argument name", async () => {
    const source = await Bun.file(new URL("../src/editor/autocomplete.ts", import.meta.url)).text();
    expect(source).toMatch(
      /isTypstFunctionArgumentContextAt\(\s*context\.state\.doc,\s*context\.pos,\s*context\.explicit\s*\)/
    );
    const partial = Text.of(["#image(f)"]);
    expect(isTypstFunctionArgumentContextAt(partial, 8)).toBe(false);
    expect(isTypstFunctionArgumentContextAt(partial, 8, true)).toBe(true);
  });

  test("keeps set and show target completion separate from argument filtering", () => {
    expect(isTypstRuleTargetAt("#set ", 5)).toBe(true);
    expect(isTypstRuleTargetAt("#set p", 6)).toBe(true);
    expect(isTypstRuleTargetAt("#set page", 9)).toBe(true);
    expect(isTypstRuleTargetAt("#show h", 7)).toBe(true);
    expect(isTypstRuleTargetAt("#set page(", 10)).toBe(false);
    expect(isTypstRuleTargetAt("#show heading:", 14)).toBe(false);
  });

  test("recognizes member completion on hash expressions", () => {
    expect(isTypstMemberAccessAt('#"hello".le', 11)).toBe(true);
    expect(isTypstMemberAccessAt("#value.fi", 9)).toBe(true);
    expect(isTypstMemberAccessAt("#items.at(0).fi", 15)).toBe(true);
    expect(isTypstMemberAccessAt("#(1 + 2).fi", 11)).toBe(true);
    expect(isTypstMemberAccessAt("#let x = items.", 15)).toBe(true);
    expect(isTypstMemberAccessAt("#let x = items.fi", 17)).toBe(true);
    expect(isTypstMemberAccessAt("example.fi", 10)).toBe(false);
    expect(isTypstMemberAccessAt("See #tag and example.fi", 23)).toBe(false);
    expect(typstMemberCompletionValidFor.test("")).toBe(true);
    expect(typstMemberCompletionValidFor.test("le")).toBe(true);
    expect(typstMemberCompletionValidFor.test(".le")).toBe(false);
  });

  test("keeps direct members and removes Tinymist expression transformations", () => {
    expect(isDirectMemberCompletion({ label: "fields", kind: 3 })).toBe(true);
    expect(isDirectMemberCompletion({ label: "depth", kind: 6 })).toBe(true);
    expect(isDirectMemberCompletion({ label: "project-key", kind: 10 })).toBe(true);
    expect(isDirectMemberCompletion({
      label: "align",
      kind: 15,
      additionalTextEdits: [{ newText: "align(" }]
    })).toBe(false);
    expect(isDirectMemberCompletion({
      label: "block",
      kind: 3,
      additionalTextEdits: [{ newText: "block(" }]
    })).toBe(false);
  });

  test("replaces the live member suffix after completion opened on the dot", () => {
    const doc = Text.of(['#"hello".le']);
    const replacement = liveTypstMemberCompletionEditOffsets(doc, doc.length);
    expect(replacement).toEqual({ from: 9, to: 11 });
    expect(
      doc.sliceString(0, replacement!.from)
      + "len()"
      + doc.sliceString(replacement!.to)
    ).toBe('#"hello".len()');

    const bareDot = Text.of(['#"hello".']);
    expect(liveTypstMemberCompletionEditOffsets(bareDot, bareDot.length))
      .toEqual({ from: 9, to: 9 });
  });

  test("replaces a member suffix on the right-hand side of a let assignment", () => {
    const doc = Text.of(["#let x = items.fi"]);
    const replacement = liveTypstMemberCompletionEditOffsets(doc, doc.length);

    expect(replacement).toEqual({ from: 15, to: 17 });
  });

  test("activates named argument completion after accepting an empty function call", async () => {
    const source = await Bun.file(new URL("../src/editor/autocomplete.ts", import.meta.url)).text();
    expect(source).toContain("memberItems.filter(isNamedArgumentCompletion)");
    expect(source).toContain("isEmptyFunctionCall");
    expect(source).toContain("? null");
    expect(source).toContain("startCompletion(view)");
  });

  test("does not force value completion immediately after accepting a named argument field", async () => {
    const source = await Bun.file(new URL("../src/editor/autocomplete.ts", import.meta.url)).text();
    expect(source).not.toContain("const opensArgumentValueCompletion = isFunctionArgumentStart");
    expect(source).not.toContain("if (opensArgumentValueCompletion)");
    expect(source).toContain('const isFunctionArgumentValueTrigger = lastChar === " "');
    expect(source).toContain("isTypstFunctionArgumentValueContextAt(");
  });
});

describe("segmented language completion", () => {
  test("preserves provider-ranked visual alias completions", async () => {
    const source = await Bun.file(new URL("../src/editor/autocomplete.ts", import.meta.url)).text();
    expect(source).toContain("filter: false,");
    expect(source).toContain("visual aliases such as Khmer COENG");
    expect(source).toContain("No `validFor` is provided");
  });

  test("replaces only the final word in an unspaced run", () => {
    expect(languageCompletionRange(10, 12, {
      provider: "khmer-segmenter",
      from: 7,
      to: 12,
      options: ["word"]
    })).toEqual({ from: 17, to: 22 });
  });

  test("rejects a response for a stale run length", () => {
    expect(languageCompletionRange(0, 13, {
      provider: "khmer-segmenter",
      from: 7,
      to: 12,
      options: ["word"]
    })).toBeNull();
  });
});
