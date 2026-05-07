import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PORT is only required at runtime (dev server / preview). During `vite build`
// it is not used, so fall back to 3000 to avoid breaking the Render build step.
const port = Number(process.env.PORT || 3000);

const basePath = process.env.BASE_PATH || "/";

export default defineConfig({
  root: path.resolve(__dirname, "web"),
  base: basePath,
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port,
    strictPort: true,
    allowedHosts: true,
    hmr: { clientPort: 443 },
    proxy: {
      "/pdf-api": {
        target: "http://localhost:4001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port,
    allowedHosts: true,
  },
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: ["pdfjs-dist"],
  },
});
