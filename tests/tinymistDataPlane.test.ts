import { describe, expect, test } from "bun:test";
import { tinymistDataPlanePositionText } from "../src/preview/tinymistDataPlane";

const bytes = (value: string) => new TextEncoder().encode(value).buffer;

describe("Tinymist preview data plane", () => {
  test("accepts binary jump frames", async () => {
    expect(await tinymistDataPlanePositionText(bytes("jump,3 56.69 98.25")))
      .toBe("jump,3 56.69 98.25");
  });

  test("ignores binary document frames", async () => {
    expect(await tinymistDataPlanePositionText(bytes("new,font and vector payload"))).toBeNull();
    expect(await tinymistDataPlanePositionText(bytes("diff-v1,binary payload"))).toBeNull();
  });
});
