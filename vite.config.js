import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: "autochart-dev-csp",
      transformIndexHtml(html) {
        if (command !== "serve") return html;
        return html.replace(
          "connect-src 'self'",
          "connect-src 'self' ws://127.0.0.1:* ws://localhost:*"
        );
      },
    },
  ],
  base: "./",
  resolve: {
    alias: {
      "@autochart/chart-writer": path.resolve("shared/chartWriter.cjs"),
    },
  },
  optimizeDeps: {
    include: ["@autochart/chart-writer"],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
}));
