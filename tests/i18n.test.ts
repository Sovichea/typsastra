import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  getLocale,
  localizeDom,
  registerLocale,
  setLocale,
  t,
  tn,
} from "../src/i18n";

const testLocale = {
  id: "test-i18n",
  label: "Test",
  catalog: {
    "Save": "រក្សាទុក",
    "Open": "បើក",
    "Folder": "ថត",
    "Hello {name}": "សួស្តី {name}",
    "Downloading {0}%": "កំពុងទាញយក {0}%",
    "Search languages...": "ស្វែងរកភាសា...",
    "Select {family} at {scale} times scale": "ជ្រើស {family} នៅ {scale} ដង",
    "{count} file": "ឯកសារ {count}",
    "{count} files": "ឯកសារ {count}",
  },
};

registerLocale(testLocale);

afterEach(() => {
  setLocale("en");
});

describe("i18n translation", () => {
  test("falls back to the English source message", () => {
    expect(getLocale()).toBe("en");
    expect(t("Untranslated message")).toBe("Untranslated message");
    expect(t("Hello {name}", { name: "Ada" })).toBe("Hello Ada");
  });

  test("uses the active catalog and interpolates named placeholders", () => {
    setLocale(testLocale.id);
    expect(t("Save")).toBe("រក្សាទុក");
    expect(t("Hello {name}", { name: "Ada" })).toBe("សួស្តី Ada");
    expect(t("Select {family} at {scale} times scale", { family: "Khmer", scale: 1.25 }))
      .toBe("ជ្រើស Khmer នៅ 1.25 ដង");
  });

  test("supports tagged templates with positional placeholders", () => {
    expect(t`Downloading ${45}%`).toBe("Downloading 45%");
    setLocale(testLocale.id);
    expect(t`Downloading ${45}%`).toBe("កំពុងទាញយក 45%");
  });

  test("selects singular and plural source messages", () => {
    setLocale(testLocale.id);
    expect(tn(1, "{count} file", "{count} files")).toBe("ឯកសារ 1");
    expect(tn(3, "{count} file", "{count} files")).toBe("ឯកសារ 3");
  });

  test("keeps unknown placeholders and unknown locales fail loudly", () => {
    setLocale(testLocale.id);
    expect(t("Hello {missing}", { name: "Ada" })).toBe("Hello {missing}");
    expect(() => setLocale("missing-locale")).toThrow("Unknown locale");
  });

  test("initializes the active locale before platform shortcut labels", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main.indexOf("initializeI18n();")).toBeLessThan(main.indexOf("applyShortcutLabels();"));
  });

  test("ships a copyable locale template with the extracted keys", () => {
    const template = readFileSync(
      new URL("../src/i18n/locales/locale.template.ts", import.meta.url),
      "utf8"
    );
    expect(template).toContain("export const localeTemplate: LocaleDefinition");
    expect(template).toContain('id: "xx"');
    expect(template).toContain('"Save": "Save"');
    expect(template).toContain('"Search languages...": "Search languages..."');
    expect(template).toContain("bun run i18n:template");
  });
});

class FakeText {
  readonly nodeType = 3;
  readonly childNodes: FakeNode[] = [];
  nodeValue: string;

  constructor(value: string) {
    this.nodeValue = value;
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly childNodes: FakeNode[] = [];
  readonly children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  append(...nodes: FakeNode[]): this {
    for (const node of nodes) {
      this.childNodes.push(node);
      if (node instanceof FakeElement) this.children.push(node);
    }
    return this;
  }

  get textContent(): string {
    return this.childNodes.map(node => "nodeValue" in node ? node.nodeValue : node.textContent).join("");
  }

  set textContent(value: string) {
    this.childNodes.length = 0;
    this.children.length = 0;
    this.childNodes.push(new FakeText(value));
  }
}

type FakeNode = FakeText | FakeElement;

function asParent(element: FakeElement): ParentNode {
  return element as unknown as ParentNode;
}

describe("i18n DOM localization", () => {
  test("translates text and accessible attributes and restores the source", () => {
    const root = new FakeElement("DIV");
    const label = new FakeElement("DIV");
    label.setAttribute("title", "Open");
    label.setAttribute("aria-label", "Search languages...");
    label.append(new FakeText("  Save  "));
    const input = new FakeElement("INPUT");
    input.setAttribute("placeholder", "Search languages...");
    root.append(label, input);

    setLocale(testLocale.id);
    localizeDom(asParent(root));

    expect(label.textContent).toBe("  រក្សាទុក  ");
    expect(label.getAttribute("title")).toBe("បើក");
    expect(label.getAttribute("aria-label")).toBe("ស្វែងរកភាសា...");
    expect(input.getAttribute("placeholder")).toBe("ស្វែងរកភាសា...");

    setLocale("en");
    localizeDom(asParent(root));

    expect(label.textContent).toBe("  Save  ");
    expect(label.getAttribute("title")).toBe("Open");
    expect(label.getAttribute("aria-label")).toBe("Search languages...");
    expect(input.getAttribute("placeholder")).toBe("Search languages...");
  });

  test("supports explicit keys and skips shortcut or editable content", () => {
    const root = new FakeElement("DIV");
    const explicit = new FakeElement("DIV");
    explicit.setAttribute("data-i18n", "Folder");
    explicit.append(new FakeText("Anything"));
    const shortcut = new FakeElement("SPAN");
    shortcut.setAttribute("data-shortcut", "Mod+S");
    shortcut.append(new FakeText("Save"));
    const editable = new FakeElement("DIV");
    editable.setAttribute("contenteditable", "true");
    editable.append(new FakeText("Save"));
    const overridden = new FakeElement("BUTTON");
    overridden.setAttribute("title", "Authored title");
    overridden.setAttribute("data-i18n-title", "Open");
    root.append(explicit, shortcut, editable, overridden);

    setLocale(testLocale.id);
    localizeDom(asParent(root));

    expect(explicit.textContent).toBe("ថត");
    expect(shortcut.textContent).toBe("Save");
    expect(editable.textContent).toBe("Save");
    expect(overridden.getAttribute("title")).toBe("បើក");
  });
});
