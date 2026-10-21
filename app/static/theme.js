// Colour theme: "system" (follow the OS), "light" or "dark". Loaded in <head>
// so the page never paints in the wrong theme; the top bar's menu (ux.js) sets it.
"use strict";
(function () {
  const KEY = "tw_theme";
  const ORDER = ["system", "light", "dark"];
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  let choice = "system";
  try { choice = localStorage.getItem(KEY) || "system"; } catch { /* private mode */ }
  if (!ORDER.includes(choice)) choice = "system";

  // what the computer asks for, whatever is pinned
  const system = () => (media && media.matches ? "dark" : "light");

  function effective() {
    return choice === "system" ? system() : choice;
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

  if (media && media.addEventListener) media.addEventListener("change", () => apply());
  window.TwTheme = { get: () => choice, set, effective, system };
  apply();
})();
