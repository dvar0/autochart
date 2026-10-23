// The browser version: the same app with the engine in a web worker.
//   npm run web:dev    serves it on http://127.0.0.1:5174/web.html, with your
//                      installed models at /models/ (AUTOCHART_MODELS_DIR to change)
//   npm run web:build  writes dist-web/; set VITE_AUTOCHART_MODELS_URL to the model host
// The page must be cross-origin isolated (COOP + COEP headers) for the
// multithreaded WebAssembly runtime; the host has to send the same headers.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The dev server's prebundled onnxruntime-web can't find its WebAssembly, so
// dev serves it at /ort/; a build bundles it as an asset.
const ORT_DIST = path.resolve("node_modules/onnxruntime-web/dist");
const MODELS_DIR = path.resolve(process.env.AUTOCHART_MODELS_DIR || path.join(os.homedir(), ".local/share/autochart/models"));

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const TYPES = { ".json": "application/json", ".mjs": "text/javascript", ".wasm": "application/wasm" };

function serveFolder(prefix, base) {
  return (req, res, next) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(prefix)) return next();
    const file = path.resolve(base, "." + path.posix.normalize("/" + decodeURIComponent(url.pathname.slice(prefix.length))));
    if (!file.startsWith(base + path.sep)) return next();
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        ...ISOLATION_HEADERS,
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
        "Content-Length": stat.size,
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    });
  };
}

function autochartWeb() {
  return {
    name: "autochart-web",
    configureServer(server) {
      server.middlewares.use(serveFolder("/models/", MODELS_DIR));
      server.middlewares.use(serveFolder("/ort/", ORT_DIST));
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveFolder("/models/", MODELS_DIR));
    },
    transformIndexHtml(html, ctx) {
      if (!ctx.server) return html;
      return html.replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:* ws://localhost:*");
    },
  };
}

export default defineConfig({
  plugins: [react(), autochartWeb()],
  base: "./",
  resolve: {
    alias: {
      "@autochart/chart-writer": path.resolve("shared/chartWriter.js"),
    },
  },
  worker: { format: "es" },
  build: {
    outDir: "dist-web",
    target: "es2022",
    rollupOptions: { input: { web: path.resolve("web.html") } },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    headers: ISOLATION_HEADERS,
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    headers: ISOLATION_HEADERS,
  },
});
