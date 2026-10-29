import { EditorView } from "@codemirror/view";
import { filePathKey } from "../platform/paths";
import type { PreviewDocumentPosition } from "../compiler/lsp";
import type { DocumentHeading, DocumentOutlineController } from "../outline/documentOutline";
import type { EditorTab } from "../editor/editorTab";
import type { PreviewFrame } from "../preview/previewFrame";
import type { PreviewSyncController } from "../preview/previewSyncController";

export interface OutlineNavigationDependencies {
  activeTab(): EditorTab | null;
  activeFilePath(): string | null;
  activeMode(): "CODE" | "WYSIWYM";
  promoteToPermanent(tab: EditorTab): Promise<void> | void;
  loadFile(path: string, options: { focusEditor?: boolean }): Promise<void>;
  activeTabContentLoaded(): boolean;
  switchToCodeMode(): void;
  outline(): DocumentOutlineController;
  previewSync(): PreviewSyncController;
  previewFrame(): PreviewFrame;
  editor(): EditorView;
}

/** Owns editor/preview navigation when selecting a document outline heading. */
export class OutlineNavigationController {
  private previewRevealGeneration = 0;

  constructor(private readonly deps: OutlineNavigationDependencies) {}

  async navigate(heading: DocumentHeading): Promise<void> {
    const activeTab = this.deps.activeTab();
    if (activeTab?.temporary) void this.deps.promoteToPermanent(activeTab);

    const activePath = this.deps.activeFilePath();
    if (!activePath || filePathKey(heading.filePath) !== filePathKey(activePath)) {
      await this.deps.loadFile(heading.filePath, { focusEditor: false });
    }
    if (!this.deps.activeTabContentLoaded()) return;
    if (this.deps.activeMode() === "WYSIWYM") this.deps.switchToCodeMode();

    const outline = this.deps.outline();
    const currentHeading = outline.findHeading(heading.id) ?? heading;
    const editor = this.deps.editor();
    const cursor = Math.max(0, Math.min(currentHeading.textFrom, editor.state.doc.length));
    this.deps.previewSync().clearForward();
    editor.dispatch({
      selection: { anchor: cursor },
      effects: EditorView.scrollIntoView(cursor, { y: "start", yMargin: 28 }),
    });
    outline.setCursorPosition(cursor, this.deps.activeFilePath());
    this.revealInPreview(currentHeading);
    outline.waitForPreviewPosition(currentHeading);
  }

  revealInPreview(heading: DocumentHeading): void {
    if (heading.previewPosition) {
      this.revealPreviewPosition(heading.previewPosition);
      return;
    }
    if (heading.previewBookmarkIndex !== undefined) {
      void this.deps.previewFrame().scrollToOutlineBookmark(heading.previewBookmarkIndex);
      return;
    }
    const previewPosition = this.deps.outline().previewPositionAt(heading.textFrom);
    if (previewPosition) this.revealPreviewPosition(previewPosition);
  }

  private revealPreviewPosition(position: PreviewDocumentPosition): void {
    const generation = ++this.previewRevealGeneration;
    const attempt = (remaining: number) => {
      const frame = this.deps.previewFrame();
      void frame.revealDocumentPosition(position, { ripple: true }).then(scrolled => {
        if (generation !== this.previewRevealGeneration || scrolled) return;
        if (remaining > 0) {
          window.setTimeout(() => attempt(remaining - 1), 60);
        } else {
          frame.scrollToPage(position.page_no);
        }
      });
    };
    attempt(4);
  }
}
