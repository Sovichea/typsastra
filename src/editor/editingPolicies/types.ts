export type EditingDirection = "backward" | "forward";

export type EditingRange = {
  from: number;
  to: number;
};

export type CodePointRange = {
  /** Inclusive Unicode scalar value. */
  from: number;
  /** Exclusive Unicode scalar value. */
  to: number;
};

export const SCRIPT_EDITING_POLICY_CONTRACT_VERSION = 1 as const;

export interface ScriptEditingPolicy {
  readonly contractVersion: typeof SCRIPT_EDITING_POLICY_CONTRACT_VERSION;
  readonly id: string;
  readonly scripts: readonly string[];
  readonly codePointRanges: readonly CodePointRange[];
  readonly editorExtensions?: readonly Extension[];

  shouldMergeBoundary(text: string, boundary: number): boolean;
  backwardDeletionRange(text: string, offset: number): EditingRange | null;
  forwardDeletionRange(text: string, offset: number, nextBoundary: number): EditingRange | null;
  movementBoundary?(
    text: string,
    offset: number,
    direction: EditingDirection,
    unicodeBoundary: number
  ): number | null;
  selectionBoundary?(
    text: string,
    offset: number,
    direction: EditingDirection,
    unicodeBoundary: number
  ): number | null;
  temporaryBoundary?(state: EditorState): number | null;
  incompleteCompositionRange?(state: EditorState): EditingRange | null;
}
import type { EditorState, Extension } from "@codemirror/state";
