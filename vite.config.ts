import { defineConfig } from "vite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default defineConfig({
  clearScreen: false,
  plugins: [{
    name: "local-pdf-assets",
    generateBundle() {
      for (const folder of ["cmaps", "standard_fonts", "wasm"]) {
        const directory = new URL(`./node_modules/pdfjs-dist/${folder}/`, import.meta.url);
        for (const name of readdirSync(directory)) {
          this.emitFile({ type: "asset", fileName: `assets/pdfjs/${folder}/${name}`,
            source: readFileSync(fileURLToPath(new URL(name, directory))) });
        }
      }
    },
  }],
  // Rust build output holds locked DLLs on Windows; watching it crashes Vite with EBUSY.
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2022",
    // Tauri embeds the whole dist folder in the app binary and the APK; the
    // source maps alone are several times the size of the code. Keep them for
    // the browser build and for debug app builds.
    sourcemap:
      !process.env.TAURI_ENV_PLATFORM || process.env.TAURI_ENV_DEBUG === "true",
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Language packs other than Markdown stay in their lazy chunks
          // (see src/editor/syntax.ts); only the core is bundled up front.
          if (/\/node_modules\/@codemirror\/lang-(?!markdown\/)/.test(id) ||
              /\/node_modules\/@codemirror\/legacy-modes\//.test(id) ||
              /\/node_modules\/@lezer\/(?!common|lr|highlight|markdown)/.test(id))
            return;
          if (/\/node_modules\/(@codemirror|@lezer)\//.test(id))
            return "editor";
          if (/\/node_modules\/(marked|dompurify)\//.test(id))
            return "markdown";
        },
      },
    },
  },
});
