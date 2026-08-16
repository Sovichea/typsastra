/**
 * Runtime-free Typst completion metadata used when Tinymist is unavailable.
 * Keep this catalog deterministic and serializable so it can later be
 * generated from a pinned Typst release without changing the editor API.
 */
export type StaticTypstCompletionItem = {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  insertTextFormat?: number;
  sortText?: string;
};

type TypstFunctionEntry = {
  fields?: Readonly<Record<string, string>>;
  content?: boolean;
  detail?: string;
};

const FUNCTIONS: Readonly<Record<string, TypstFunctionEntry>> = {
  align: { fields: { alignment: "alignment" }, content: true },
  block: { fields: { width: "relative | auto", height: "relative | auto", breakable: "bool", fill: "color | gradient | none", stroke: "stroke | none", radius: "relative", inset: "relative | dictionary", outset: "relative | dictionary", clip: "bool", sticky: "bool", above: "relative", below: "relative" }, content: true },
  box: { fields: { width: "relative | auto", height: "relative | auto", baseline: "relative", fill: "color | gradient | none", stroke: "stroke | none", radius: "relative", inset: "relative | dictionary", outset: "relative | dictionary", clip: "bool" }, content: true },
  circle: { fields: { radius: "relative", width: "relative", height: "relative", fill: "color | gradient | none", stroke: "stroke | none", inset: "relative" }, content: true },
  columns: { fields: { count: "int", gutter: "relative" }, content: true },
  document: { fields: { title: "str | content | none", author: "array | str", keywords: "array | str", date: "datetime | auto | none" } },
  ellipse: { fields: { width: "relative", height: "relative", fill: "color | gradient | none", stroke: "stroke | none", inset: "relative" }, content: true },
  emph: { content: true, detail: "Emphasized content" },
  enum: { fields: { tight: "bool", numbering: "str | function", start: "int", full: "bool", indent: "length", "body-indent": "length", spacing: "relative" }, content: true },
  figure: { fields: { placement: "alignment | auto | none", scope: "str", caption: "content | none", kind: "function | str | none", supplement: "content | function | auto | none", numbering: "str | function | none", gap: "relative", outlined: "bool" }, content: true },
  grid: { fields: { columns: "array | int", rows: "array | int", gutter: "relative | array", "column-gutter": "relative | array", "row-gutter": "relative | array", fill: "color | array | function | none", align: "alignment | array | function", stroke: "stroke | array | function | none", inset: "relative | array | function" }, content: true },
  heading: { fields: { level: "int | auto", depth: "int", offset: "int", numbering: "str | function | none", supplement: "content | function | auto", outlined: "bool", bookmarked: "bool", hanging: "relative | auto" }, content: true },
  highlight: { fields: { fill: "color | gradient | none", stroke: "stroke | none", "top-edge": "length | str", "bottom-edge": "length | str", extent: "length", radius: "relative" }, content: true },
  image: { fields: { format: "str | auto", width: "relative | auto", height: "relative | auto", alt: "str | none", fit: "str", scaling: "str" }, detail: "Decode and display an image" },
  line: { fields: { start: "array", end: "array | none", length: "relative", angle: "angle", stroke: "stroke" } },
  link: { fields: { dest: "str | label | location | dictionary" }, content: true },
  list: { fields: { tight: "bool", marker: "content | function", indent: "length", "body-indent": "length", spacing: "relative" }, content: true },
  metadata: { fields: { value: "any" }, content: true },
  move: { fields: { dx: "relative", dy: "relative" }, content: true },
  outline: { fields: { title: "content | auto | none", target: "selector", depth: "int | none", indent: "relative | function | auto", fill: "content | function | none" } },
  overline: { fields: { stroke: "stroke | auto", offset: "relative | auto", extent: "relative", evade: "bool", background: "bool" }, content: true },
  pad: { fields: { left: "relative", top: "relative", right: "relative", bottom: "relative", x: "relative", y: "relative", rest: "relative" }, content: true },
  page: { fields: { paper: "str", width: "auto | length", height: "auto | length", flipped: "bool", margin: "relative | dictionary", binding: "alignment", columns: "int", fill: "color | gradient | tiling | none", numbering: "str | function | none", "number-align": "alignment", header: "content | none", "header-ascent": "relative", footer: "content | none", "footer-descent": "relative", background: "content | none", foreground: "content | none" } },
  par: { fields: { leading: "length", spacing: "relative", justify: "bool", linebreaks: "str", "first-line-indent": "length", "hanging-indent": "length", "justification-limits": "dictionary" }, content: true },
  place: { fields: { alignment: "alignment", scope: "str", float: "bool", clearance: "relative", dx: "relative", dy: "relative" }, content: true },
  polygon: { fields: { fill: "color | gradient | none", "fill-rule": "str", stroke: "stroke | none", vertices: "array" } },
  quote: { fields: { block: "bool", quotes: "auto | bool", attribution: "content | label | none" }, content: true },
  raw: { fields: { block: "bool", lang: "str", align: "alignment", syntaxes: "array", theme: "str | none", "tab-size": "int" }, content: true },
  rect: { fields: { width: "relative | auto", height: "relative | auto", fill: "color | gradient | none", stroke: "stroke | none", radius: "relative", inset: "relative", outset: "relative" }, content: true },
  repeat: { fields: { gap: "length", justify: "bool" }, content: true },
  rotate: { fields: { angle: "angle", origin: "alignment", reflow: "bool" }, content: true },
  scale: { fields: { x: "ratio", y: "ratio", origin: "alignment", reflow: "bool" }, content: true },
  square: { fields: { size: "relative", width: "relative", height: "relative", fill: "color | gradient | none", stroke: "stroke | none", radius: "relative", inset: "relative" }, content: true },
  stack: { fields: { dir: "direction", spacing: "relative" }, content: true },
  strike: { fields: { stroke: "stroke | auto", offset: "relative | auto", extent: "relative", background: "bool" }, content: true },
  strong: { fields: { delta: "int" }, content: true, detail: "Strongly emphasized content" },
  table: { fields: { columns: "array | int", rows: "array | int", gutter: "relative | array", "column-gutter": "relative | array", "row-gutter": "relative | array", fill: "color | array | function | none", align: "alignment | array | function", stroke: "stroke | array | function | none", inset: "relative | array | function" }, content: true },
  text: { fields: { font: "str | array", fallback: "bool", style: "str", weight: "int | str", stretch: "ratio", size: "length", fill: "color | gradient", stroke: "stroke | none", tracking: "length", spacing: "relative", baseline: "length", overhang: "bool", "top-edge": "length | str", "bottom-edge": "length | str", lang: "str", region: "str | none", script: "str | auto", dir: "direction | auto", hyphenate: "bool | auto" }, content: true },
  terms: { fields: { tight: "bool", separator: "content", indent: "length", "hanging-indent": "length", spacing: "relative" }, content: true },
  underline: { fields: { stroke: "stroke | auto", offset: "relative | auto", extent: "relative", evade: "bool", background: "bool" }, content: true },
};

const KEYWORDS = [
  "let", "set", "show", "import", "include", "context", "if", "else",
  "for", "while", "break", "continue", "return", "as", "in",
];

const CONSTANTS = ["auto", "none", "true", "false"];

const FIELD_VALUES: Readonly<Record<string, readonly string[]>> = {
  fit: ["contain", "cover", "stretch"],
  scaling: ["auto", "smooth", "pixelated"],
  paper: ["a4", "a3", "a5", "us-letter", "us-legal", "presentation-16-9"],
  style: ["normal", "italic", "oblique"],
  weight: ["thin", "extralight", "light", "regular", "medium", "semibold", "bold", "extrabold", "black"],
  lang: ["en", "km", "lo", "fr", "de", "es", "zh", "ja", "ko"],
  dir: ["ltr", "rtl", "ttb", "btt"],
  linebreaks: ["auto", "simple", "optimized"],
  placement: ["auto", "none", "top", "bottom"],
  scope: ["column", "parent"],
  block: ["true", "false"],
  justify: ["true", "false"],
  hyphenate: ["auto", "true", "false"],
};

const QUOTED_VALUE_FIELDS = new Set([
  "fit",
  "scaling",
  "paper",
  "style",
  "weight",
  "lang",
  "linebreaks",
  "scope",
]);

const MEMBER_NAMES = [
  "at", "first", "last", "len", "slice", "contains", "find", "position",
  "filter", "map", "fold", "sum", "sorted", "rev", "join", "keys", "values",
  "pairs", "insert", "remove", "push", "pop", "replace", "trim", "split",
];

function callableItem(name: string, entry: TypstFunctionEntry): StaticTypstCompletionItem[] {
  const items: StaticTypstCompletionItem[] = [{
    label: name,
    kind: 3,
    detail: entry.detail ?? "Typst function",
    insertText: `${name}(\${1:})`,
    insertTextFormat: 2,
  }];
  if (entry.content) {
    items.push({
      label: `${name}.bracket`,
      kind: 3,
      detail: "Typst content function",
      insertText: `${name}[\${1:}]`,
      insertTextFormat: 2,
    });
  }
  return items;
}

export function staticTypstGlobalCompletions(): StaticTypstCompletionItem[] {
  return [
    ...KEYWORDS.map((label, index) => ({ label, kind: 14, detail: "Typst syntax", sortText: `0-${index}` })),
    ...Object.entries(FUNCTIONS).flatMap(([name, entry]) => callableItem(name, entry)),
    ...CONSTANTS.map(label => ({ label, kind: 6, detail: "Typst constant" })),
  ];
}

export function staticTypstFieldCompletions(functionName: string | null): StaticTypstCompletionItem[] {
  if (!functionName) return [];
  const functionParts = functionName.split(".");
  const baseName = functionParts[functionParts.length - 1] ?? functionName;
  const fields = FUNCTIONS[baseName]?.fields;
  if (!fields) return [];
  return Object.entries(fields).map(([label, detail]) => ({
    label,
    kind: 5,
    detail,
    // Match the LSP representation consumed by the shared named-argument
    // pipeline. That pipeline adds Typsastra's editable default value.
    insertText: `${label}: `,
  }));
}

export function staticTypstValueCompletions(fieldName: string | null): StaticTypstCompletionItem[] {
  if (!fieldName) return [...CONSTANTS].map(label => ({ label, kind: 6, detail: "Typst value" }));
  const values = FIELD_VALUES[fieldName] ?? CONSTANTS;
  const quoted = QUOTED_VALUE_FIELDS.has(fieldName);
  return values.map(label => ({
    label,
    kind: 6,
    detail: `Value for ${fieldName}`,
    insertText: quoted && !["true", "false", "auto", "none"].includes(label) ? `"${label}"` : label,
  }));
}

export function staticTypstMemberCompletions(): StaticTypstCompletionItem[] {
  return MEMBER_NAMES.map(label => ({ label, kind: 2, detail: "Common Typst method" }));
}
