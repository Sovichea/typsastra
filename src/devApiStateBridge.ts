import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let installed = false;

/**
 * Answers the developer API's `GET /state` requests with a live snapshot of
 * the workspace. The bridge is installed only in development builds.
 */
export function installDevApiStateBridge(getState: () => unknown): void {
  const environment = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
  if (environment?.DEV !== true) return;
  if (installed) return;
  installed = true;
  void listen<{ requestId?: number }>("typsastra-dev-api-state-request", async event => {
    const requestId = event.payload?.requestId;
    if (typeof requestId !== "number") return;
    let state: unknown;
    try {
      state = getState();
    } catch (error) {
      state = { error: String(error) };
    }
    await invoke("dev_api_state_response", { requestId, state }).catch(() => {});
  }).catch(error => {
    console.warn("Failed to install the developer API state bridge:", error);
  });
}
