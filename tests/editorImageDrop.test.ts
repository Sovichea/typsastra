import { describe, expect, test } from "bun:test";
import {
  EXPLORER_IMAGE_DRAG_TYPE,
  clipboardImageFiles,
  imageInsertionSnippet,
  imageInsertionSnippets,
  moveImageDropCaret,
  relativeDocumentAssetPath,
} from "../src/editor/imageDrop";

const read = async (path: string): Promise<string> => Bun.file(new URL(path, import.meta.url)).text();

describe("editor image drag and drop", () => {
  test("builds document-relative image paths across nested folders", () => {
    expect(relativeDocumentAssetPath(
      "C:\\Research",
      "C:\\Research\\chapters\\intro.typ",
      "C:\\Research\\images\\diagram.png",
    )).toBe("../images/diagram.png");
    expect(relativeDocumentAssetPath(
      "/home/writer/book",
      "/home/writer/book/main.typ",
      "/home/writer/book/images/រូប.png",
    )).toBe("images/រូប.png");
    expect(relativeDocumentAssetPath("/project", "/project/main.typ", "/outside/image.png"))
      .toBeNull();
  });

  test("accepts clipboard image files without claiming text paste", () => {
    const image = new File([new Uint8Array([1, 2, 3])], "clipboard.png", { type: "image/png" });
    const text = new File(["notes"], "notes.txt", { type: "text/plain" });
    const transfer = {
      items: [
        { kind: "file", type: "image/png", getAsFile: () => image },
        { kind: "file", type: "text/plain", getAsFile: () => text },
        { kind: "string", type: "text/plain", getAsFile: () => null },
      ],
    };

    expect(clipboardImageFiles(transfer as never)).toEqual([image]);
    expect(clipboardImageFiles(null)).toEqual([]);
  });

  test("moves the editor caret to the current image drop point", () => {
    const dispatched: unknown[] = [];
    let focused = false;
    const view = {
      state: { selection: { main: { head: 2 } } },
      posAtCoords: () => 9,
      dispatch: (spec: unknown) => dispatched.push(spec),
      focus: () => { focused = true; },
    };

    expect(moveImageDropCaret(view as never, { x: 40, y: 80 })).toBe(9);
    expect(dispatched).toEqual([{ selection: { anchor: 9 }, scrollIntoView: true }]);
    expect(focused).toBe(true);
  });

  test("builds plain and captioned Typst image snippets", () => {
    expect(imageInsertionSnippet('images/a"b.png', "image")).toEqual({
      text: '#image("images/a\\"b.png")',
      selectionOffset: 25,
    });
    const figure = imageInsertionSnippet("../images/diagram.png", "figure");
    expect(figure.text).toBe(
      '#figure(\n  image("../images/diagram.png"),\n  caption: [],\n)',
    );
    expect(figure.text.slice(figure.selectionOffset)).toStartWith("],\n)");
  });

  test("applies one insertion style to every dropped image", () => {
    const plain = imageInsertionSnippets(["images/a.png", "images/b.png"], "image");
    expect(plain).toEqual({
      text: '#image("images/a.png")\n#image("images/b.png")',
      selectionOffset: 45,
    });

    const figures = imageInsertionSnippets(["images/a.png", "images/b.png"], "figure");
    expect(figures?.text).toContain('#figure(\n  image("images/a.png"),');
    expect(figures?.text).toContain('#figure(\n  image("images/b.png"),');
    expect(figures?.text.slice(figures.selectionOffset)).toStartWith("],\n)");
  });

  test("wires explorer payloads and native drops to the editor", async () => {
    const explorer = await read("../src/components/explorer.ts");
    const extensions = await read("../src/editor/extensions.ts");
    const controller = await read("../src/workspace/fileDropController.ts");

    expect(explorer).toContain('label.addEventListener("pointerdown"');
    expect(explorer).toContain("this.onImageDragStart?.(node.path, event, label)");
    expect(extensions).toContain("event.dataTransfer?.types.includes(EXPLORER_IMAGE_DRAG_TYPE)");
    expect(extensions).toContain("const files = clipboardImageFiles(event.clipboardData)");
    expect(extensions).toContain("if (files.length === 0 || !onClipboardImagePaste) return false");
    expect(extensions).toContain("if (view.state.doc !== document) return");
    expect(extensions).toContain("moveImageDropCaret(view, { x: event.clientX, y: event.clientY })");
    expect(controller).toContain("startExplorerImageDrag(path: string, event: PointerEvent, source: HTMLElement)");
    expect(controller).toContain("handleExplorerPointerMove(event: PointerEvent)");
    expect(controller).toContain("handleExplorerPointerUp(event: PointerEvent)");
    expect(controller).toContain("createExplorerDragGhost(drag)");
    expect(controller).toContain('icon.className = "explorer-image-drag-ghost-icon"');
    expect(controller).toContain('label.textContent = drag.label');
    expect(controller).toContain('image-drop-forbidden');
    expect(controller).toContain("isExplorerImageDropAllowed(target)");
    expect(controller).toContain("onDragDropEvent");
    expect(controller).toContain("moveImageDropCaret(this.deps.editor(), point)");
    expect(controller).toContain('destinationRelativeDirectory: "images"');
    expect(controller).toContain("await this.insertImages(images, position, view)");
    expect(controller).toContain('invoke<string>("save_workspace_clipboard_image"');
    expect(controller).toContain('filePathKey(this.deps.activeFilePath() ?? "") === filePathKey(documentPath)');
    expect(controller).toContain("view.state.doc === originalDocument");
    expect(controller).toContain("imageInsertionSnippets(relativePaths, insertion)");
    expect(controller).toContain('userEvent: "input.drop"');
    expect(EXPLORER_IMAGE_DRAG_TYPE).toBe("application/x-typsastra-explorer-image");
  });
});
