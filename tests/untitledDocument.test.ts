import { describe, expect, test } from "bun:test";
import {
  createUntitledTab,
  nextUntitledTitle,
} from "../src/editor/untitledDocument";
import {
  isUntitledDocumentPath,
  untitledDocumentPath,
} from "../src/platform/paths";
import {
  canRecoverTab,
  recoveryDocumentId,
  recoveryDocumentIdForTab,
  untitledIdFromRecoveryDocumentId,
} from "../src/recovery/recoveryIdentity";

describe("untitled documents", () => {
  test("uses a pathless tab identity that cannot collide with real files", () => {
    const tab = createUntitledTab({ id: "abc", title: "Untitled 1" });
    expect(tab.path).toBe(untitledDocumentPath("abc"));
    expect(isUntitledDocumentPath(tab.path)).toBe(true);
    expect(tab.untitled).toBe(true);
    expect(tab.untitledId).toBe("abc");
    expect(tab.title).toBe("Untitled 1");
    expect(tab.contentLoaded).toBe(true);
    expect(tab.isDirty).toBe(true);
    expect(tab.previewDisabled).toBe(true);
    expect(tab.temporary).toBe(false);
  });

  test("allocates the next free untitled title", () => {
    const first = createUntitledTab({ id: "a", title: "Untitled 1" });
    const second = createUntitledTab({ id: "b", title: "Untitled 3" });
    expect(nextUntitledTitle([first, second])).toBe("Untitled 2");
    expect(nextUntitledTitle([])).toBe("Untitled 1");
  });

  test("recovers pathless buffers without a file revision", () => {
    const tab = createUntitledTab({ id: "abc", title: "Untitled 1" });
    expect(canRecoverTab(tab)).toBe(true);
    const id = recoveryDocumentIdForTab("C:/project", tab);
    expect(id).toBe("untitled:abc");
    expect(untitledIdFromRecoveryDocumentId(id)).toBe("abc");
    expect(untitledIdFromRecoveryDocumentId("file:C:/project::C:/project/main.typ")).toBeNull();
    expect(recoveryDocumentIdForTab("C:/other", tab)).toBe(id);
  });

  test("keeps a file recovery identity for saved tabs", () => {
    const tab = createUntitledTab({ id: "abc", title: "Untitled 1" });
    tab.path = "C:/project/chapter.typ";
    tab.untitled = false;
    tab.untitledId = undefined;
    expect(recoveryDocumentIdForTab("C:/project", tab))
      .toBe(recoveryDocumentId("C:/project", "C:/project/chapter.typ"));
  });
});
