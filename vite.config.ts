import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig({
  base: "./",
  plugins: [react(), VitePWA({
    registerType: "autoUpdate",
    injectRegister: false,
    manifest: {
      name: "경찰시험 OX",
      short_name: "경찰 OX",
      lang: "ko",
      id: "./",
      start_url: "./?mode=real",
      scope: "./",
      display: "standalone",
      theme_color: "#174e43",
      background_color: "#f5f3ed",
      icons: [
        { src: "icons/ox-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "icons/ox-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    },
    workbox: {
      skipWaiting: true,
      clientsClaim: true,
      globPatterns: ["**/*.{js,css,html,png,webmanifest}"],
      cleanupOutdatedCaches: true,
      navigateFallback: "index.html",
      // Only precache build assets; no runtime caching of datasets or external URLs.
      runtimeCaching: [],
    },
  })],
});
