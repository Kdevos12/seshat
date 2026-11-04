import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

// The page is built to plain static files that the local server serves: no CDN, no font or script from elsewhere.
export default defineConfig({
  root: here,
  base: "/",
  build: {
    outDir: join(here, "..", "static"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
  },
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
});
