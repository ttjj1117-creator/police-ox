import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { deploymentBase, staticPwaPlugin } from "./build/pwa.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    base: deploymentBase(
      process.env.VITE_BASE_PATH || env.VITE_BASE_PATH || "/",
    ),
    plugins: [react(), staticPwaPlugin()],
    // The local explanation preview imports actual source questions and is never published.
    build: { rollupOptions: { input: { main: "index.html" } } },
  };
});
