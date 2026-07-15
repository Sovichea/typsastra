export type RuntimeTitlebarMode = "native-macos" | "custom";

export interface RuntimeTitlebarState {
  mode: RuntimeTitlebarMode;
  simulated: boolean;
}

export interface RuntimeTitlebarInput {
  userAgent?: string;
  platform?: string;
  search?: string;
  dev?: boolean;
}

function hasMacPlatform(input: RuntimeTitlebarInput): boolean {
  return /Mac/i.test(input.platform ?? "")
    || /Macintosh|Mac OS X/i.test(input.userAgent ?? "");
}

export function resolveRuntimeTitlebar(input: RuntimeTitlebarInput): RuntimeTitlebarState {
  const query = new URLSearchParams((input.search ?? "").replace(/^\?/, ""));
  const simulated = input.dev === true && query.get("test-platform") === "macos-titlebar";

  return {
    mode: simulated || hasMacPlatform(input) ? "native-macos" : "custom",
    simulated,
  };
}

export function applyRuntimeTitlebarClasses(
  state: RuntimeTitlebarState,
  root: HTMLElement = document.documentElement,
): void {
  root.classList.toggle("platform-macos-titlebar", state.mode === "native-macos");
  root.classList.toggle("platform-custom-titlebar", state.mode === "custom");
  root.classList.toggle("macos-titlebar-simulation", state.simulated);
}
