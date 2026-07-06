# Live Preview DOM Interception

Typstry uses Tinymist for live Typst preview, but the docked preview is not mounted as a plain `iframe.src = http://127.0.0.1:<port>` page. Typstry intercepts the preview HTML and remounts it into an accessible iframe so the app can inspect the rendered DOM and refine inverse sync, especially for Khmer text where raw source positions from Tinymist can be too coarse.

## Why this exists

Tinymist inverse sync reports a source URI and position. That is useful for ordinary text, but it is not precise enough for Typstry's Khmer workflow because the rendered text can come from generated/prepared source or can map ambiguously inside continuous Khmer text. Typstry therefore needs access to the preview DOM click target and nearby rendered text so it can map the clicked rendered location back to the best CodeMirror source offset.

Directly mounting Tinymist's preview URL keeps Tinymist's own page working, but it makes DOM access unreliable or unavailable in production WebView contexts. The intercepted preview path keeps the preview same-app accessible while preserving Tinymist rendering.

## Failure chain fixed in release builds

The release failure was not one bug. It was a chain of browser/runtime constraints triggered by moving Tinymist's page into an intercepted iframe.

1. Direct `srcdoc`/`document.write` mounting was insufficient in release WebView2.

   Inline module scripts from Tinymist did not reliably execute under the production CSP/runtime. The preview pane could be visible and contain DOM, but Tinymist's renderer did not fully start.

2. Moving the preview HTML to a `blob:` iframe made the DOM accessible, but broke relative WASM loading.

   Tinymist's renderer script expects to load `typst_ts_renderer_bg.wasm` relative to its preview server. Once the script ran from a `blob:` URL, relative WASM lookup no longer resolved against `http://127.0.0.1:<port>`.

3. Fetching the WASM directly from the blob iframe was blocked by browser policy.

   Typstry now fetches Tinymist's WASM through a loopback-only Tauri command and passes it into the intercepted page.

4. Tinymist's generated WASM loader converted the module to a `data:application/wasm;base64,...` URL and called `fetch(...)`.

   WebView2 rejected that fetch inside the intercepted context. Typstry now shims `window.fetch` inside the preview iframe for that specific `data:application/wasm` case and returns a synthetic `Response` from the already-loaded bytes.

5. Static rendering worked, but live updates failed because the WebSocket was opened from the wrong origin.

   The intercepted iframe runs under `blob:http://tauri.localhost/...`, while Tinymist's data plane expects loopback-origin clients. Tinymist closed the socket with code `1006`. Typstry now starts a loopback-only Rust WebSocket proxy. The iframe connects to the proxy, and the proxy connects to Tinymist with a loopback origin.

## Current architecture

The docked intercepted preview path is:

1. Start Tinymist preview through LSP.
2. Request Tinymist preview HTML with `tinymist.getResources`.
3. Fetch Tinymist renderer WASM through Tauri's loopback-only resource command.
4. Start Typstry's loopback-only WebSocket proxy for Tinymist's data-plane URL.
5. Externalize Tinymist inline scripts as blob scripts so production CSP can execute them consistently.
6. Patch Tinymist's WASM loader to use the fetched WASM payload.
7. Patch WebSocket construction so live update traffic goes through Typstry's proxy.
8. Mount the resulting HTML as a blob iframe.
9. Install DOM click interception for inverse sync refinement.

Undocked preview intentionally opens Tinymist's direct preview URL. That is useful for viewing, but it does not provide Typstry's DOM-based inverse sync refinement.

## Security boundaries

The preview bridges are intentionally narrow:

- `fetch_loopback_resource` accepts only `http://127.0.0.1:<port>`, `http://localhost:<port>`, or `http://[::1]:<port>` style preview resources.
- `start_preview_ws_proxy` accepts only loopback `ws://...:<port>` targets.
- Both are for Tinymist preview resources only; they are not general network proxy APIs.

## Debug logs that indicate success

With developer mode enabled, a healthy intercepted live preview should show logs like:

```text
Fetched preview WASM (...) from http://127.0.0.1:<port>/typst_ts_renderer_bg.wasm
fetch synthesized WASM response: ... bytes
Started preview WebSocket proxy: ws://127.0.0.1:<proxy-port> -> ws://127.0.0.1:<tinymist-port>
WebSocket requested: ws://127.0.0.1:<tinymist-port>/ -> ws://127.0.0.1:<proxy-port>/
WebSocket open: ws://127.0.0.1:<proxy-port>/
Preview DOM interception installed for blob:http://tauri.localhost/...
```

Repeated `WebSocket close ... code=1006` means the live data plane is still failing. A blank docked pane with a visible direct undocked preview usually means the intercepted HTML mounted but one of the iframe runtime patches failed.

## Files involved

- `src/preview/previewFrame.ts`: owns intercepted iframe mounting, script externalization, WASM/fetch/WebSocket patches, DOM click interception, and developer-mode preview logs.
- `src/preview/previewSyncController.ts`: stores recent preview click state and refines inverse sync.
- `src/compiler/lsp.ts`: starts Tinymist preview tasks and normalizes preview/data-plane URLs.
- `src-tauri/src/lib.rs`: owns loopback-only preview resource fetch and WebSocket proxy commands.
- `src-tauri/tauri.conf.json`: CSP rules required for blob iframe, WASM, WebSocket, and preview resources.

