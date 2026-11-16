import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The web app is bundled by Vite; the server runs its TypeScript natively and needs no build.
// JSX goes through Vite's built-in Oxc transform, so no framework preset is needed.
export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  publicDir: false,
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "preact",
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    target: "es2023",
    sourcemap: true,
  },
});
