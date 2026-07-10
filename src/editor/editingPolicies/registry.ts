import { khmerEditingPolicy } from "./khmer/policy";
import {
  SCRIPT_EDITING_POLICY_CONTRACT_VERSION,
  type CodePointRange,
  type EditingDirection,
  type EditingRange,
  type ScriptEditingPolicy
} from "./types";
import { codePointAtOffset, previousCodePointOffset, unicodeGraphemeBoundaries } from "./unicode";

export class ScriptEditingPolicyRegistry {
  private readonly policies: ScriptEditingPolicy[] = [];
  private readonly scriptOwners = new Map<string, string>();
  private readonly rangeOwners: Array<{ range: CodePointRange; policyId: string }> = [];

  register(policy: ScriptEditingPolicy): void {
    if (policy.contractVersion !== SCRIPT_EDITING_POLICY_CONTRACT_VERSION) {
      throw new Error(`Editing policy '${policy.id}' uses unsupported contract version '${policy.contractVersion}'.`);
    }
    if (!policy.id.trim()) throw new Error("Editing policy IDs cannot be empty.");
    if (this.policies.some(candidate => candidate.id === policy.id)) {
      throw new Error(`Editing policy '${policy.id}' is already registered.`);
    }
    if (policy.scripts.length === 0) {
      throw new Error(`Editing policy '${policy.id}' must own at least one ISO 15924 script.`);
    }
    for (const script of policy.scripts) {
      if (!/^[A-Z][a-z]{3}$/.test(script)) {
        throw new Error(`Editing policy '${policy.id}' has invalid ISO 15924 script '${script}'.`);
      }
      const owner = this.scriptOwners.get(script);
      if (owner) throw new Error(`Unicode script '${script}' is already owned by editing policy '${owner}'.`);
    }
    if (new Set(policy.scripts).size !== policy.scripts.length) {
      throw new Error(`Editing policy '${policy.id}' declares duplicate script ownership.`);
    }
    this.validateCodePointRanges(policy);
    this.policies.push(policy);
    for (const script of policy.scripts) this.scriptOwners.set(script, policy.id);
    for (const range of policy.codePointRanges) this.rangeOwners.push({ range: { ...range }, policyId: policy.id });
  }

  policyAt(text: string, offset: number, direction: EditingDirection): ScriptEditingPolicy | null {
    const target = direction === "backward" ? previousCodePointOffset(text, offset) : offset;
    const codePoint = codePointAtOffset(text, target);
    return codePoint === null ? null : this.policies.find(policy => ownsCodePoint(policy, codePoint)) ?? null;
  }

  boundaries(text: string, temporaryBoundary: number | null = null): EditingRange[] {
    const raw = unicodeGraphemeBoundaries(text);
    const merged: EditingRange[] = [];
    for (const boundary of raw) {
      const previous = merged[merged.length - 1];
      if (previous && this.shouldMerge(text, boundary.from)) previous.to = boundary.to;
      else merged.push({ ...boundary });
    }
    return splitAtBoundary(merged, temporaryBoundary);
  }

  backwardDeletionRange(text: string, offset: number): EditingRange | null {
    const policy = this.policyAt(text, offset, "backward");
    if (offset <= 0) return null;
    const unicodeRange = { from: previousCodePointOffset(text, offset), to: offset };
    if (!policy) return unicodeRange;
    const range = policy.backwardDeletionRange(text, offset);
    return range && range.to === offset && isValidEditingRange(text, range) ? range : unicodeRange;
  }

  editorExtensions(): Extension[] {
    return this.policies.flatMap(policy => [...(policy.editorExtensions ?? [])]);
  }

  temporaryBoundary(state: EditorState): number | null {
    for (const policy of this.policies) {
      const boundary = policy.temporaryBoundary?.(state) ?? null;
      if (boundary !== null) return boundary;
    }
    return null;
  }

  incompleteComposition(state: EditorState): { policyId: string; range: EditingRange } | null {
    for (const policy of this.policies) {
      const range = policy.incompleteCompositionRange?.(state) ?? null;
      if (range !== null) return { policyId: policy.id, range };
    }
    return null;
  }

  forwardDeletionRange(text: string, offset: number, temporaryBoundary: number | null = null): EditingRange | null {
    if (offset < 0 || offset >= text.length) return null;
    const nextBoundary = this.boundaries(text, temporaryBoundary)
      .find(boundary => boundary.from <= offset && offset < boundary.to)?.to ?? text.length;
    const policy = this.policyAt(text, offset, "forward");
    const unicodeRange = nextBoundary > offset ? { from: offset, to: nextBoundary } : null;
    if (!policy || !unicodeRange) return unicodeRange;
    const range = policy.forwardDeletionRange(text, offset, nextBoundary);
    return range && range.from === offset && isValidEditingRange(text, range) ? range : unicodeRange;
  }

  movementBoundary(
    text: string,
    offset: number,
    direction: EditingDirection,
    unicodeBoundary: number,
    selection = false
  ): number {
    const policy = this.policyAt(text, offset, direction);
    const resolver = selection ? policy?.selectionBoundary : policy?.movementBoundary;
    const resolved = resolver?.(text, offset, direction, unicodeBoundary) ?? unicodeBoundary;
    return isValidTextBoundary(text, resolved) ? resolved : unicodeBoundary;
  }

  private shouldMerge(text: string, boundary: number): boolean {
    const leftOffset = previousCodePointOffset(text, boundary);
    const left = codePointAtOffset(text, leftOffset);
    const right = codePointAtOffset(text, boundary);
    if (left === null || right === null) return false;
    const leftPolicy = this.policies.find(policy => ownsCodePoint(policy, left));
    const rightPolicy = this.policies.find(policy => ownsCodePoint(policy, right));
    return leftPolicy !== undefined
      && leftPolicy === rightPolicy
      && leftPolicy.shouldMergeBoundary(text, boundary);
  }

  private validateCodePointRanges(policy: ScriptEditingPolicy): void {
    if (policy.codePointRanges.length === 0) {
      throw new Error(`Editing policy '${policy.id}' must declare at least one Unicode code-point range.`);
    }
    const ranges = [...policy.codePointRanges].sort((left, right) => left.from - right.from || left.to - right.to);
    for (let index = 0; index < ranges.length; index++) {
      const range = ranges[index];
      if (!Number.isInteger(range.from) || !Number.isInteger(range.to)
        || range.from < 0 || range.to > 0x110000 || range.from >= range.to) {
        throw new Error(`Editing policy '${policy.id}' has invalid Unicode range ${range.from}..${range.to}.`);
      }
      const previous = ranges[index - 1];
      if (previous && rangesOverlap(previous, range)) {
        throw new Error(`Editing policy '${policy.id}' has overlapping Unicode ranges.`);
      }
      const existing = this.rangeOwners.find(owner => rangesOverlap(owner.range, range));
      if (existing) {
        throw new Error(`Editing policy '${policy.id}' overlaps Unicode ownership with '${existing.policyId}'.`);
      }
    }
  }
}

function ownsCodePoint(policy: ScriptEditingPolicy, codePoint: number): boolean {
  return policy.codePointRanges.some(range => codePoint >= range.from && codePoint < range.to);
}

function rangesOverlap(left: CodePointRange, right: CodePointRange): boolean {
  return left.from < right.to && right.from < left.to;
}

function isValidTextBoundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
  if (offset === 0 || offset === text.length) return true;
  const code = text.charCodeAt(offset);
  return code < 0xDC00 || code > 0xDFFF;
}

function isValidEditingRange(text: string, range: EditingRange): boolean {
  return range.from < range.to
    && isValidTextBoundary(text, range.from)
    && isValidTextBoundary(text, range.to);
}

function splitAtBoundary(boundaries: EditingRange[], position: number | null): EditingRange[] {
  if (position === null) return boundaries;
  const result: EditingRange[] = [];
  for (const boundary of boundaries) {
    if (boundary.from < position && position < boundary.to) {
      result.push({ from: boundary.from, to: position }, { from: position, to: boundary.to });
    } else {
      result.push(boundary);
    }
  }
  return result;
}

export function createDefaultEditingPolicyRegistry(): ScriptEditingPolicyRegistry {
  const registry = new ScriptEditingPolicyRegistry();
  registry.register(khmerEditingPolicy);
  return registry;
}

export const editingPolicyRegistry = createDefaultEditingPolicyRegistry();
import type { EditorState, Extension } from "@codemirror/state";
