/// <reference types="vite/client" />
// Keep registration relative to the document so Pages never controls the host root.
// Updating the worker must not reload a tab with an active learning session.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const base = new URL("./", document.baseURI);
    navigator.serviceWorker.register(new URL("sw.js", base), {
      scope: base.pathname,
      updateViaCache: "none",
    }).then((registration) => {
      const update = () => {
        if (navigator.onLine) void registration.update().catch(() => {});
      };
      update();
      window.setInterval(update, 60 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") update();
      });
    }).catch(() => {
      // A failed offline installation must not block the normal online app.
    });
  });
}
