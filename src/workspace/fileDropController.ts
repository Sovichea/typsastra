import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, type DragDropEvent } from "@tauri-apps/api/window";
import { join } from "@tauri-apps/api/path";
import { message } from "@tauri-apps/plugin-dialog";
import type { EditorView } from "@codemirror/view";
import type { AppDialogController } from "../ui/appDialog";
import { isSupportedImageReferencePath, isTypstDocumentPath } from "../platform/fileTypes";
import { fileNameFromPath, filePathKey, relativeFilePath } from "../platform/paths";
import {
  imageInsertionSnippets,
  moveImageDropCaret,
  relativeDocumentAssetPath,
  type ClipboardImageData,
  type ImageInsertionStyle,
} from "../editor/imageDrop";

export interface FileDropDependencies {
  editor(): EditorView;
  appDialog: AppDialogController;
  workspaceRootPath(): string | null;
  activeFilePath(): string | null;
  refreshWorkspaceExplorer(): Promise<void>;
  refreshImageExplorer(): Promise<void> | void;
}

type DropPoint = { x: number; y: number };
type ExplorerPointerDrag = {
  path: string;
  pointerId: number;
  start: DropPoint;
  active: boolean;
  ghost: HTMLElement | null;
  iconHtml: string;
  label: string;
};

export class FileDropController {
  private scaleFactor = 1;
  private explorerPointerDrag: ExplorerPointerDrag | null = null;
  private suppressExplorerClickUntil = 0;

  public constructor(private readonly deps: FileDropDependencies) {}

  public initialize(): void {
    document.addEventListener("pointermove", event => this.handleExplorerPointerMove(event), true);
    document.addEventListener("pointerup", event => this.handleExplorerPointerUp(event), true);
    document.addEventListener("pointercancel", event => this.cancelExplorerPointerDrag(event.pointerId), true);
    document.addEventListener("click", event => {
      if (performance.now() >= this.suppressExplorerClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    const appWindow = getCurrentWindow();
    void appWindow.scaleFactor().then(scaleFactor => {
      this.scaleFactor = scaleFactor || 1;
      return appWindow.onDragDropEvent(event => void this.handleNativeDragDrop(event.payload));
    }).catch(error => console.error("Failed to initialize file drag and drop:", error));
  }

  public insertExplorerImage(path: string, position: number, view: EditorView): void {
    void this.insertImage(path, position, view);
  }

  public pasteClipboardImages(
    images: readonly ClipboardImageData[],
    selection: { from: number; to: number },
    view: EditorView,
  ): void {
    void this.saveAndInsertClipboardImages(images, selection, view);
  }

  public startExplorerImageDrag(path: string, event: PointerEvent, source: HTMLElement): void {
    const icon = source.querySelector<HTMLElement>(".tree-icon");
    const text = source.querySelector<HTMLElement>(".tree-text");
    this.explorerPointerDrag = {
      path,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      active: false,
      ghost: null,
      iconHtml: icon?.innerHTML ?? "",
      label: text?.textContent?.trim() || fileNameFromPath(path),
    };
  }

  private handleExplorerPointerMove(event: PointerEvent): void {
    const drag = this.explorerPointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y);
      if (distance < 5) return;
      drag.active = true;
      document.body.classList.add("explorer-image-dragging");
      drag.ghost = this.createExplorerDragGhost(drag);
    }
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY };
    const target = document.elementFromPoint(point.x, point.y);
    // Show a forbidden cursor everywhere the image cannot be placed.
    document.body.classList.toggle("image-drop-forbidden", !this.isExplorerImageDropAllowed(target));
    if (drag.ghost) {
      drag.ghost.style.left = `${point.x}px`;
      drag.ghost.style.top = `${point.y}px`;
    }
    this.showDropTarget(target, point, true);
  }

  private handleExplorerPointerUp(event: PointerEvent): void {
    const drag = this.explorerPointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.endExplorerPointerDrag(drag);
    if (!drag.active) return;

    event.preventDefault();
    event.stopPropagation();
    this.suppressExplorerClickUntil = performance.now() + 250;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target?.closest(".cm-editor")) return;
    const view = this.deps.editor();
    const position = moveImageDropCaret(view, { x: event.clientX, y: event.clientY });
    if (position !== null) this.insertExplorerImage(drag.path, position, view);
  }

  private cancelExplorerPointerDrag(pointerId: number): void {
    const drag = this.explorerPointerDrag;
    if (!drag || drag.pointerId !== pointerId) return;
    this.endExplorerPointerDrag(drag);
  }

  private endExplorerPointerDrag(drag: ExplorerPointerDrag): void {
    if (this.explorerPointerDrag === drag) this.explorerPointerDrag = null;
    drag.ghost?.remove();
    drag.ghost = null;
    document.body.classList.remove("explorer-image-dragging", "image-drop-forbidden");
    this.clearDropTarget();
  }

  private createExplorerDragGhost(drag: ExplorerPointerDrag): HTMLElement {
    const ghost = document.createElement("div");
    ghost.className = "explorer-image-drag-ghost";
    const icon = document.createElement("span");
    icon.className = "explorer-image-drag-ghost-icon";
    icon.innerHTML = drag.iconHtml;
    const label = document.createElement("span");
    label.className = "explorer-image-drag-ghost-label";
    label.textContent = drag.label;
    ghost.append(icon, label);
    document.body.appendChild(ghost);
    return ghost;
  }

  private isExplorerImageDropAllowed(target: Element | null): boolean {
    if (!target) return false;
    if (target.closest(".cm-editor")) {
      const activeFilePath = this.deps.activeFilePath();
      return Boolean(activeFilePath && isTypstDocumentPath(activeFilePath));
    }
    return target.closest("#workspace-explorer-tree") !== null
      && this.deps.workspaceRootPath() !== null;
  }

  private async handleNativeDragDrop(event: DragDropEvent): Promise<void> {
    if (event.type === "leave") {
      this.clearDropTarget();
      return;
    }

    const point = this.logicalPoint(event.position);
    const target = document.elementFromPoint(point.x, point.y);
    if (event.type === "enter" || event.type === "over") {
      this.showDropTarget(target, point, false);
      return;
    }

    this.clearDropTarget();
    if (!target || event.paths.length === 0) return;
    if (target.closest(".cm-editor")) {
      await this.dropExternalImageIntoEditor(event.paths, point);
      return;
    }

    const workspaceRoot = this.deps.workspaceRootPath();
    const destination = workspaceRoot
      ? explorerDropRelativeDirectory(workspaceRoot, target)
      : null;
    if (workspaceRoot !== null && destination !== null) {
      await this.importFilesIntoExplorer(workspaceRoot, destination, event.paths);
    }
  }

  private async dropExternalImageIntoEditor(paths: readonly string[], point: DropPoint): Promise<void> {
    const activeFilePath = this.deps.activeFilePath();
    if (!activeFilePath || !isTypstDocumentPath(activeFilePath)) {
      await message("Open a Typst document before dropping an image into the editor.", {
        title: "Typst document required",
        kind: "info",
      });
      return;
    }
    const images = paths.filter(isSupportedImageReferencePath);
    if (images.length === 0) {
      await message("Only supported image files can be dropped into a Typst editor.", {
        title: "Image required",
        kind: "info",
      });
      return;
    }
    const view = this.deps.editor();
    const position = moveImageDropCaret(view, point) ?? view.state.selection.main.head;
    await this.insertImages(images, position, view);
  }

  private async importFilesIntoExplorer(
    workspaceRoot: string,
    destinationRelativeDirectory: string,
    sources: readonly string[],
  ): Promise<void> {
    const failures: string[] = [];
    let imported = 0;
    for (const sourcePath of sources) {
      try {
        await invoke<string>("import_workspace_file", {
          workspaceRootPath: workspaceRoot,
          sourcePath,
          destinationRelativeDirectory,
        });
        imported += 1;
      } catch (error) {
        failures.push(`${fileNameFromPath(sourcePath)}: ${String(error)}`);
      }
    }
    if (imported > 0) await this.refreshExplorers();
    if (failures.length > 0) {
      await message(failures.join("\n"), {
        title: imported > 0 ? "Some files were not imported" : "File import failed",
        kind: "error",
      });
    }
  }

  private async saveAndInsertClipboardImages(
    images: readonly ClipboardImageData[],
    selection: { from: number; to: number },
    view: EditorView,
  ): Promise<void> {
    const workspaceRoot = this.deps.workspaceRootPath();
    const documentPath = this.deps.activeFilePath();
    if (!workspaceRoot || !documentPath || !isTypstDocumentPath(documentPath) || images.length === 0) return;
    const originalDocument = view.state.doc;

    const savedPaths: string[] = [];
    const failures: string[] = [];
    for (const [index, image] of images.entries()) {
      try {
        savedPaths.push(await invoke<string>("save_workspace_clipboard_image", {
          workspaceRootPath: workspaceRoot,
          mimeType: image.mimeType,
          bytes: Array.from(new Uint8Array(image.bytes)),
        }));
      } catch (error) {
        failures.push(`Image ${index + 1}: ${String(error)}`);
      }
    }
    if (savedPaths.length > 0) await this.refreshExplorers();
    if (failures.length > 0) {
      await message(failures.join("\n"), {
        title: savedPaths.length > 0 ? "Some clipboard images were not saved" : "Image paste failed",
        kind: "error",
      });
    }
    if (
      savedPaths.length > 0
      && filePathKey(this.deps.activeFilePath() ?? "") === filePathKey(documentPath)
      && this.deps.editor() === view
      && view.state.doc === originalDocument
    ) {
      await this.insertImages(savedPaths, selection.from, view, selection.to);
    }
  }

  private async insertImage(sourcePath: string, position: number, view: EditorView): Promise<void> {
    await this.insertImages([sourcePath], position, view);
  }

  private async insertImages(
    sourcePaths: readonly string[],
    position: number,
    view: EditorView,
    replaceTo = position,
  ): Promise<void> {
    const workspaceRoot = this.deps.workspaceRootPath();
    const documentPath = this.deps.activeFilePath();
    if (!workspaceRoot || !documentPath || !isTypstDocumentPath(documentPath)) return;
    const supportedPaths = sourcePaths.filter(isSupportedImageReferencePath);
    if (supportedPaths.length === 0) return;

    const originalDocumentPath = documentPath;
    const originalDocument = view.state.doc;
    const projectImagePaths: string[] = [];
    const externalPaths = supportedPaths.filter(path => relativeFilePath(workspaceRoot, path) === null);
    if (externalPaths.length > 0) {
      const imagesDirectory = await join(workspaceRoot, "images");
      const imagesDirectoryExists = await invoke<boolean>("workspace_path_exists", { path: imagesDirectory })
        .catch(() => false);
      const multiple = externalPaths.length > 1;
      const action = await this.deps.appDialog.show({
        title: imagesDirectoryExists
          ? `Copy Image${multiple ? "s" : ""} into Project`
          : "Create Images Folder",
        subtitle: multiple ? `${externalPaths.length} images` : fileNameFromPath(externalPaths[0]),
        description: imagesDirectoryExists
          ? `Images outside the project must be included in the project folder. Copy ${multiple ? "these images" : "this image"} into the project images folder?`
          : `Images outside the project must be included in the project folder. Create an images folder and copy ${multiple ? "these images" : "this image"} into it?`,
        actions: [
          { id: "cancel", label: "Cancel" },
          {
            id: "import",
            label: imagesDirectoryExists
              ? `Copy Image${multiple ? "s" : ""}`
              : "Create Folder and Copy",
            primary: true,
          },
        ],
        cancelAction: "cancel",
      });
      if (action !== "import") return;
    }

    const failures: string[] = [];
    for (const sourcePath of supportedPaths) {
      if (relativeFilePath(workspaceRoot, sourcePath) !== null) {
        projectImagePaths.push(sourcePath);
        continue;
      }
      try {
        projectImagePaths.push(await invoke<string>("import_workspace_file", {
          workspaceRootPath: workspaceRoot,
          sourcePath,
          destinationRelativeDirectory: "images",
        }));
      } catch (error) {
        failures.push(`${fileNameFromPath(sourcePath)}: ${String(error)}`);
      }
    }
    if (externalPaths.length > failures.length) await this.refreshExplorers();
    if (failures.length > 0) {
      await message(failures.join("\n"), {
        title: projectImagePaths.length > 0 ? "Some images were not imported" : "Image import failed",
        kind: "error",
      });
    }
    if (projectImagePaths.length === 0) return;

    const relativePaths = projectImagePaths
      .map(path => relativeDocumentAssetPath(workspaceRoot, documentPath, path))
      .filter((path): path is string => Boolean(path));
    if (relativePaths.length === 0) return;
    const insertion = await this.chooseInsertionStyle(relativePaths);
    if (!insertion) return;
    if (
      filePathKey(this.deps.activeFilePath() ?? "") !== filePathKey(originalDocumentPath)
      || this.deps.editor() !== view
      || view.state.doc !== originalDocument
      || position < 0
      || replaceTo < position
      || replaceTo > view.state.doc.length
    ) return;

    const snippet = imageInsertionSnippets(relativePaths, insertion);
    if (!snippet) return;
    view.dispatch({
      changes: { from: position, to: replaceTo, insert: snippet.text },
      selection: { anchor: position + snippet.selectionOffset },
      scrollIntoView: true,
      userEvent: "input.drop",
    });
    view.focus();
  }

  private async chooseInsertionStyle(relativePaths: readonly string[]): Promise<ImageInsertionStyle | null> {
    const multiple = relativePaths.length > 1;
    const action = await this.deps.appDialog.show({
      title: `Insert Image${multiple ? "s" : ""}`,
      subtitle: multiple ? `${relativePaths.length} images` : relativePaths[0],
      description: multiple
        ? "Insert every image plainly, or wrap each image in a figure function with an editable caption?"
        : "Insert a plain image, or surround it with a figure function and an editable caption?",
      actions: [
        { id: "cancel", label: "Cancel" },
        { id: "image", label: multiple ? "Plain Images" : "Plain Image" },
        { id: "figure", label: multiple ? "Figures with Captions" : "Figure with Caption", primary: true },
      ],
      cancelAction: "cancel",
    });
    return action === "image" || action === "figure" ? action : null;
  }

  private async refreshExplorers(): Promise<void> {
    await this.deps.refreshWorkspaceExplorer();
    await this.deps.refreshImageExplorer();
  }

  private logicalPoint(position: { x: number; y: number }): DropPoint {
    return { x: position.x / this.scaleFactor, y: position.y / this.scaleFactor };
  }

  private showDropTarget(target: Element | null, point: DropPoint, editorOnly: boolean): void {
    this.clearDropTarget();
    if (!target) return;
    const editor = target.closest(".cm-editor");
    if (editor) {
      editor.classList.add("file-drop-target");
      const activeFilePath = this.deps.activeFilePath();
      if (activeFilePath && isTypstDocumentPath(activeFilePath)) {
        moveImageDropCaret(this.deps.editor(), point);
      }
      return;
    }
    if (editorOnly) return;
    const explorer = target.closest("#workspace-explorer-tree");
    if (!explorer) return;
    const item = target.closest<HTMLElement>(".explorer-item-target");
    (item ?? explorer).classList.add("file-drop-target");
  }

  private clearDropTarget(): void {
    document.querySelectorAll(".file-drop-target").forEach(element => element.classList.remove("file-drop-target"));
  }
}

export function explorerDropRelativeDirectory(workspaceRoot: string, target: Element): string | null {
  const explorer = target.closest("#workspace-explorer-tree");
  if (!explorer) return null;
  const item = target.closest<HTMLElement>(".explorer-item-target");
  if (!item?.dataset.path) return "";
  return explorerDropRelativeDirectoryForEntry(
    workspaceRoot,
    item.dataset.path,
    item.dataset.isDir === "true",
  );
}

export function explorerDropRelativeDirectoryForEntry(
  workspaceRoot: string,
  entryPath: string,
  isDirectory: boolean,
): string | null {
  const relative = relativeFilePath(workspaceRoot, entryPath);
  if (relative === null) return null;
  if (isDirectory) return relative.replace(/\\/g, "/");
  const parts = relative.replace(/\\/g, "/").split("/");
  parts.pop();
  return parts.join("/");
}
