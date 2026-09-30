/* Tema claro/escuro compartilhado (jogo + ADM).
   A troca acontece com um círculo que nasce do próprio botão e cobre a
   tela toda (View Transitions API). Navegadores sem suporte trocam direto.
   O botão continua fixo e nunca se move. */

const KEY = "shortRankTheme";

export function getPreferredTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "dark";
}

export function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  document.body?.setAttribute("data-theme", next);
  try { localStorage.setItem(KEY, next); } catch {}

  const button = document.querySelector("#themeToggle");
  if (button) {
    const isLight = next === "light";
    button.setAttribute("aria-pressed", isLight ? "true" : "false");
    button.setAttribute("title", isLight ? "Usar modo escuro" : "Usar modo claro");
  }

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute("content", next === "light" ? "#dff7fd" : "#06202c");
  return next;
}

let switching = false;

export function switchTheme(originEl) {
  if (switching) return;
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  if (!document.startViewTransition || reduce) {
    applyTheme(next);
    return;
  }

  const r = originEl?.getBoundingClientRect?.() || { left: innerWidth - 40, top: 30, width: 0, height: 0 };
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 8;

  switching = true;
  const html = document.documentElement;
  html.classList.add("theme-switching");
  html.style.setProperty("--theme-x", `${x}px`);
  html.style.setProperty("--theme-y", `${y}px`);

  let transition;
  try {
    transition = document.startViewTransition(() => { applyTheme(next); });
  } catch {
    applyTheme(next);
    html.classList.remove("theme-switching");
    switching = false;
    return;
  }

  transition.ready.then(() => {
    html.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 720, easing: "cubic-bezier(.62,0,.24,1)", pseudoElement: "::view-transition-new(root)" }
    );
  }).catch(() => {});

  transition.finished.finally(() => {
    html.classList.remove("theme-switching");
    switching = false;
  });
}

export function initTheme() {
  applyTheme(getPreferredTheme());
  document.querySelector("#themeToggle")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    switchTheme(event.currentTarget);
  });
}
