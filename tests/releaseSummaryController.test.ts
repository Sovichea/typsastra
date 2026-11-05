import { describe, expect, mock, test } from "bun:test";

const storage = new Map<string, string>();
const localStorageStub = {
  get length() {
    return storage.size;
  },
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, String(value));
  },
  key: (index: number) => [...storage.keys()][index] ?? null,
  removeItem: (key: string) => {
    storage.delete(key);
  },
};

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { localStorage: localStorageStub },
});
mock.module("@tauri-apps/api/app", () => ({
  getVersion: async () => "0.10.1",
}));
mock.module("@tauri-apps/plugin-shell", () => ({
  open: async () => {},
}));

const { ReleaseSummaryController } = await import("../src/ui/releaseSummaryController");

describe("release summary controller", () => {
  test("records a fresh install without opening the release summary", async () => {
    storage.clear();

    await new ReleaseSummaryController().showIfNeeded();

    expect(storage.get("typsastra:release-summary-installed")).toBe("1");
    expect(storage.get("typsastra:release-summary-seen:0.10.1")).toBe("1");
  });
});
