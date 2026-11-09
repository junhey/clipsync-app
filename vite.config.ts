/// <reference types="vitest/config" />
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Serves the two catalog files while developing, and copies them into `dist`
 * on build. They stay out of `src/` so the bundle does not embed snippet text.
 */
function catalogJsonPlugin(): Plugin {
  const files = [
    { url: "/catalog-public.json", name: "public.json" },
    { url: "/catalog-private.json", name: "private.json" },
  ];
  let root = "";
  let outDir = "";
  return {
    name: "catalog-json",
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0];
        const hit = files.find((file) => file.url === pathname);
        if (req.method !== "GET" || !hit) {
          next();
          return;
        }
        try {
          const body = readFileSync(path.resolve(root, "catalog", hit.name));
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "missing catalog" }));
        }
      });
    },
    writeBundle() {
      mkdirSync(outDir, { recursive: true });
      for (const file of files) {
        copyFileSync(
          path.resolve(root, "catalog", file.name),
          path.resolve(outDir, file.url.slice(1))
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), catalogJsonPlugin()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2021", "chrome105", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
