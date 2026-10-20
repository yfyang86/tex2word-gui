// Build config for the embedded TikZ editor. scripts/build_tikz_editor.sh copies
// this folder to apps/embed inside a checkout of DominikPeters/tikz-editor and
// builds it; it mirrors apps/web/vite.config.ts with a relative base so the
// bundle can be served from any path (tex2word-web uses /static/vendor/tikz-editor/).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const root = path.resolve(__dirname, "../..");

export default defineConfig({
  base: "./",
  plugins: [react()],
  publicDir: path.resolve(root, "packages/app/public"),
  define: {
    "import.meta.env.TIKZ_EDITOR_VERSION": JSON.stringify(process.env.TIKZ_EDITOR_VERSION ?? "0.0.0")
  },
  worker: {
    format: "es",
    rollupOptions: { output: { generatedCode: "es2015" } }
  },
  build: {
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      external: ["node:fs/promises"],
      output: {
        manualChunks: (id) => (id.includes("/packages/core/src/text/tex/fonts/data/computer-modern-ot1.generated.") ? "tex-fonts" : undefined)
      }
    }
  },
  optimizeDeps: { exclude: ["mathlive"] },
  resolve: {
    alias: {
      // The store is not a public export of @tikz-editor/app; the bridge reads
      // and replaces the active document through it. Same file as the app's
      // own relative imports, so it is one module instance.
      "@tikz-editor/app/store/store": path.resolve(root, "packages/app/src/store/store.ts"),
      "@tikz-editor/app/settings/useSettingsStore": path.resolve(root, "packages/app/src/settings/useSettingsStore.ts"),
      "@tikz-editor/core": path.resolve(root, "packages/core/src"),
      "@tikz-editor/lang-tikz": path.resolve(root, "packages/lang-tikz/src/index.ts"),
      "@tikz-editor/lezer-tex": path.resolve(root, "packages/lezer-tex/src/index.ts"),
      "@tikz-editor/lezer-tikz": path.resolve(root, "packages/lezer-tikz/src/index.ts")
    }
  }
});
