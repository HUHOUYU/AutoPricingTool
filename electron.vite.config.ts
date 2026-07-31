import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL("./backend/electron/main/index.ts", import.meta.url)),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL("./backend/electron/preload/index.ts", import.meta.url)),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root: fileURLToPath(new URL("./frontend", import.meta.url)),
    build: {
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL("./frontend/index.html", import.meta.url)),
        },
      },
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./frontend/src", import.meta.url)),
        "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
