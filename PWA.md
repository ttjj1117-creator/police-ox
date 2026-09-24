# Minimal PWA

Production builds generate a manifest and Workbox service worker via
`vite-plugin-pwa`. Development does not register a worker. Relative URLs keep
the manifest, start URL and worker scope inside `/police-ox/` on GitHub Pages.

Only built HTML, JS, CSS, icons and the manifest are precached. There is no
runtime cache for imported JSON or external evidence URLs, and no service
worker access to application IndexedDB. Workbox removes obsolete precache
entries on activation.

Registration checks for updates on startup, return to the foreground and
hourly while open. New workers activate automatically; no controller-change
handler reloads the page. Already-open UI continues until normal reload or
reopening. Offline availability requires a successful initial online install.

Validation:

```
npm test
npm run build
npm run test:e2e
node scripts/check-pwa.mjs
```

The last command serves `dist` under `/police-ox/` with an isolated Chromium
profile and checks manifest scope/icons, offline real/demo navigation, static
cache contents, and worker update without reloading the document.

On Android Chrome, open the deployed HTTPS site and choose the browser menu's
Install app (or Add to Home screen, then Install). Verify standalone launch,
offline reopening and persistence of imported questions and learning records.
Storage remains local to the device/browser and origin; installation does not
sync desktop data. Keep using the existing JSON backup/restore feature.
