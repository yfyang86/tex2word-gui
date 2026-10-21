// Colour theme: "system" (follow the OS), "light" or "dark". Loaded in <head>
// so the page never paints in the wrong theme; the top bar's button cycles it.
"use strict";
(function () {
  const KEY = "tw_theme";
  const ORDER = ["system", "light", "dark"];
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  let choice = "system";
  try { choice = localStorage.getItem(KEY) || "system"; } catch { /* private mode */ }
  if (!ORDER.includes(choice)) choice = "system";

  function effective() {
    if (choice === "system") return media && media.matches ? "dark" : "light";
    return choice;
  }

  function apply() {
    const root = document.documentElement;
    if (choice === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
    root.dataset.themeEffective = effective();
    document.dispatchEvent(new CustomEvent("tw:theme", { detail: { choice, effective: effective() } }));
  }

  function set(next) {
    choice = ORDER.includes(next) ? next : "system";
    try { localStorage.setItem(KEY, choice); } catch { /* private mode */ }
    apply();
  }

  const cycle = () => set(ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]);
  if (media && media.addEventListener) media.addEventListener("change", () => { if (choice === "system") apply(); });
  window.TwTheme = { get: () => choice, set, cycle, effective };
  apply();
})();
