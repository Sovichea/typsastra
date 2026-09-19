import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const PDFJS_WASM_ROUTE = "/pdfjs-wasm/";
const PDFJS_WASM_DIRECTORY = resolve("node_modules/pdfjs-dist/wasm");

function pdfjsWasmAssets(): Plugin {
  const assetNames = readdirSync(PDFJS_WASM_DIRECTORY).filter((name) =>
    /\.(?:js|wasm)$/u.test(name)
  );

  return {
    name: "typsastra-pdfjs-wasm-assets",
    configureServer(server) {
      server.middlewares.use(PDFJS_WASM_ROUTE, (request, response, next) => {
        const requestedName = decodeURIComponent((request.url ?? "").split(/[?#]/u, 1)[0])
          .replace(/^\/+|\/+$/gu, "");
        if (!assetNames.includes(requestedName)) {
          next();
          return;
        }
        response.setHeader(
          "Content-Type",
          requestedName.endsWith(".wasm") ? "application/wasm" : "text/javascript"
        );
        response.end(readFileSync(resolve(PDFJS_WASM_DIRECTORY, requestedName)));
      });
    },
    generateBundle() {
      for (const assetName of assetNames) {
        this.emitFile({
          type: "asset",
          fileName: `pdfjs-wasm/${assetName}`,
          source: readFileSync(resolve(PDFJS_WASM_DIRECTORY, assetName))
        });
      }
    }
  };
}

export default defineConfig({
  plugins: [pdfjsWasmAssets()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      // The Rust backend is compiled by cargo; watching its target directory
      // throws EBUSY on Windows when cargo holds a lock on a dependency DLL.
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_PLATFORM == 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/@uiw/codemirror-themes")) return "editor-themes";
          if (id.includes("node_modules/@codemirror") || id.includes("node_modules/@lezer")) return "editor-engine";
          if (id.includes("node_modules/@tauri-apps")) return "tauri-runtime";
        }
      }
    }
  },
});
