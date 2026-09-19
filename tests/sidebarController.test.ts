import { afterEach, describe, expect, test } from "bun:test";
import { SidebarController, type SidebarControllerPort } from "../src/sidebar/sidebarController";

class FakeClassList {
  private readonly values = new Set<string>();

  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }

  add(name: string): void {
    this.values.add(name);
  }

  remove(name: string): void {
    this.values.delete(name);
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

function fakeElement(): HTMLElement {
  return {
    classList: new FakeClassList(),
    style: {},
    setAttribute: () => {},
  } as unknown as HTMLElement;
}

const previousDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
});

function createController(): { controller: SidebarController; elements: Map<string, HTMLElement> } {
  const elements = new Map<string, HTMLElement>([
    ["explorer-sidebar", fakeElement()],
    ["explorer-resizer", fakeElement()],
    ["sidebar-toggle-button", fakeElement()],
    ["explorer-sidebar-content", fakeElement()],
    ["image-tools-sidebar-content", fakeElement()],
    ["sidebar-explorer-button", fakeElement()],
    ["sidebar-images-button", fakeElement()],
    ["image-viewer-pane", fakeElement()],
  ]);
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: fakeElement(),
      getElementById: (id: string) => elements.get(id) ?? null,
    },
  });
  const port: SidebarControllerPort = {
    hasWorkspace: () => true,
    isWorkspaceLoading: () => false,
    isActiveSurfaceNonText: () => false,
    invalidatePreview: () => {},
    showImageTools: () => {},
    hideImageTools: () => {},
    showRestoringPreview: () => {},
    restoreDocumentPreview: () => {},
    setMainPreviewVisibleWhileUndocked: () => {},
    reconcileDockedPaneWidths: () => {},
    persist: () => {},
  };
  return { controller: new SidebarController(port, fakeElement(), fakeElement()), elements };
}

describe("sidebar visibility persistence", () => {
  test("keeps the sidebar open for Image Tools even when the workspace preference is hidden", () => {
    const { controller, elements } = createController();

    controller.restore({ visible: false, activeTool: "images" });

    expect(controller.visible).toBe(false);
    expect(controller.activeTool).toBe("images");
    expect(elements.get("explorer-sidebar")!.classList.contains("hidden")).toBe(false);
    expect((elements.get("sidebar-toggle-button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("does not hide the image explorer when the sidebar toggles while Image Tools is active", () => {
    const { controller, elements } = createController();

    controller.setTool("images");
    controller.toggle();

    expect(controller.visible).toBe(true);
    expect(elements.get("explorer-sidebar")!.classList.contains("hidden")).toBe(false);
  });

  test("keeps visibility unchanged when switching between Explorer and Images", () => {
    const { controller } = createController();
    controller.setVisible(false);

    controller.setTool("images");
    controller.setTool("explorer");

    expect(controller.visible).toBe(false);
    expect(controller.activeTool).toBe("explorer");
  });
});
