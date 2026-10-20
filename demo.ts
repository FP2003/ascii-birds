import { SkyEngine, type RaptorKind, type RaptorSpec, type Theme } from "./src";

// ?raptors=eagle,hawk,falcon,owl — first is biggest, the rest step down. No param: the default mixed sky.
const kinds = new URLSearchParams(location.search).get("raptors")?.split(",").filter(Boolean) as RaptorKind[] | undefined;
const raptors: RaptorSpec[] | undefined = kinds?.map((kind, i) => ({ kind, size: 1 - i * 0.1 }));

const engine = new SkyEngine(document.querySelector("canvas")!, raptors);

// Theme: the inline script in index.html picks the initial one (saved choice, else the OS preference).
const root = document.documentElement;
const toggle = document.querySelector<HTMLButtonElement>(".theme-toggle")!;
function applyTheme(theme: Theme) {
  root.dataset.theme = theme;
  engine.setTheme(theme);
  const next = theme === "dark" ? "light" : "dark";
  toggle.textContent = theme === "dark" ? "[ light ]" : "[ dark ]";
  toggle.setAttribute("aria-label", `Switch to ${next} mode`);
}
applyTheme(root.dataset.theme === "light" ? "light" : "dark");
// The engine scares birds on any window pointerdown; a click on the toggle shouldn't.
toggle.addEventListener("pointerdown", (e) => e.stopPropagation());
toggle.addEventListener("click", () => {
  const theme: Theme = root.dataset.theme === "light" ? "dark" : "light";
  applyTheme(theme);
  try {
    localStorage.setItem("ascii-birds-theme", theme);
  } catch {}
});
