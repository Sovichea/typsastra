import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as ts from "typescript";
import { normalizeMessageKey } from "../src/i18n/translate";

const root = process.cwd();
const messages = new Map<string, Set<string>>();

function addMessage(value: string, origin: string): void {
  const normalized = normalizeMessageKey(value);
  if (!/\p{L}/u.test(normalized)) return;
  const origins = messages.get(normalized) ?? new Set<string>();
  origins.add(origin);
  messages.set(normalized, origins);
}

const skippedHtmlTags = new Set([
  "script",
  "style",
  "code",
  "pre",
  "kbd",
  "samp",
  "textarea",
  "svg",
  "path",
  "title",
]);

const voidHtmlTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "path",
]);

async function extractHtml(): Promise<void> {
  const html = await Bun.file(join(root, "index.html")).text();
  let skippedDepth = 0;
  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      const tag = element.tagName.toLowerCase();
      const skipped = skippedDepth > 0
        || skippedHtmlTags.has(tag)
        || element.hasAttribute("data-i18n-skip")
        || element.hasAttribute("data-shortcut");
      if (skipped) {
        if (!voidHtmlTags.has(tag)) {
          try {
            element.onEndTag(() => {
              skippedDepth = Math.max(0, skippedDepth - 1);
            });
            skippedDepth += 1;
          } catch {
            // Self-closing non-void elements have no text content to skip.
          }
        }
        return;
      }
      for (const attribute of ["placeholder", "title", "aria-label", "alt"]) {
        const value = element.getAttribute(attribute);
        if (value) addMessage(value, `index.html (${attribute})`);
      }
    },
    text(text) {
      if (skippedDepth > 0) return;
      addMessage(text.text, "index.html");
    },
  });
  await rewriter.transform(new Response(html)).text();
}

function templateKey(strings: readonly string[]): string {
  let key = "";
  for (let index = 0; index < strings.length; index += 1) {
    key += strings[index] ?? "";
    if (index < strings.length - 1) key += `{${index}}`;
  }
  return key;
}

function compareMessages(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const uiProperties = new Set([
  "title",
  "subtitle",
  "label",
  "description",
  "placeholder",
  "ariaLabel",
  "message",
  "okLabel",
  "cancelLabel",
]);

function extractTypeScript(): void {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) files.push(full);
    }
  };
  walk(join(root, "src"));
  const localeDirectory = join(root, "src", "i18n", "locales");

  for (const file of files) {
    if (file.startsWith(localeDirectory)) continue;
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
    const origin = relative(root, file);
    const addExpression = (expression: ts.Expression): void => {
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        addMessage(expression.text, origin);
      } else if (ts.isTemplateExpression(expression)) {
        const strings = [
          expression.head.text,
          ...expression.templateSpans.map(span => span.literal.text),
        ];
        addMessage(templateKey(strings), origin);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "t"
        && node.arguments.length > 0) {
        addExpression(node.arguments[0]!);
      } else if (ts.isTaggedTemplateExpression(node)
        && ts.isIdentifier(node.tag)
        && node.tag.text === "t") {
        if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
          addMessage(node.template.text, origin);
        } else if (ts.isTemplateExpression(node.template)) {
          const strings = [
            node.template.head.text,
            ...node.template.templateSpans.map(span => span.literal.text),
          ];
          addMessage(templateKey(strings), origin);
        }
      } else if (ts.isPropertyAssignment(node)) {
        const name = node.name.getText(sourceFile).replace(/^["']|["']$/g, "");
        if (uiProperties.has(name)) addExpression(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

await extractHtml();
extractTypeScript();

const catalog: Record<string, string> = {};
for (const key of [...messages.keys()].sort(compareMessages)) {
  catalog[key] = key;
}

const argumentsList = process.argv.slice(2);
const asTemplate = argumentsList.includes("--template");
const outIndex = argumentsList.indexOf("--out");
const outPath = outIndex >= 0 ? argumentsList[outIndex + 1] : undefined;

let output: string;
if (asTemplate) {
  const entries = [...messages.keys()]
    .sort(compareMessages)
    .map(key => `    ${JSON.stringify(key)}: ${JSON.stringify(key)},`)
    .join("\n");
  output = `/**
 * Copy this file to a new locale, for example \`km.ts\`, then rename the
 * export, set \`id\` and \`label\`, and translate the values.
 *
 * Register the new locale in \`src/i18n/locales/index.ts\`.
 * Refresh this template with \`bun run i18n:template\`.
 *
 * Keys are English source text. Keep placeholders such as {0}, {name}, and
 * {count} unchanged. Entries you do not translate can be removed; missing
 * keys fall back to English.
 */
import type { LocaleDefinition } from "../types";

export const localeTemplate: LocaleDefinition = {
  id: "xx",
  label: "Your language",
  catalog: {
${entries}
  },
};
`;
} else {
  output = JSON.stringify(catalog, null, 2);
}

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output.endsWith("\n") ? output : `${output}\n`);
} else {
  console.log(output);
}
console.error(`Extracted ${messages.size} translatable messages.`);
