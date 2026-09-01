import { mount } from "./ui/app";

const root = document.getElementById("app");
if (root) {
  void mount(root);
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    // Resolved against the document URL so the app also works when it is
    // deployed under a subpath (GitHub Pages and friends).
    void navigator.serviceWorker.register("./sw.js", { scope: "./" });
  });
}
