import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  onDisconnect,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { initTheme } from "./theme.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

/* crypto.randomUUID só existe em contexto seguro (https/localhost).
   O fallback evita que o site quebre se for aberto por http na rede local. */
function uuid() {
  if (globalThis.crypto?.randomUUID) {
    try { return crypto.randomUUID(); } catch {}
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* Relógio compartilhado.
   Cada computador tem o relógio um pouco diferente (às vezes segundos).
   Todos os horários gravados no banco (contagens, transições, cliques)
   usam o relógio do servidor do Firebase, então os dois jogadores veem
   o 3 → 2 → 1 exatamente no mesmo ritmo. */
let serverTimeOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), snap => {
  serverTimeOffset = Number(snap.val() || 0);
});
const serverNow = () => Date.now() + serverTimeOffset;

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

const ROOM_PATH = "room";
const CONFIG_PATH = "config";

const $ = (sel) => document.querySelector(sel);
const screens = [...document.querySelectorAll(".screen")];

const state = {
  user: null,
  clientId: sessionStorage.getItem("shortRankClientId") || uuid(),
  slot: sessionStorage.getItem("shortRankSlot") || null,
  photoData: "",
  editPhotoData: "",
  room: null,
  pendingPosition: null,
  toastTimer: null,
  identityReady: false,
  revealRound: null,
  revealTimer: null,
  countdownTimer: null,
  lastObservedRound: null,
  mountedMediaRound: null,
  animatedSlots: new Set(),
  burstedSlots: new Set(),
  cropTarget: null,
  cropImage: null,
  cropScale: 1,
  cropMinScale: 1,
  cropX: 0,
  cropY: 0,
  cropDragging: false,
  cropLastX: 0,
  cropLastY: 0,
  finalRevealTimer: null,
  roundTransitionRound: null,
  roundTransitionTimer: null,
  finishSuspenseRunning: false,
  finishShown: false,
  confirmPauseTimer: null,
  cursorWriteAt: 0,
  lobbyTransitionTimer: null,
  lobbyTransitionKey: null,
  editColorData: null,
  mediaPausedByUser: false,
  lastProfileChangeKey: null,
  lastReady: {},
  buttonsIntroRound: null,
  finalRenderKey: null,
  approvalReactionTimer: null,
  lockingPick: false,
  settings: {
    stageBgEnabled: true,
    stageBgBlur: 18,
    stageBgOpacity: 45,
    customCursorEnabled: true,
    positionColors: [
      "#55D98A", "#71D477", "#8FCE64", "#AEC852", "#C9BF49",
      "#D8A94A", "#E18E4D", "#E27251", "#DE5B58", "#D84C60"
    ]
  },
};

sessionStorage.setItem("shortRankClientId", state.clientId);

/* ---------------------------------------------------------------------
   Preferências locais do jogador (só neste navegador).
   - Cursor: colorido completo, ou só o nome seguindo o cursor normal.
   - Fundo com vídeo: "auto" segue o ADM; o jogador pode forçar on/off.
   --------------------------------------------------------------------- */
const localPrefs = (() => {
  const base = { cursorMode: "full", stageBg: "auto" };
  try { return { ...base, ...(JSON.parse(localStorage.getItem("shortRankPrefs") || "{}") || {}) }; } catch { return base; }
})();

function saveLocalPrefs() {
  try { localStorage.setItem("shortRankPrefs", JSON.stringify(localPrefs)); } catch {}
}

function applyLocalPrefs() {
  document.body.classList.toggle("cursor-name-only", localPrefs.cursorMode === "name");
  const panel = document.getElementById("prefsPanel");
  if (panel) {
    panel.querySelectorAll("[data-pref]").forEach(btn => {
      btn.classList.toggle("active", localPrefs[btn.dataset.pref] === btn.dataset.value);
      btn.setAttribute("aria-pressed", localPrefs[btn.dataset.pref] === btn.dataset.value ? "true" : "false");
    });
    const admBg = state.settings?.stageBgEnabled !== false;
    const note = document.getElementById("prefsBgNote");
    if (note) note.textContent = `Padrão do ADM: ${admBg ? "ligado" : "desligado"}`;
    const cursorBlock = document.getElementById("prefsCursorBlock");
    cursorBlock?.classList.toggle("is-disabled", state.settings?.customCursorEnabled === false);
  }
  if (typeof media !== "undefined") refreshStageBgMount();
}

/*
  Abas duplicadas podem copiar o sessionStorage da aba original.
  O BroadcastChannel detecta isso: se outra aba viva já estiver usando
  o mesmo clientId, esta aba recebe um novo ID e começa como novo jogador.
  Um simples F5 não cria conflito, então o jogador continua reconhecido.
*/
const identityChannel = new BroadcastChannel("short-rank-tab-identity");
let identityConflict = false;

identityChannel.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "probe" && data.clientId === state.clientId) {
    identityChannel.postMessage({
      type: "occupied",
      clientId: state.clientId,
      pageToken: window.__shortRankPageToken
    });
  }
  if (
    data.type === "occupied" &&
    data.clientId === state.clientId &&
    data.pageToken !== window.__shortRankPageToken
  ) {
    identityConflict = true;
  }
});

window.__shortRankPageToken = uuid();

async function resolveTabIdentity() {
  identityChannel.postMessage({
    type: "probe",
    clientId: state.clientId,
    pageToken: window.__shortRankPageToken
  });

  await new Promise(resolve => setTimeout(resolve, 180));

  if (identityConflict) {
    state.clientId = uuid();
    state.slot = null;
    sessionStorage.setItem("shortRankClientId", state.clientId);
    sessionStorage.removeItem("shortRankSlot");
  }

  state.identityReady = true;
}


initTheme();


function cursorName(slot) {
  return state.room?.players?.[slot]?.name || (slot === "p1" ? "Player 1" : "Player 2");
}


const PLAYER_COLORS = {
  p1: "#41E5FF",
  p2: "#FF9B42"
};

function normalizePlayerColor(color, slot = "p1") {
  const fallback = PLAYER_COLORS[slot] || PLAYER_COLORS.p1;
  return /^#[0-9A-F]{6}$/i.test(String(color || "")) ? color : fallback;
}

function playerColor(slot) {
  return normalizePlayerColor(state.room?.players?.[slot]?.color, slot);
}


const DEFAULT_POSITION_COLORS = [
  "#55D98A", "#71D477", "#8FCE64", "#AEC852", "#C9BF49",
  "#D8A94A", "#E18E4D", "#E27251", "#DE5B58", "#D84C60"
];

function normalizePositionColors(colors) {
  return Array.from({ length: 10 }, (_, i) => {
    const value = Array.isArray(colors) ? colors[i] : null;
    return /^#[0-9A-F]{6}$/i.test(String(value || ""))
      ? value
      : DEFAULT_POSITION_COLORS[i];
  });
}

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

function applyGameSettings(settings = {}) {
  const hadBg = typeof media !== "undefined" ? !!media.bg : false;
  state.settings = {
    customCursorEnabled: settings.customCursorEnabled !== false,
    positionColors: normalizePositionColors(settings.positionColors),
    stageBgEnabled: settings.stageBgEnabled !== false,
    stageBgBlur: clampNum(settings.stageBgBlur, 0, 60, 18),
    stageBgOpacity: clampNum(settings.stageBgOpacity, 5, 100, 45)
  };

  const root = document.documentElement.style;
  root.setProperty("--stage-bg-blur", `${state.settings.stageBgBlur}px`);
  root.setProperty("--stage-bg-opacity", String(state.settings.stageBgOpacity / 100));

  // Liga/desliga o vídeo de fundo na hora, sem recarregar a página.
  if (typeof media !== "undefined") {
    refreshStageBgMount(hadBg);
  }

  state.settings.positionColors.forEach((color, i) => {
    document.documentElement.style.setProperty(`--position-color-${i + 1}`, color);
  });

  applyLocalPrefs();
  document.body.classList.toggle("custom-cursor-disabled", !state.settings.customCursorEnabled);
  document.body.classList.toggle("custom-cursor-enabled", !!state.settings.customCursorEnabled);
  updateNativeCursorVisibility();
  rerenderRemoteCursors();
}

function positionColor(pos) {
  return state.settings.positionColors?.[Number(pos) - 1] || DEFAULT_POSITION_COLORS[Number(pos) - 1];
}

function updateNativeCursorVisibility() {
  const shouldReplace = !!state.slot && state.settings?.customCursorEnabled !== false;
  document.body.classList.toggle("player-joined", shouldReplace);
}

/* =====================================================================
   CURSORES SINCRONIZADOS — ancorados em elementos da interface
   ---------------------------------------------------------------------
   Antes o cursor era enviado como porcentagem da janela (x/innerWidth).
   Isso erra quando as telas têm proporções diferentes: 1080p x 4K,
   zoom 100% x 125%, com ou sem barra de favoritos, etc. — o layout não
   escala igual à janela (cards têm largura máxima, o conteúdo é
   centralizado, alturas mudam...).

   Agora cada movimento envia uma "cadeia de âncoras": o elemento exato
   debaixo do mouse (botão 3, slot 5 do ranking, card do P2...) e a
   posição relativa DENTRO dele, seguido dos elementos pais como reserva.
   O outro navegador encontra o mesmo elemento na tela dele e desenha o
   cursor na mesma posição relativa. Se aquele elemento não estiver
   visível lá (ex.: um popup que só um jogador abriu), usa o próximo pai
   da cadeia e, no pior caso, a porcentagem da janela.
   ===================================================================== */

const CURSOR_SEND_INTERVAL = 40;       // ms entre envios ao Firebase
const CURSOR_STALE_MS = 5 * 60 * 1000; // some só se ficar 5 min sem sinal
const CURSOR_SKIP_IDS = new Set(["remoteCursorLayer", "cursorP1", "cursorP2", "fxLayer", "toast"]);
const CURSOR_OVERLAY_SELECTOR = ".modal-backdrop, .remote-cursor-layer, .fx-layer, .toast, .theme-toggle";

const cursorRuntime = {
  p1: { data: null, x: null, y: null, shown: false },
  p2: { data: null, x: null, y: null, shown: false }
};

const localPointer = { x: null, y: null, inside: false };
let cursorSendTimer = null;
let cursorLastSentAt = 0;
let cursorPendingPayload = null;
let cursorLoopStarted = false;

function cursorElement(slot) {
  return slot === "p1" ? $("#cursorP1") : $("#cursorP2");
}

function anchorKeyFor(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.dataset?.anchor) return `a:${el.dataset.anchor}`;
  if (el.id && !CURSOR_SKIP_IDS.has(el.id)) return `#${el.id}`;
  if (el.dataset?.syncKey) return `s:${el.dataset.syncKey}`;
  return null;
}

function anchorCandidates(key) {
  if (typeof key !== "string" || key.length < 2) return [];
  try {
    if (key.startsWith("#")) {
      const el = document.getElementById(key.slice(1));
      return el ? [el] : [];
    }
    if (key.startsWith("a:")) return [...document.querySelectorAll(`[data-anchor="${CSS.escape(key.slice(2))}"]`)];
    if (key.startsWith("s:")) return [...document.querySelectorAll(`[data-sync-key="${CSS.escape(key.slice(2))}"]`)];
  } catch {}
  return [];
}

/* Caixa do elemento SEM transformações (usada nas cartas 3D do lobby,
   que inclinam com o mouse — a inclinação não pode deslocar o cursor). */
function layoutRect(el) {
  const parent = el.offsetParent;
  if (!parent) return el.getBoundingClientRect();
  const pr = parent.getBoundingClientRect();
  const left = pr.left + parent.clientLeft + el.offsetLeft - parent.scrollLeft;
  const top = pr.top + parent.clientTop + el.offsetTop - parent.scrollTop;
  return { left, top, width: el.offsetWidth, height: el.offsetHeight, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
}

function usableAnchorRect(el) {
  if (!el || !el.isConnected) return null;
  if (el.hasAttribute?.("data-tilt")) {
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return null;
    const lr = layoutRect(el);
    return lr.width >= 2 && lr.height >= 2 ? lr : null;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return null;
  return rect;
}

function resolveAnchor(key) {
  for (const el of anchorCandidates(key)) {
    const rect = usableAnchorRect(el);
    if (rect) return rect;
  }
  return null;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

/* Monta a cadeia de âncoras para um ponto da tela. */
function buildAnchorChain(x, y, topTarget = null) {
  const chain = [];
  const seen = new Set();

  const push = (el, allowOutside = false) => {
    const key = anchorKeyFor(el);
    if (!key || seen.has(key)) return;
    // Elementos com transform (hover que "levanta" o botão, animações de pop)
    // têm a caixa deslocada só nesta tela — usamos o pai, que não se mexe.
    if (!allowOutside && !el.hasAttribute("data-tilt")) {
      const cs = getComputedStyle(el);
      if (cs.transform !== "none" || cs.scale !== "none" || cs.translate !== "none") return;
    }
    const rect = usableAnchorRect(el);
    if (!rect) return;
    const fx = (x - rect.left) / rect.width;
    const fy = (y - rect.top) / rect.height;
    if (!allowOutside && (fx < -0.02 || fx > 1.02 || fy < -0.02 || fy > 1.02)) return;
    seen.add(key);
    chain.push({ k: key, x: round4(fx), y: round4(fy) });
  };

  const walk = (start) => {
    for (let el = start; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (chain.length >= 9) return;
      // Dentro de uma carta inclinada, os filhos estão "tortos": ancora na carta.
      const tiltHost = el.closest?.("[data-tilt].is-tilting");
      if (tiltHost && tiltHost !== el) continue;
      push(el);
    }
  };

  const top = topTarget && topTarget.nodeType === 1 ? topTarget : document.elementFromPoint(x, y);
  walk(top);

  // Debaixo de popups/overlays locais: o outro jogador talvez não os veja,
  // então também registramos o que está por baixo deles.
  if (top?.closest?.(CURSOR_OVERLAY_SELECTOR)) {
    const below = (document.elementsFromPoint?.(x, y) || [])
      .find(el => !el.closest(CURSOR_OVERLAY_SELECTOR) && el !== document.body && el !== document.documentElement);
    if (below) walk(below);
  }

  // Fora de qualquer bloco (fundo da página): usa a moldura principal,
  // que tem a mesma largura máxima nos dois monitores.
  const screen = document.querySelector(".screen.active");
  if (screen) push(screen, true);
  const shell = document.querySelector(".app-shell");
  if (shell) push(shell, true);

  return chain;
}

function resolveCursorPoint(data) {
  if (!data) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampPoint = (px, py) => ({
    x: Math.max(0, Math.min(vw - 2, px)),
    y: Math.max(0, Math.min(vh - 2, py))
  });

  const chain = Array.isArray(data.chain) ? data.chain : Object.values(data.chain || {});
  for (const link of chain) {
    const rect = resolveAnchor(link?.k);
    if (!rect) continue;
    return clampPoint(rect.left + Number(link.x || 0) * rect.width, rect.top + Number(link.y || 0) * rect.height);
  }

  const nx = Math.max(0, Math.min(1, Number(data.x || 0)));
  const ny = Math.max(0, Math.min(1, Number(data.y || 0)));
  return clampPoint(nx * vw, ny * vh);
}

function cursorShouldShow(slot) {
  if (state.settings?.customCursorEnabled === false) return false;
  if (!document.querySelector(".screen.active")) return false;

  if (slot === state.slot) {
    return localPointer.inside && localPointer.x != null && !!state.room?.players?.[slot];
  }

  const data = cursorRuntime[slot].data;
  if (!data || data.out) return false;
  if (!state.room?.players?.[slot]) return false;
  return serverNow() - Number(data.t || 0) < CURSOR_STALE_MS;
}

function paintCursorLabel(slot, data) {
  const el = cursorElement(slot);
  if (!el) return;
  const color = normalizePlayerColor(data?.color || state.room?.players?.[slot]?.color, slot);
  el.style.setProperty("--cursor-color", color, "important");
  el.classList.toggle("is-pointer", data?.kind === "pointer");
  const label = el.querySelector("b");
  const name = data?.name || cursorName(slot);
  if (label && label.textContent !== name) label.textContent = name;
}

// Mantido: outras partes do código chamam renderCursor/rerenderRemoteCursors.
function renderCursor(slot, data) {
  if (data !== undefined) cursorRuntime[slot].data = data || null;
  paintCursorLabel(slot, cursorRuntime[slot].data);
}

function rerenderRemoteCursors() {
  renderCursor("p1");
  renderCursor("p2");
}

let cursorLastFrame = performance.now();
function cursorFrame(now) {
  const dt = Math.min(64, Math.max(1, now - cursorLastFrame));
  cursorLastFrame = now;

  for (const slot of ["p1", "p2"]) {
    const el = cursorElement(slot);
    const rt = cursorRuntime[slot];
    if (!el) continue;

    if (!cursorShouldShow(slot)) {
      if (rt.shown) {
        el.classList.add("hidden");
        rt.shown = false;
      }
      continue;
    }

    const isLocal = slot === state.slot;
    const target = isLocal ? { x: localPointer.x, y: localPointer.y } : resolveCursorPoint(rt.data);
    if (!target) continue;

    if (!rt.shown || rt.x == null || isLocal) {
      rt.x = target.x;
      rt.y = target.y;
    } else {
      // Interpolação suave entre os pacotes recebidos (≈25 por segundo).
      const k = 1 - Math.exp(-dt / 38);
      rt.x += (target.x - rt.x) * k;
      rt.y += (target.y - rt.y) * k;
      if (Math.abs(target.x - rt.x) < 0.3) rt.x = target.x;
      if (Math.abs(target.y - rt.y) < 0.3) rt.y = target.y;
    }

    el.style.transform = `translate3d(${rt.x.toFixed(1)}px, ${rt.y.toFixed(1)}px, 0)`;
    if (!rt.shown) {
      paintCursorLabel(slot, rt.data);
      el.classList.remove("hidden");
      rt.shown = true;
    }
  }

  updateCardTilts(dt);
  updateFinalHover();
  updatePosOwnerTip();
  requestAnimationFrame(cursorFrame);
}

/* ---------- Cartas 3D do lobby (estilo carta da Steam) ----------
   O ponto onde está o mouse "afunda" e as bordas opostas sobem.
   Funciona com o mouse local e também com o cursor do outro jogador,
   então os dois veem a mesma carta inclinando. */
const TILT_MAX_DEG = 9;
const tiltState = new WeakMap();
function updateCardTilts(dt) {
  const cards = document.querySelectorAll("#screen-lobby.active [data-tilt]");
  if (!cards.length) return;
  const reduce = prefersReducedMotion();
  const k = 1 - Math.exp(-dt / 85);

  cards.forEach(card => {
    const r = layoutRect(card);
    if (!r.width) return;
    const inside = (p) => p && p.x != null && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

    let pt = null;
    if (localPointer.inside && inside(localPointer)) pt = localPointer;
    else {
      for (const slot of ["p1", "p2"]) {
        const rt = cursorRuntime[slot];
        if (slot !== state.slot && rt.shown && inside(rt)) { pt = rt; break; }
      }
    }

    const st = tiltState.get(card) || { rx: 0, ry: 0, gx: 50, gy: 50, a: 0 };
    let trx = 0, tryy = 0, ta = 0, tgx = st.gx, tgy = st.gy;
    if (pt && !reduce) {
      const fx = (pt.x - r.left) / r.width;
      const fy = (pt.y - r.top) / r.height;
      trx = (0.5 - fy) * TILT_MAX_DEG * 2;
      tryy = (fx - 0.5) * TILT_MAX_DEG * 2;
      ta = 1;
      tgx = fx * 100;
      tgy = fy * 100;
    }
    st.rx += (trx - st.rx) * k;
    st.ry += (tryy - st.ry) * k;
    st.a += (ta - st.a) * k;
    st.gx += (tgx - st.gx) * Math.min(1, k * 1.6);
    st.gy += (tgy - st.gy) * Math.min(1, k * 1.6);
    tiltState.set(card, st);

    if (Math.abs(st.rx) < 0.03 && Math.abs(st.ry) < 0.03 && st.a < 0.01) {
      if (card.classList.contains("is-tilting")) {
        card.classList.remove("is-tilting");
        card.style.removeProperty("transform");
        card.style.setProperty("--glare-a", "0");
      }
      return;
    }
    card.classList.add("is-tilting");
    card.style.transform = `perspective(900px) rotateX(${st.rx.toFixed(2)}deg) rotateY(${st.ry.toFixed(2)}deg) scale(${(1 + 0.025 * st.a).toFixed(4)})`;
    card.style.setProperty("--glare-x", `${st.gx.toFixed(1)}%`);
    card.style.setProperty("--glare-y", `${st.gy.toFixed(1)}%`);
    card.style.setProperty("--glare-a", st.a.toFixed(3));
  });
}

function startCursorLoop() {
  if (cursorLoopStarted) return;
  cursorLoopStarted = true;
  requestAnimationFrame(cursorFrame);
}

function cursorPayloadAt(x, y, target = null, extra = {}) {
  const clickable = !!target?.closest?.(
    "button:not(:disabled), a, input, label, [role='button'], [data-sync-key], .photo-preview, .player-avatar, .media-wrap, .media-inner, .media-interaction-layer, .profile-color-swatch"
  );
  return {
    chain: buildAnchorChain(x, y, target),
    x: round4(x / Math.max(1, window.innerWidth)),
    y: round4(y / Math.max(1, window.innerHeight)),
    name: cursorName(state.slot),
    color: playerColor(state.slot),
    kind: clickable ? "pointer" : "arrow",
    t: serverNow(),
    ...extra
  };
}

function flushCursorSend() {
  clearTimeout(cursorSendTimer);
  cursorSendTimer = null;
  if (!state.slot || !cursorPendingPayload) return;
  const payload = cursorPendingPayload;
  cursorPendingPayload = null;
  cursorLastSentAt = performance.now();
  set(ref(db, `presence/cursors/${state.slot}`), payload).catch(() => {});
}

/* Throttle com envio final garantido: quando o mouse para, a última
   posição SEMPRE é enviada (antes ela podia se perder no throttle). */
function queueCursorSend(payload, immediate = false) {
  cursorPendingPayload = payload;
  const wait = CURSOR_SEND_INTERVAL - (performance.now() - cursorLastSentAt);
  if (immediate || wait <= 0) {
    flushCursorSend();
  } else if (!cursorSendTimer) {
    cursorSendTimer = setTimeout(flushCursorSend, wait);
  }
}

function refreshOwnCursorProfile(name, color) {
  if (!state.slot) return;
  const current = cursorRuntime[state.slot].data || {};
  const refreshed = { ...current, name, color, t: serverNow() };
  cursorRuntime[state.slot].data = refreshed;
  paintCursorLabel(state.slot, refreshed);
  if (localPointer.x != null) {
    queueCursorSend(cursorPayloadAt(localPointer.x, localPointer.y, document.elementFromPoint(localPointer.x, localPointer.y)), true);
  }
}

let cursorDisconnectSlot = null;
function armCursorDisconnectCleanup() {
  if (!state.slot || cursorDisconnectSlot === state.slot) return;
  cursorDisconnectSlot = state.slot;
  try {
    onDisconnect(ref(db, `presence/cursors/${state.slot}`)).remove();
    onDisconnect(ref(db, `presence/selections/${state.slot}`)).remove();
  } catch {}
}

function markLocalPointerOut() {
  localPointer.inside = false;
  if (!state.slot || state.settings?.customCursorEnabled === false) return;
  const prev = cursorRuntime[state.slot].data || {};
  queueCursorSend({ ...prev, out: true, t: serverNow() }, true);
}

const selectionTimers = { p1: null, p2: null };
const lastSelectionStamp = { p1: 0, p2: 0 };

function syncKeyForElement(target) {
  const el = target?.closest?.(
    "[data-sync-key], button, a, input, label, [role='button'], .photo-preview, .player-avatar"
  );
  if (!el) return null;

  if (el.dataset?.syncKey) {
    return `[data-sync-key="${CSS.escape(el.dataset.syncKey)}"]`;
  }

  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }

  if (el.classList?.contains("pos-btn") && el.dataset.pos) {
    return `[data-pos="${CSS.escape(el.dataset.pos)}"]`;
  }

  return null;
}

function applyRemoteSelection(slot, data) {
  if (!data?.t) return;
  if (serverNow() - Number(data.t || 0) > 1500) return;

  // Anel de clique na posição exata (espelhado para o outro jogador).
  if (slot !== state.slot && Number(data.t) !== lastSelectionStamp[slot]) {
    lastSelectionStamp[slot] = Number(data.t);
    const point = resolveCursorPoint(data);
    if (point) fxClickRing(point.x, point.y, normalizePlayerColor(data.color, slot));
  }

  if (!data.key) return;

  document.querySelectorAll(`.remote-selected-${slot}`).forEach(el => {
    el.classList.remove(`remote-selected-${slot}`);
  });
  clearTimeout(selectionTimers[slot]);

  let target = null;
  try {
    target = [...document.querySelectorAll(data.key)].find(el => usableAnchorRect(el)) || null;
  } catch {}

  if (!target) return;

  target.style.setProperty("--remote-selection-color", normalizePlayerColor(data.color, slot));
  target.classList.add(`remote-selected-${slot}`);
  selectionTimers[slot] = setTimeout(() => {
    target.classList.remove(`remote-selected-${slot}`);
    target.style.removeProperty("--remote-selection-color");
  }, 1150);
}

function installCursorSync() {
  startCursorLoop();

  listenWithRetry("presence/cursors", snap => {
    const cursors = snap.val() || {};
    for (const slot of ["p1", "p2"]) {
      if (slot === state.slot) continue; // o próprio cursor é desenhado localmente, sem atraso
      cursorRuntime[slot].data = cursors[slot] || null;
      paintCursorLabel(slot, cursorRuntime[slot].data);
    }
  }, "cursores");

  listenWithRetry("presence/selections", snap => {
    const selections = snap.val() || {};
    applyRemoteSelection("p1", selections.p1);
    applyRemoteSelection("p2", selections.p2);
  }, "cliques");

  window.addEventListener("pointermove", e => {
    if (e.pointerType === "touch") return;
    localPointer.x = e.clientX;
    localPointer.y = e.clientY;
    localPointer.inside = true;

    if (!state.slot || state.settings?.customCursorEnabled === false) return;

    armCursorDisconnectCleanup();
    const payload = cursorPayloadAt(e.clientX, e.clientY, e.target);
    cursorRuntime[state.slot].data = payload;
    const el = cursorElement(state.slot);
    if (el) {
      el.classList.toggle("is-pointer", payload.kind === "pointer");
    }
    queueCursorSend(payload);
  }, { passive: true, capture: true });

  document.documentElement.addEventListener("mouseleave", markLocalPointerOut);
  window.addEventListener("blur", () => {
    // Só marca como fora se o mouse realmente saiu (alt-tab etc.).
    if (!document.hasFocus()) markLocalPointerOut();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) markLocalPointerOut();
  });

  // Se a janela mudar de tamanho/rolar enquanto o mouse está parado,
  // reenviamos a posição para o outro lado continuar correto.
  const resend = () => {
    if (!state.slot || !localPointer.inside || localPointer.x == null) return;
    if (state.settings?.customCursorEnabled === false) return;
    queueCursorSend(cursorPayloadAt(localPointer.x, localPointer.y, document.elementFromPoint(localPointer.x, localPointer.y)));
  };
  window.addEventListener("resize", resend, { passive: true });
  window.addEventListener("scroll", resend, { passive: true, capture: true });

  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") {
      localPointer.x = e.clientX;
      localPointer.y = e.clientY;
      localPointer.inside = true;
    }
    if (!state.slot || !state.room?.players?.[state.slot]) return;

    const color = playerColor(state.slot);
    const key = syncKeyForElement(e.target);
    const selectionData = {
      key: key || null,
      chain: buildAnchorChain(e.clientX, e.clientY, e.target),
      x: round4(e.clientX / Math.max(1, window.innerWidth)),
      y: round4(e.clientY / Math.max(1, window.innerHeight)),
      color,
      t: serverNow()
    };

    // Feedback imediato local; o Firebase espelha o mesmo clique no outro navegador.
    fxClickRing(e.clientX, e.clientY, color);
    if (key) {
      lastSelectionStamp[state.slot] = selectionData.t;
      applyRemoteSelection(state.slot, selectionData);
    }

    set(ref(db, `presence/selections/${state.slot}`), selectionData).catch(() => {});
  }, true);

  window.addEventListener("pagehide", () => {
    if (state.slot) {
      set(ref(db, `presence/cursors/${state.slot}`), null).catch(() => {});
      set(ref(db, `presence/selections/${state.slot}`), null).catch(() => {});
    }
  });
}

/* =====================================================================
   FX — partículas, anéis e carimbos (camada própria, nunca mexe na
   geometria dos botões/elementos clicados).
   ===================================================================== */
function fxLayer() {
  let layer = document.getElementById("fxLayer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "fxLayer";
    layer.className = "fx-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);
  }
  return layer;
}

function fxClickRing(x, y, color) {
  if (state.settings?.customCursorEnabled === false && !state.slot) return;
  const ring = document.createElement("i");
  ring.className = "fx-click-ring";
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  ring.style.setProperty("--fx-color", color);
  fxLayer().appendChild(ring);
  ring.addEventListener("animationend", () => ring.remove(), { once: true });
  setTimeout(() => ring.remove(), 900);
}

function fxBurst(x, y, {
  colors = ["#66efff"],
  count = 16,
  spread = 110,
  size = 9,
  gravity = 60,
  duration = 820,
  emojis = null
} = {}) {
  if (prefersReducedMotion()) count = Math.min(count, 5);
  const layer = fxLayer();
  for (let i = 0; i < count; i++) {
    const bit = document.createElement("i");
    const angle = (Math.PI * 2 * i) / count + (Math.random() - .5) * .7;
    const dist = spread * (.45 + Math.random() * .75);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const s = size * (.6 + Math.random() * .8);

    if (emojis) {
      bit.className = "fx-emoji";
      bit.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      bit.style.fontSize = `${s * 2.4}px`;
    } else {
      bit.className = Math.random() > .45 ? "fx-bit" : "fx-bit is-round";
      bit.style.width = `${s}px`;
      bit.style.height = `${s * (Math.random() > .5 ? 1 : .55)}px`;
      bit.style.background = colors[i % colors.length];
    }
    bit.style.left = `${x}px`;
    bit.style.top = `${y}px`;
    layer.appendChild(bit);

    const rot = (Math.random() - .5) * 540;
    const anim = bit.animate([
      { transform: "translate(-50%,-50%) translate(0,0) scale(.3) rotate(0deg)", opacity: 1 },
      { transform: `translate(-50%,-50%) translate(${dx * .72}px,${dy * .72}px) scale(1.1) rotate(${rot * .6}deg)`, opacity: 1, offset: .45 },
      { transform: `translate(-50%,-50%) translate(${dx}px,${dy + gravity}px) scale(.55) rotate(${rot}deg)`, opacity: 0 }
    ], {
      duration: duration * (.8 + Math.random() * .45),
      easing: "cubic-bezier(.16,.84,.3,1)",
      fill: "forwards"
    });
    anim.onfinish = () => bit.remove();
    setTimeout(() => bit.remove(), duration * 1.5);
  }
}

function fxRingAt(x, y, color, size = 160) {
  const ring = document.createElement("i");
  ring.className = "fx-shock-ring";
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  ring.style.setProperty("--fx-color", color);
  ring.style.setProperty("--fx-size", `${size}px`);
  fxLayer().appendChild(ring);
  ring.addEventListener("animationend", () => ring.remove(), { once: true });
  setTimeout(() => ring.remove(), 1200);
}

function centerOf(el) {
  const r = el?.getBoundingClientRect?.();
  if (!r || !r.width) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/* As telas de jogo e resultado são feitas para caber exatamente na janela.
   Se o navegador restaurar uma rolagem antiga (F5) ou algo rolar a página,
   o layout "subia" alguns pixels e cortava o topo. */
try { history.scrollRestoration = "manual"; } catch {}
function keepFixedScreenAtTop() {
  const active = document.querySelector(".screen.active")?.id;
  if ((active === "screen-game" || active === "screen-final") && (window.scrollY || document.documentElement.scrollTop)) {
    window.scrollTo(0, 0);
  }
}
window.addEventListener("scroll", keepFixedScreenAtTop, { passive: true });

/* Esconde a contagem — mas deixa a cortina terminar de subir se ela
   estiver animando (antes o jogo cortava a animação na metade). */
function hideCountdownOverlay(force = false) {
  const ov = document.getElementById("countdownOverlay");
  if (!ov) return;
  if (!force && ov.classList.contains("countdown-fade-out")) return;
  ov.classList.add("hidden");
  ov.classList.remove("countdown-fade-out");
}

function showScreen(id) {
  screens.forEach(s => s.classList.toggle("active", s.id === id));
  keepFixedScreenAtTop();
}

function message(el, text = "", type = "") {
  el.textContent = text;
  el.className = `message ${type}`.trim();
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

function esc(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function initials(name = "?") {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}

function avatarMarkup(player, className = "player-avatar") {
  if (!player) return `<div class="${className} avatar-fallback">?</div>`;
  if (player.photo) return `<img class="${className}" src="${player.photo}" alt="">`;
  return `<div class="${className} avatar-fallback">${esc(initials(player.name))}</div>`;
}

function formatCount(n) {
  return new Intl.NumberFormat("pt-BR").format(Number(n || 0));
}

function getYoutubeId(url = "") {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.split("/").filter(Boolean)[0] || null;
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
      if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null;
      return u.searchParams.get("v");
    }
  } catch {}
  return null;
}

/* =====================================================================
   PLAYER DOS SHORTS
   - Controles próprios no estilo do YouTube Shorts, que aparecem ao passar
     o mouse (play/pause, volume, barra de progresso). O cursor temático
     continua visível por cima do vídeo.
   - Conversa com o player do YouTube pelo protocolo postMessage da
     IFrame API (sem precisar carregar scripts extras).
   - Vídeo de fundo desfocado no container central (controlado pelo ADM).
     Como o conteúdo do iframe do YouTube não pode ser lido (tela preta ou
     não), o fundo só aparece quando o player confirma que está tocando;
     carregando, pausado, travado ou com erro → volta a cor padrão.
   ===================================================================== */
const YT_ORIGIN_RE = /^https:\/\/(www\.)?youtube(-nocookie)?\.com$/;
const media = {
  kind: null,
  el: null,
  bg: null,
  round: null,
  info: { playerState: -1, currentTime: 0, duration: 0 },
  infoAt: 0,
  bgInfo: { playerState: -1, currentTime: 0 },
  bgInfoAt: 0,
  listenTimer: null,
  bgListenTimer: null,
  playingSince: 0,
  wantPaused: false,
  volume: (() => {
    try {
      const v = Number(sessionStorage.getItem("shortRankVolume"));
      return Number.isFinite(v) && v >= 0 && v <= 100 && sessionStorage.getItem("shortRankVolume") !== null ? v : 50;
    } catch { return 50; }
  })(),
  muted: false,
  uiHideTimer: null,
  scrubbing: false,
  loopStarted: false
};

function ytEmbedUrl(id, { autoplay = true, muted = false, bg = false } = {}) {
  const params = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    mute: muted ? "1" : "0",
    playsinline: "1",
    rel: "0",
    enablejsapi: "1",
    loop: "1",
    playlist: id,
    controls: "0",
    disablekb: "1",
    fs: "0",
    iv_load_policy: "3",
    modestbranding: "1",
    origin: location.origin
  });
  if (bg) params.set("cc_load_policy", "0");
  return `https://www.youtube.com/embed/${encodeURIComponent(id)}?${params.toString()}`;
}

function mediaMarkup(item, autoplay = false) {
  const yt = getYoutubeId(item.url);

  if (yt) {
    return `<iframe
      class="youtube-player"
      src="${ytEmbedUrl(yt, { autoplay })}"
      title="${esc(item.title || "Short")}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen></iframe>`;
  }

  return `<video
    class="html5-player"
    src="${esc(item.url)}"
    playsinline
    loop
    ${autoplay ? "autoplay" : ""}></video>`;
}

function ytSend(iframe, func, args = []) {
  try {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args, id: 1, channel: "widget" }), "*");
  } catch {}
}

function ytListen(iframe, which) {
  const key = which === "bg" ? "bgListenTimer" : "listenTimer";
  clearInterval(media[key]);
  let tries = 0;
  const ping = () => {
    tries += 1;
    if (!iframe.isConnected || tries > 80) { clearInterval(media[key]); return; }
    try {
      iframe.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: which === "bg" ? 2 : 1, channel: "widget" }), "*");
    } catch {}
  };
  iframe.addEventListener("load", () => { tries = 0; ping(); }, { once: true });
  media[key] = setInterval(ping, 300);
}

function pickInfo(target, info) {
  if (!info || typeof info !== "object") return;
  for (const k of ["playerState", "currentTime", "duration", "volume", "muted"]) {
    if (info[k] !== undefined && info[k] !== null) target[k] = info[k];
  }
}

window.addEventListener("message", (e) => {
  if (!YT_ORIGIN_RE.test(e.origin || "")) return;
  let data = e.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return; }
  }
  if (!data || typeof data !== "object") return;

  const isMain = media.kind === "yt" && media.el && e.source === media.el.contentWindow;
  const isBg = media.bg?.tagName === "IFRAME" && e.source === media.bg.contentWindow;
  if (!isMain && !isBg) return;

  clearInterval(isMain ? media.listenTimer : media.bgListenTimer);

  let info = null;
  if (data.event === "infoDelivery" || data.event === "initialDelivery") info = data.info || {};
  else if (data.event === "onStateChange") info = { playerState: Number(data.info) };
  else if (data.event === "onReady") {
    if (isMain) applyStartVolume();
    else { ytSend(media.bg, "mute"); ytSend(media.bg, "playVideo"); }
    return;
  }
  if (!info) return;

  if (isMain) {
    const prevState = media.info.playerState;
    pickInfo(media.info, info);
    media.infoAt = performance.now();
    if (media.info.playerState === 1 && prevState !== 1) media.playingSince = performance.now();
    if (media.info.playerState !== 1) media.playingSince = 0;
    if (typeof info.muted === "boolean") media.muted = info.muted;
    syncStageBg();
  } else {
    pickInfo(media.bgInfo, info);
    media.bgInfoAt = performance.now();
  }
});

function applyStartVolume() {
  if (media.kind === "yt") {
    if (media.muted) ytSend(media.el, "mute"); else ytSend(media.el, "unMute");
    ytSend(media.el, "setVolume", [media.volume]);
    if (!media.wantPaused) ytSend(media.el, "playVideo");
  } else if (media.kind === "video" && media.el) {
    media.el.volume = media.volume / 100;
    media.el.muted = media.muted;
  }
}

function startMediaAtHalfVolume() {
  if (media.kind === "video" && media.el) {
    const video = media.el;
    video.volume = media.volume / 100;
    video.muted = media.muted;
    const playPromise = video.play();
    if (playPromise?.catch) {
      playPromise.catch(async () => {
        // Navegador bloqueou autoplay com som: toca mudo (o botão de som fica visível).
        video.muted = true;
        media.muted = true;
        try { await video.play(); } catch {}
      });
    }
    return;
  }

  if (media.kind === "yt" && media.el) {
    const iframe = media.el;
    iframe.addEventListener("load", () => {
      setTimeout(applyStartVolume, 180);
      setTimeout(applyStartVolume, 650);
    }, { once: true });
    setTimeout(applyStartVolume, 900);
  }
}

function bindHtmlVideo(video, isBg = false) {
  const target = isBg ? media.bgInfo : media.info;
  const upd = () => {
    target.currentTime = video.currentTime || 0;
    target.duration = video.duration || 0;
    target.playerState = video.paused ? 2 : (video.readyState < 3 ? 3 : 1);
    if (!isBg) {
      media.infoAt = performance.now();
      if (target.playerState === 1 && !media.playingSince) media.playingSince = performance.now();
      if (target.playerState !== 1) media.playingSince = 0;
      media.muted = video.muted;
      syncStageBg();
    } else {
      media.bgInfoAt = performance.now();
    }
  };
  ["play", "playing", "pause", "waiting", "timeupdate", "loadedmetadata", "volumechange", "ended", "stalled"].forEach(ev => video.addEventListener(ev, upd));
}

function mediaIsPaused() {
  if (media.kind === "video" && media.el) return media.el.paused;
  if (media.kind === "yt") {
    const st = media.info.playerState;
    if (st === 1 || st === 3) return false;
    if (st === 2) return true;
    return media.wantPaused;
  }
  return true;
}

function mediaCurrentTime() {
  const d = Number(media.info.duration || 0);
  let t = Number(media.info.currentTime || 0);
  if (media.kind === "video" && media.el) return media.el.currentTime || 0;
  if (media.info.playerState === 1 && media.infoAt) t += (performance.now() - media.infoAt) / 1000;
  if (d > 0) t = t % d;
  return t;
}

function setMediaPaused(paused) {
  media.wantPaused = !!paused;
  state.mediaPausedByUser = !!paused;
  if (media.kind === "video" && media.el) {
    if (paused) media.el.pause(); else media.el.play().catch(() => {});
  } else if (media.kind === "yt" && media.el) {
    ytSend(media.el, paused ? "pauseVideo" : "playVideo");
    media.info.playerState = paused ? 2 : 1;
    media.infoAt = performance.now();
    if (!paused && !media.playingSince) media.playingSince = performance.now();
  }
  syncStageBg();
}

function toggleCurrentMediaPlayback() {
  if (!media.el) return;
  const pausedNow = !mediaIsPaused();
  setMediaPaused(pausedNow);
  publishMirrorState({ playing: !pausedNow });
  flashCenterIcon(pausedNow ? "pause" : "play");
  flashShortUi();
}

function setMediaVolume(v) {
  media.volume = Math.max(0, Math.min(100, Math.round(v)));
  try { sessionStorage.setItem("shortRankVolume", String(media.volume)); } catch {}
  media.muted = media.volume === 0;
  if (media.kind === "video" && media.el) {
    media.el.volume = media.volume / 100;
    media.el.muted = media.muted;
  } else if (media.kind === "yt" && media.el) {
    ytSend(media.el, "setVolume", [media.volume]);
    ytSend(media.el, media.muted ? "mute" : "unMute");
  }
}

function toggleMute() {
  if (!media.el) return;
  media.muted = !media.muted;
  if (!media.muted && media.volume === 0) media.volume = 50;
  if (media.kind === "video") {
    media.el.muted = media.muted;
    media.el.volume = media.volume / 100;
  } else {
    ytSend(media.el, media.muted ? "mute" : "unMute");
    if (!media.muted) ytSend(media.el, "setVolume", [media.volume]);
  }
  flashCenterIcon(media.muted ? "mute" : "vol");
}

function seekMedia(fraction) {
  const d = Number(media.kind === "video" ? media.el?.duration : media.info.duration) || 0;
  if (!d) return;
  const t = Math.max(0, Math.min(d - 0.05, fraction * d));
  if (media.kind === "video") media.el.currentTime = t;
  else {
    ytSend(media.el, "seekTo", [t, true]);
    media.info.currentTime = t;
    media.infoAt = performance.now();
  }
  if (media.bg) {
    if (media.bg.tagName === "VIDEO") media.bg.currentTime = t;
    else ytSend(media.bg, "seekTo", [t, true]);
  }
}

const CENTER_ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7.5 4.8v14.4a1 1 0 0 0 1.52.85l11.5-7.2a1 1 0 0 0 0-1.7L9.02 3.95A1 1 0 0 0 7.5 4.8Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9.2h3.4L12 5v14l-4.6-4.2H4a1 1 0 0 1-1-1v-3.6a1 1 0 0 1 1-1Z"/><path d="M15.5 8.6a4.6 4.6 0 0 1 0 6.8M18 6.2a8 8 0 0 1 0 11.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9.2h3.4L12 5v14l-4.6-4.2H4a1 1 0 0 1-1-1v-3.6a1 1 0 0 1 1-1Z"/><path d="m15.5 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
};

function flashCenterIcon(kind) {
  const el = $("#shortCenterIcon");
  if (!el) return;
  el.innerHTML = CENTER_ICONS[kind] || "";
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

function flashShortUi(ms = 1800) {
  const wrap = document.querySelector(".media-wrap");
  if (!wrap) return;
  wrap.classList.add("ui-awake");
  clearTimeout(media.uiHideTimer);
  media.uiHideTimer = setTimeout(() => wrap.classList.remove("ui-awake"), ms);
}

function shortUiFrame() {
  const wrap = document.querySelector(".media-wrap");
  if (wrap && media.el) {
    const paused = mediaIsPaused();
    wrap.classList.toggle("is-paused", paused);
    wrap.classList.toggle("is-muted", !!media.muted || media.volume === 0);
    const d = Number(media.kind === "video" ? media.el.duration : media.info.duration) || 0;
    wrap.classList.toggle("has-duration", d > 0);
    if (d > 0 && !media.scrubbing) {
      const f = Math.max(0, Math.min(1, mediaCurrentTime() / d));
      $("#shortProgressFill").style.transform = `scaleX(${f.toFixed(4)})`;
      $("#shortProgressKnob").style.left = `${(f * 100).toFixed(3)}%`;
    }
    const slider = $("#shortVolume");
    if (slider && document.activeElement !== slider) {
      const shown = media.muted ? 0 : media.volume;
      if (Number(slider.value) !== shown) slider.value = String(shown);
    }
    slider?.style.setProperty("--vol", `${media.muted ? 0 : media.volume}%`);
    syncStageBg();
  }
  requestAnimationFrame(shortUiFrame);
}

/* =====================================================================
   ESPELHAR O SHORT (opcional, precisa que os DOIS ativem)
   Quando os dois jogadores ligam o botão 🔗, pausar/tocar e avançar/voltar
   num navegador acontece igual no outro, na mesma minutagem.
   Usa o relógio do servidor, então o tempo bate mesmo com PCs diferentes.
   ===================================================================== */
const mirror = { optin: { p1: false, p2: false }, state: null, lastSeq: 0, lastApplyAt: 0 };

function mirrorActive() {
  return !!(mirror.optin.p1 && mirror.optin.p2 && state.slot);
}

function mirrorTargetTime(ms) {
  const d = Number(media.kind === "video" ? media.el?.duration : media.info.duration) || 0;
  let t = Number(ms.t || 0) + (ms.playing ? Math.max(0, serverNow() - Number(ms.at || 0)) / 1000 : 0);
  if (d > 0) t = t % d;
  return t;
}

function publishMirrorState(patch = {}) {
  if (!mirrorActive() || !media.el || media.round == null) return;
  const payload = {
    round: media.round,
    playing: patch.playing ?? !mediaIsPaused(),
    t: patch.t ?? mediaCurrentTime(),
    at: serverNow(),
    by: state.slot,
    seq: Date.now() + Math.random()
  };
  mirror.lastSeq = payload.seq;
  mirror.state = payload;
  set(ref(db, "mediasync/state"), payload).catch(() => {});
}

function applyMirrorState(force = false) {
  const ms = mirror.state;
  if (!mirrorActive() || !ms || !media.el || Number(ms.round) !== Number(media.round)) return;
  const target = mirrorTargetTime(ms);
  const now = mediaCurrentTime();
  const drift = Math.abs(target - now);
  const d = Number(media.kind === "video" ? media.el?.duration : media.info.duration) || 0;
  const wrapDrift = d > 0 ? Math.min(drift, d - drift) : drift;

  if (force || wrapDrift > 0.6) {
    if (media.kind === "video") media.el.currentTime = target;
    else {
      ytSend(media.el, "seekTo", [target, true]);
      media.info.currentTime = target;
      media.infoAt = performance.now();
    }
    if (media.bg) {
      if (media.bg.tagName === "VIDEO") media.bg.currentTime = target;
      else ytSend(media.bg, "seekTo", [target, true]);
    }
  }
  const pausedNow = mediaIsPaused();
  if (ms.playing && pausedNow) setMediaPaused(false);
  if (!ms.playing && !pausedNow) setMediaPaused(true);
}

function onMirrorMediaMounted(round) {
  // Rodada nova: o P1 manda o "zero" e o P2 se alinha a ele.
  if (!mirrorActive()) return;
  if (state.slot === "p1") {
    setTimeout(() => publishMirrorState({ playing: true, t: 0 }), 900);
  } else {
    setTimeout(() => applyMirrorState(true), 1200);
  }
}

function setMirrorOptin(on) {
  if (!state.slot) return;
  set(ref(db, `mediasync/optin/${state.slot}`), on ? true : null).catch(() => {});
}

function renderMirrorButton() {
  const btn = $("#shortMirrorBtn");
  if (!btn) return;
  const mine = !!mirror.optin[state.slot];
  const other = state.slot ? !!mirror.optin[state.slot === "p1" ? "p2" : "p1"] : false;
  const active = mine && other;
  btn.classList.toggle("is-mine", mine && !other);
  btn.classList.toggle("is-other", !mine && other);
  btn.classList.toggle("is-active", active);
  const label = btn.querySelector("span");
  if (label) label.textContent = active ? "Sincronizado" : "Sincronizar";
  // Aviso em linha própria (quebra linha em telas menores, não fica cortado).
  const note = $("#shortMirrorNote");
  if (note) {
    const text = active ? "" : mine ? "Esperando o outro jogador ativar 🔗" : other ? "O outro jogador quer sincronizar o Short — clique em 🔗" : "";
    note.textContent = text;
    note.classList.toggle("show", !!text);
    note.classList.toggle("is-other", !mine && other);
  }
  btn.title = active
    ? "Pausar, tocar e mudar a minutagem acontece igual para os dois. Clique para desligar."
    : "Quando os dois ativarem, o Short fica igual para os dois (mesma minutagem, pausa, avanço...).";
  document.querySelector(".media-wrap")?.classList.toggle("is-mirrored", active);
}

let mirrorWasActive = false;
function installMirrorSync() {
  listenWithRetry("mediasync/optin", snap => {
    const v = snap.val() || {};
    mirror.optin = { p1: !!v.p1, p2: !!v.p2 };
    renderMirrorButton();
    const active = mirrorActive();
    if (active && !mirrorWasActive) {
      toast("🔗 Short sincronizado entre os dois!");
      if (state.slot === "p1") publishMirrorState();
      else setTimeout(() => applyMirrorState(true), 400);
    }
    mirrorWasActive = active;
  }, "espelho");

  listenWithRetry("mediasync/state", snap => {
    const ms = snap.val();
    if (!ms) return;
    mirror.state = ms;
    if (ms.seq === mirror.lastSeq) return; // o meu próprio comando
    if (ms.by !== state.slot && typeof flashCenterIcon === "function") {
      flashCenterIcon(ms.playing ? "play" : "pause");
    }
    applyMirrorState(true);
  }, "estado-espelho");

  // Correção fina de tempo em tempo (vídeos que travam/carregam diferente).
  setInterval(() => { if (mirrorActive()) applyMirrorState(false); }, 2500);

  $("#shortMirrorBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setMirrorOptin(!mirror.optin[state.slot]);
    flashShortUi();
  });
}

function installShortUi() {
  if (media.loopStarted) return;
  media.loopStarted = true;
  requestAnimationFrame(shortUiFrame);

  $("#mediaInteractionLayer")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleCurrentMediaPlayback();
  });
  $("#shortPlayBtn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleCurrentMediaPlayback(); });
  $("#shortMuteBtn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleMute(); flashShortUi(); });
  $("#shortVolume")?.addEventListener("input", (e) => { setMediaVolume(Number(e.target.value)); flashShortUi(); });

  const bar = $("#shortProgress");
  if (bar) {
    const fractionAt = (clientX) => {
      const r = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    };
    bar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      media.scrubbing = true;
      bar.setPointerCapture?.(e.pointerId);
      const f = fractionAt(e.clientX);
      $("#shortProgressFill").style.transform = `scaleX(${f})`;
      $("#shortProgressKnob").style.left = `${f * 100}%`;
    });
    bar.addEventListener("pointermove", (e) => {
      if (!media.scrubbing) return;
      const f = fractionAt(e.clientX);
      $("#shortProgressFill").style.transform = `scaleX(${f})`;
      $("#shortProgressKnob").style.left = `${f * 100}%`;
    });
    const end = (e) => {
      if (!media.scrubbing) return;
      media.scrubbing = false;
      seekMedia(fractionAt(e.clientX));
      flashShortUi();
    };
    bar.addEventListener("pointerup", (e) => {
      const wasScrubbing = media.scrubbing;
      end(e);
      if (wasScrubbing) publishMirrorState({ t: fractionAt(e.clientX) * (Number(media.kind === "video" ? media.el?.duration : media.info.duration) || 0) });
    });
    bar.addEventListener("pointercancel", () => { media.scrubbing = false; });
  }

  document.querySelector(".media-wrap")?.addEventListener("pointermove", () => flashShortUi(2200), { passive: true });
}

/* ---------- vídeo de fundo desfocado ---------- */
function refreshStageBgMount(hadBg = !!media.bg) {
  if (!stageBgWanted() && media.bg) removeStageBg();
  if (stageBgWanted() && !hadBg && !media.bg && media.el && state.room?.shorts?.[media.round]) {
    mountStageBg(state.room.shorts[media.round]);
  }
  syncStageBg();
}
function stageBgWanted() {
  const local = localPrefs.stageBg;
  if (local === "on") return true;
  if (local === "off") return false;
  return state.settings?.stageBgEnabled !== false;
}

function mountStageBg(item) {
  const host = $("#stageBg");
  if (!host) return;
  removeStageBg();
  if (!item || !stageBgWanted()) return;

  const yt = getYoutubeId(item.url);
  if (yt) {
    host.innerHTML = `<iframe class="stage-bg-media" src="${ytEmbedUrl(yt, { autoplay: true, muted: true, bg: true })}" tabindex="-1" title="" aria-hidden="true" allow="autoplay; encrypted-media"></iframe>`;
    media.bg = host.querySelector("iframe");
    ytListen(media.bg, "bg");
    media.bg.addEventListener("load", () => {
      setTimeout(() => { ytSend(media.bg, "mute"); ytSend(media.bg, "playVideo"); }, 300);
    }, { once: true });
  } else {
    host.innerHTML = `<video class="stage-bg-media" src="${esc(item.url)}" muted playsinline loop autoplay tabindex="-1" aria-hidden="true"></video>`;
    media.bg = host.querySelector("video");
    media.bg.muted = true;
    bindHtmlVideo(media.bg, true);
    media.bg.play?.().catch(() => {});
  }
}

function removeStageBg() {
  clearInterval(media.bgListenTimer);
  const host = $("#stageBg");
  if (media.bg) {
    try {
      if (media.bg.tagName === "VIDEO") { media.bg.pause(); media.bg.removeAttribute("src"); media.bg.load?.(); }
      else ytSend(media.bg, "pauseVideo");
    } catch {}
  }
  media.bg = null;
  media.bgInfo = { playerState: -1, currentTime: 0 };
  if (host) {
    host.innerHTML = "";
    host.classList.remove("is-live");
  }
}

let lastBgSyncAt = 0;
function syncStageBg() {
  const host = $("#stageBg");
  if (!host) return;
  const enabled = stageBgWanted();
  document.body.classList.toggle("stage-bg-on", enabled && !!media.bg);

  // Só mostra quando o player principal está realmente tocando há um tempinho
  // (evita a tela preta do começo, carregamento, pausa ou erro).
  const live = enabled && !!media.bg && media.info.playerState === 1 &&
    media.playingSince && performance.now() - media.playingSince > 650;
  host.classList.toggle("is-live", !!live);

  if (!media.bg || !media.el) return;
  const now = performance.now();
  if (now - lastBgSyncAt < 700) return;
  lastBgSyncAt = now;

  const mainPaused = mediaIsPaused();
  if (media.bg.tagName === "VIDEO") {
    if (mainPaused && !media.bg.paused) media.bg.pause();
    if (!mainPaused && media.bg.paused) media.bg.play().catch(() => {});
    const drift = Math.abs((media.bg.currentTime || 0) - mediaCurrentTime());
    if (drift > 0.45 && Number.isFinite(mediaCurrentTime())) media.bg.currentTime = mediaCurrentTime();
  } else {
    const bgState = media.bgInfo.playerState;
    if (mainPaused && bgState === 1) ytSend(media.bg, "pauseVideo");
    if (!mainPaused && bgState !== 1 && bgState !== 3) ytSend(media.bg, "playVideo");
    if (media.bgInfoAt && media.infoAt && media.info.duration) {
      let bgT = Number(media.bgInfo.currentTime || 0);
      if (bgState === 1) bgT += (now - media.bgInfoAt) / 1000;
      const drift = Math.abs(bgT - mediaCurrentTime());
      if (drift > 0.45 && drift < Number(media.info.duration) - 0.45) ytSend(media.bg, "seekTo", [mediaCurrentTime(), true]);
    }
  }
}

/* ---------- montar / desmontar ---------- */
function mountMedia(item, round) {
  unmountMedia();
  const wrap = $("#mediaWrap");
  if (!wrap || !item) return;
  wrap.innerHTML = mediaMarkup(item, true);
  media.round = round;
  state.mountedMediaRound = round;
  state.mediaPausedByUser = false;
  media.wantPaused = false;
  media.info = { playerState: -1, currentTime: 0, duration: 0 };
  media.infoAt = 0;
  media.playingSince = 0;

  const iframe = wrap.querySelector("iframe.youtube-player");
  const video = wrap.querySelector("video.html5-player");
  if (iframe) {
    media.kind = "yt";
    media.el = iframe;
    ytListen(iframe, "main");
  } else if (video) {
    media.kind = "video";
    media.el = video;
    bindHtmlVideo(video);
  }
  document.querySelector(".media-wrap")?.classList.add("has-media");
  startMediaAtHalfVolume();
  mountStageBg(item);
  flashShortUi(2600);
  onMirrorMediaMounted(round);
}

function stopCurrentMedia() {
  if (media.kind === "video" && media.el) {
    try { media.el.muted = true; media.el.pause(); } catch {}
  } else if (media.kind === "yt" && media.el) {
    ytSend(media.el, "mute");
    ytSend(media.el, "pauseVideo");
  } else {
    // segurança: qualquer mídia que tenha sobrado no DOM
    $("#mediaWrap")?.querySelectorAll("video").forEach(v => { try { v.muted = true; v.pause(); } catch {} });
    $("#mediaWrap")?.querySelectorAll("iframe").forEach(f => { ytSend(f, "mute"); ytSend(f, "pauseVideo"); });
  }
  if (media.bg) {
    if (media.bg.tagName === "VIDEO") { try { media.bg.pause(); } catch {} }
    else ytSend(media.bg, "pauseVideo");
  }
  media.info.playerState = 2;
  media.playingSince = 0;
  $("#stageBg")?.classList.remove("is-live");
}

function pausePreparedMedia() {
  stopCurrentMedia();
}

function unmountMedia() {
  stopCurrentMedia();
  clearInterval(media.listenTimer);
  const wrap = $("#mediaWrap");
  if (wrap) wrap.innerHTML = "";
  removeStageBg();
  media.kind = null;
  media.el = null;
  media.round = null;
  media.info = { playerState: -1, currentTime: 0, duration: 0 };
  media.playingSince = 0;
  state.mountedMediaRound = null;
  const mw = document.querySelector(".media-wrap");
  mw?.classList.remove("has-media", "is-paused", "is-muted", "has-duration", "ui-awake");
  document.body.classList.remove("stage-bg-on");
}

function thumbFor(item) {
  const yt = getYoutubeId(item?.url || "");
  return yt ? `https://i.ytimg.com/vi/${encodeURIComponent(yt)}/hqdefault.jpg` : "";
}

async function fileToCompressedDataUrl(file) {
  if (!file) return "";
  if (!file.type.startsWith("image/")) throw new Error("Escolha um arquivo de imagem.");

  const bitmap = await createImageBitmap(file);
  const max = 320;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let quality = .82;
  let data = canvas.toDataURL("image/jpeg", quality);
  while (data.length > 110_000 && quality > .45) {
    quality -= .08;
    data = canvas.toDataURL("image/jpeg", quality);
  }
  if (data.length > 160_000) throw new Error("A foto ficou grande demais. Tente uma imagem menor.");
  return data;
}

/* photoInput handled by cropper below */


/* editPhotoInput handled by cropper below */


const cropCanvas = $("#cropCanvas");
const cropCtx = cropCanvas.getContext("2d");
const cropStage = cropCanvas.parentElement;

function drawCrop() {
  const img = state.cropImage;
  if (!img) return;

  const size = cropCanvas.width;
  cropCtx.clearRect(0, 0, size, size);
  cropCtx.fillStyle = "#090711";
  cropCtx.fillRect(0, 0, size, size);

  const w = img.naturalWidth * state.cropScale;
  const h = img.naturalHeight * state.cropScale;

  cropCtx.drawImage(
    img,
    state.cropX,
    state.cropY,
    w,
    h
  );
}

function clampCropPosition() {
  const img = state.cropImage;
  if (!img) return;

  const size = cropCanvas.width;
  const w = img.naturalWidth * state.cropScale;
  const h = img.naturalHeight * state.cropScale;

  // Image must always cover the square.
  state.cropX = Math.min(0, Math.max(size - w, state.cropX));
  state.cropY = Math.min(0, Math.max(size - h, state.cropY));
}

async function openCropper(file, target) {
  if (!file?.type?.startsWith("image/")) {
    toast("Escolha um arquivo de imagem.");
    return;
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });

  state.cropTarget = target;
  state.cropImage = img;

  const size = cropCanvas.width;
  state.cropMinScale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
  state.cropScale = state.cropMinScale;

  const w = img.naturalWidth * state.cropScale;
  const h = img.naturalHeight * state.cropScale;
  state.cropX = (size - w) / 2;
  state.cropY = (size - h) / 2;

  $("#cropZoom").value = "1";
  drawCrop();

  $("#cropModal").classList.remove("hidden");
  $("#cropModal").setAttribute("aria-hidden", "false");
}

function closeCropper() {
  $("#cropModal").classList.add("hidden");
  $("#cropModal").setAttribute("aria-hidden", "true");
  state.cropTarget = null;
  state.cropImage = null;
}

$("#photoInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await openCropper(file, "entry");
  } catch {
    toast("Não consegui abrir essa imagem.");
  } finally {
    e.target.value = "";
  }
});

$("#editPhotoInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await openCropper(file, "edit");
  } catch {
    toast("Não consegui abrir essa imagem.");
  } finally {
    e.target.value = "";
  }
});

$("#cropZoom").addEventListener("input", (e) => {
  if (!state.cropImage) return;

  const oldScale = state.cropScale;
  const factor = Number(e.target.value);
  const newScale = state.cropMinScale * factor;

  const cx = cropCanvas.width / 2;
  const cy = cropCanvas.height / 2;

  const imagePointX = (cx - state.cropX) / oldScale;
  const imagePointY = (cy - state.cropY) / oldScale;

  state.cropScale = newScale;
  state.cropX = cx - imagePointX * newScale;
  state.cropY = cy - imagePointY * newScale;

  clampCropPosition();
  drawCrop();
});

cropStage.addEventListener("pointerdown", (e) => {
  if (!state.cropImage) return;
  state.cropDragging = true;
  state.cropLastX = e.clientX;
  state.cropLastY = e.clientY;
  cropStage.setPointerCapture?.(e.pointerId);
});

cropStage.addEventListener("pointermove", (e) => {
  if (!state.cropDragging || !state.cropImage) return;

  const rect = cropStage.getBoundingClientRect();
  const sx = cropCanvas.width / rect.width;
  const sy = cropCanvas.height / rect.height;

  state.cropX += (e.clientX - state.cropLastX) * sx;
  state.cropY += (e.clientY - state.cropLastY) * sy;

  state.cropLastX = e.clientX;
  state.cropLastY = e.clientY;

  clampCropPosition();
  drawCrop();
});

function stopCropDrag() {
  state.cropDragging = false;
}
cropStage.addEventListener("pointerup", stopCropDrag);
cropStage.addEventListener("pointercancel", stopCropDrag);

$("#cancelCropBtn").addEventListener("click", closeCropper);
$("#cropCloseBtn").addEventListener("click", closeCropper);
$("#confirmCropBtn").addEventListener("click", () => {
  if (!state.cropImage || !state.cropTarget) return;

  const output = document.createElement("canvas");
  output.width = 320;
  output.height = 320;
  const ctx = output.getContext("2d");
  ctx.drawImage(cropCanvas, 0, 0, 320, 320);

  const data = output.toDataURL("image/jpeg", .84);

  if (state.cropTarget === "entry") {
    state.photoData = data;
    $("#photoPreview").innerHTML = `<img src="${data}" alt="Sua foto">`;
  } else {
    state.editPhotoData = data;
    $("#editPhotoPreview").innerHTML = `<img src="${data}" alt="Sua foto">`;
  }

  closeCropper();
});

function openEditProfile() {
  if (!state.slot || !state.room?.players?.[state.slot]) return;
  const player = state.room.players[state.slot];

  $("#editNameInput").value = player.name || "";
  state.editPhotoData = player.photo || "";
  state.editColorData = normalizePlayerColor(player.color, state.slot);

  $("#editPhotoPreview").innerHTML = player.photo
    ? `<img src="${player.photo}" alt="Sua foto">`
    : `<span>+</span><small>foto</small>`;

  document.querySelectorAll(".profile-color-swatch").forEach(btn => {
    const selected = btn.dataset.color.toUpperCase() === state.editColorData.toUpperCase();
    btn.classList.toggle("selected", selected);
    btn.setAttribute("aria-checked", selected ? "true" : "false");
  });

  $("#editProfileModal").classList.remove("hidden");
  $("#editProfileModal").setAttribute("aria-hidden", "false");
}

function closeEditProfile() {
  $("#editProfileModal").classList.add("hidden");
  $("#editProfileModal").setAttribute("aria-hidden", "true");
}

$("#editProfileBtn").addEventListener("click", openEditProfile);
$("#cancelEditProfileBtn").addEventListener("click", closeEditProfile);

// Clicar fora NÃO fecha (evita perder a edição sem querer) — só o X ou "Cancelar".
$("#editCloseBtn")?.addEventListener("click", closeEditProfile);


document.querySelectorAll(".profile-color-swatch").forEach(btn => {
  btn.style.setProperty("--swatch-color", btn.dataset.color);

  btn.addEventListener("click", () => {
    state.editColorData = btn.dataset.color;

    document.querySelectorAll(".profile-color-swatch").forEach(other => {
      const selected = other === btn;
      other.classList.toggle("selected", selected);
      other.setAttribute("aria-checked", selected ? "true" : "false");
    });
  });
});


$("#editProfileModal")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation?.();
  if (!$("#saveEditProfileBtn").disabled) {
    $("#saveEditProfileBtn").click();
  }
}, true);

$("#saveEditProfileBtn").addEventListener("click", async () => {
  if (!state.slot) return;
  const name = $("#editNameInput").value.trim();

  if (name.length < 2) {
    toast("Digite um nome com pelo menos 2 caracteres.");
    return;
  }

  $("#saveEditProfileBtn").disabled = true;

  try {
    const roomSnap = await get(ref(db, ROOM_PATH));
    const room = roomSnap.exists() ? roomSnap.val() : null;

    if (!room || room.status !== "lobby") {
      throw new Error("O perfil só pode ser alterado enquanto estiver no lobby.");
    }

    if (!room.players?.[state.slot] || room.players[state.slot].clientId !== state.clientId) {
      throw new Error("Este slot não pertence mais a esta aba.");
    }

    const chosenColor = normalizePlayerColor(state.editColorData, state.slot);
    const changedAt = serverNow();

    await update(ref(db, ROOM_PATH), {
      [`players/${state.slot}/name`]: name,
      [`players/${state.slot}/photo`]: state.editPhotoData || "",
      [`players/${state.slot}/color`]: chosenColor,
      profileChange: {
        slot: state.slot,
        at: changedAt
      }
    });

    refreshOwnCursorProfile(name, chosenColor);

    closeEditProfile();
    toast("Perfil atualizado!");
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  } finally {
    $("#saveEditProfileBtn").disabled = false;
  }
});


$("#nameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (!$("#joinBtn").disabled) $("#joinBtn").click();
  }
});

$("#joinBtn").addEventListener("click", async () => {
  const name = $("#nameInput").value.trim();
  if (name.length < 2) {
    message($("#entryMessage"), "Digite um nome com pelo menos 2 caracteres.", "error");
    return;
  }
  $("#joinBtn").disabled = true;
  message($("#entryMessage"), "Entrando no lobby...");
  try {
    await joinRoom(name, state.photoData);
    showScreen("screen-lobby");
  } catch (err) {
    console.error(err);
    message($("#entryMessage"), friendlyError(err), "error");
    $("#joinBtn").disabled = false;
  }
});

async function joinRoom(name, photo, preferredSlot = null) {
  const roomRef = ref(db, ROOM_PATH);

  // Ensure a lobby exists, but never overwrite an active lobby.
  await runTransaction(roomRef, (room) => {
    if (!room || room.status === "finished") {
      return {
        status: "lobby",
        createdAt: serverTimestamp(),
        players: {},
        ready: { p1: false, p2: false },
        rankings: { p1: {}, p2: {} },
        picks: { p1: {}, p2: {} },
        currentRound: 0
      };
    }
    return room;
  });

  const result = await runTransaction(roomRef, (room) => {
    if (!room) return;

    // Reconnection is allowed only for this exact tab identity.
    const owned = ["p1", "p2"].find(
      s => room.players?.[s]?.clientId === state.clientId
    );

    if (room.status !== "lobby") {
      return owned ? room : undefined;
    }

    const requestedSlot =
      preferredSlot &&
      ["p1", "p2"].includes(preferredSlot) &&
      !room.players?.[preferredSlot]
        ? preferredSlot
        : null;

    const slot =
      owned ||
      requestedSlot ||
      (!room.players?.p1 ? "p1" : !room.players?.p2 ? "p2" : null);

    if (!slot) return;

    room.players = room.players || {};
    room.players[slot] = {
      clientId: state.clientId,
      name,
      photo: photo || "",
      color: normalizePlayerColor(room.players?.[slot]?.color, slot)
    };

    room.ready = room.ready || {};
    if (room.ready[slot] == null) room.ready[slot] = false;

    return room;
  });

  if (!result.committed) {
    const snap = await get(roomRef);
    const room = snap.val();

    if (room?.status !== "lobby") {
      throw new Error("A partida já começou.");
    }

    throw new Error("O lobby já tem dois jogadores.");
  }

  const committedRoom = result.snapshot.val();
  const slot = ["p1", "p2"].find(
    s => committedRoom?.players?.[s]?.clientId === state.clientId
  );

  if (!slot) {
    throw new Error("Não foi possível confirmar sua vaga no lobby.");
  }

  state.slot = slot;
  updateNativeCursorVisibility();
  sessionStorage.setItem("shortRankSlot", slot);
  state.room = committedRoom;
}


async function joinLobbySlot(slot, { editAfter = false } = {}) {
  if (!["p1", "p2"].includes(slot)) return;

  if (state.slot) {
    if (state.slot === slot && editAfter) openEditProfile();
    return;
  }

  const defaultName = slot === "p1" ? "Player 1" : "Player 2";

  try {
    await joinRoom(defaultName, "", slot);
    if (state.room) renderLobby(state.room);

    if (editAfter) {
      setTimeout(() => openEditProfile(), 80);
    }
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  }
}

$("#readyBtn").addEventListener("click", async () => {
  if (!state.slot) return;
  $("#readyBtn").disabled = true;
  try {
    const configSnap = await get(ref(db, `${CONFIG_PATH}/shorts`));
    const shorts = configSnap.val();
    if (!Array.isArray(shorts) || shorts.filter(Boolean).length !== 10) {
      throw new Error("O ADM precisa ter exatamente 10 Shorts salvos antes de começar.");
    }

    await update(ref(db, `${ROOM_PATH}/ready`), { [state.slot]: true });
    toast("Pronto confirmado!");
  } catch (err) {
    console.error(err);
    $("#readyBtn").disabled = false;
    $("#lobbyHint").textContent = friendlyError(err);
  }
});

async function maybeStartGame(room) {
  if (room.status !== "lobby") return;
  if (!room.players?.p1 || !room.players?.p2 || !room.ready?.p1 || !room.ready?.p2) return;

  try {
    const shortsSnap = await get(ref(db, `${CONFIG_PATH}/shorts`));
    const shorts = shortsSnap.val();
    if (!Array.isArray(shorts) || shorts.filter(Boolean).length !== 10) return;

    await runTransaction(ref(db, ROOM_PATH), (liveRoom) => {
      if (!liveRoom || liveRoom.status !== "lobby") return liveRoom;
      if (!liveRoom.ready?.p1 || !liveRoom.ready?.p2) return liveRoom;

      liveRoom.status = "countdown";
      liveRoom.shorts = shorts;
      liveRoom.currentRound = 0;
      liveRoom.rankings = { p1: {}, p2: {} };
      liveRoom.picks = { p1: {}, p2: {} };
      liveRoom.countdownEndsAt = serverNow() + 5200;
      liveRoom.startedAt = serverTimestamp();
      return liveRoom;
    });
  } catch (err) {
    console.error("Falha ao iniciar:", err);
  }
}


function playMirroredProfileChange(room) {
  const pulse = room?.profileChange;
  if (!pulse?.slot || !pulse?.at) return;

  const key = `${pulse.slot}:${pulse.at}`;
  if (state.lastProfileChangeKey === key) return;
  state.lastProfileChangeKey = key;

  if (serverNow() - Number(pulse.at || 0) > 4500) return;

  requestAnimationFrame(() => {
    const card = pulse.slot === "p1" ? $("#lobbyP1") : $("#lobbyP2");
    if (!card) return;

    const color = normalizePlayerColor(room.players?.[pulse.slot]?.color, pulse.slot);
    card.style.setProperty("--player-color", color);

    card.classList.remove("profile-change-mirror");
    void card.offsetWidth;
    card.classList.add("profile-change-mirror");

    const avatar = card.querySelector(".player-avatar");
    const name = card.querySelector("h3");

    avatar?.classList.remove("profile-change-avatar");
    name?.classList.remove("profile-change-name");
    void card.offsetWidth;
    avatar?.classList.add("profile-change-avatar");
    name?.classList.add("profile-change-name");

    setTimeout(() => {
      card.classList.remove("profile-change-mirror");
      avatar?.classList.remove("profile-change-avatar");
      name?.classList.remove("profile-change-name");
    }, 950);
  });
}

function renderLobby(room = {}) {
  const renderCard = (slot) => {
    const p = room.players?.[slot];
    const mine = !!p && p.clientId === state.clientId;
    const label = slot === "p1" ? "Player 1" : "Player 2";
    const color = normalizePlayerColor(p?.color, slot);

    if (!p) {
      const blocked = !!state.slot && state.slot !== slot;

      return `
        <div
          class="lobby-profile-clickable empty-profile ${blocked ? "is-locked-other" : ""}"
          data-anchor="lobby-${slot}-profile"
          ${blocked ? "" : `data-lobby-action="join-edit" data-slot="${slot}" data-sync-key="lobby-${slot}-profile" tabindex="0" role="button"`}
        >
          <div class="player-avatar avatar-fallback">${blocked ? "×" : "+"}</div>
          <h3>${label}</h3>
          <p>${blocked ? "Disponível para o outro jogador" : "Vaga aberta"}</p>
        </div>
        <div class="lobby-card-action-slot" data-anchor="lobby-${slot}-action">
          ${
            blocked
              ? `<button
                  class="btn lobby-slot-btn lobby-slot-disabled"
                  disabled
                  aria-disabled="true"
                >
                  <svg class="lock-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5"/><rect x="5" y="10.5" width="14" height="10" rx="3"/></svg> Aguardando jogador
                </button>`
              : `<button
                  class="btn lobby-slot-btn"
                  data-lobby-action="join"
                  data-slot="${slot}"
                  data-sync-key="lobby-${slot}-join"
                >
                  Entrar
                </button>`
          }
        </div>
        <div class="lobby-ready-slot" data-anchor="lobby-${slot}-ready">
          <div class="ready-stamp is-waiting">aguardando confirmação</div>
        </div>`;
    }

    return `
      <div
        class="lobby-profile-clickable ${mine ? "is-mine" : "is-locked-other"}"
        data-anchor="lobby-${slot}-profile"
        ${mine ? `data-lobby-action="edit" data-slot="${slot}" data-sync-key="lobby-${slot}-profile" tabindex="0" role="button"` : ""}
      >
        ${avatarMarkup(p)}
        <h3>${esc(p.name)}</h3>
        <p>${label}</p>
      </div>

      <div class="lobby-card-action-slot" data-anchor="lobby-${slot}-action">
        ${
          mine
            ? `<button
                class="btn lobby-slot-btn"
                data-lobby-action="edit"
                data-slot="${slot}"
                data-sync-key="lobby-${slot}-edit"
              >
                Editar nome e foto
              </button>`
            : `<button
                class="btn lobby-slot-btn lobby-slot-disabled"
                disabled
                aria-disabled="true"
              >
                <svg class="lock-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5"/><rect x="5" y="10.5" width="14" height="10" rx="3"/></svg> Perfil bloqueado
              </button>`
        }
      </div>

      <div class="lobby-ready-slot" data-anchor="lobby-${slot}-ready">
        ${
          room.ready?.[slot]
            ? `<div class="ready-stamp">✓ PRONTO</div>`
            : `<div class="ready-stamp is-waiting">aguardando confirmação</div>`
        }
      </div>`;
  };

  // Selo + brilho da "carta 3D" (camadas absolutas: não mudam o tamanho do card).
  const cardExtras = (slot) => {
    const p = room.players?.[slot];
    const lockedOther = !!state.slot && state.slot !== slot;
    const mine = !!p && p.clientId === state.clientId;
    return `<span class="tilt-glare" aria-hidden="true"></span>${
      lockedOther
        ? `<span class="card-lock-chip" title="Só o outro jogador pode editar este perfil"><svg class="lock-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5"/><rect x="5" y="10.5" width="14" height="10" rx="3"/></svg><b>${p ? "do outro jogador" : "reservado"}</b></span>`
        : mine ? `<span class="card-you-chip">VOCÊ</span>` : ""
    }`;
  };
  $("#lobbyP1").innerHTML = renderCard("p1") + cardExtras("p1");
  $("#lobbyP2").innerHTML = renderCard("p2") + cardExtras("p2");
  $("#lobbyP1").classList.toggle("is-other-player", !!state.slot && state.slot !== "p1");
  $("#lobbyP2").classList.toggle("is-other-player", !!state.slot && state.slot !== "p2");

  $("#lobbyP1").style.setProperty("--player-color", normalizePlayerColor(room.players?.p1?.color, "p1"));
  $("#lobbyP2").style.setProperty("--player-color", normalizePlayerColor(room.players?.p2?.color, "p2"));

  $("#lobbyP1").classList.toggle("ready", !!room.ready?.p1);
  $("#lobbyP2").classList.toggle("ready", !!room.ready?.p2);
  $("#lobbyP1").classList.add("lobby-player-p1");
  $("#lobbyP2").classList.add("lobby-player-p2");

  const count =
    Number(!!room.players?.p1?.clientId) +
    Number(!!room.players?.p2?.clientId);

  $("#lobbyPulse").textContent = `${count}/2 conectados`;
  $("#lobbyPulse").classList.toggle("live", count === 2);

  const ownPlayer = state.slot ? room.players?.[state.slot] : null;

  if (!ownPlayer) {
    $("#readyBtn").disabled = true;
    $("#readyBtn").textContent = "Entre em um dos lados";
    $("#lobbyHint").innerHTML = 'Escolha <strong>Player 1</strong> ou <strong>Player 2</strong> para entrar.';
  } else {
    const amReady = !!room.ready?.[state.slot];
    $("#readyBtn").disabled = amReady;
    $("#readyBtn").textContent = amReady ? "✓ Você está pronto" : "Estou pronto!";

    $("#lobbyHint").textContent = count < 2
      ? "Esperando o outro jogador."
      : amReady
        ? "Esperando a confirmação do outro jogador."
        : "Os dois estão aqui. Confirme quando estiver pronto.";
  }

  $("#screen-lobby").querySelectorAll("[data-lobby-action]").forEach(el => {
    const activate = async () => {
      const action = el.dataset.lobbyAction;
      const slot = el.dataset.slot;

      if (action === "join") {
        await joinLobbySlot(slot, { editAfter: true });
      } else if (action === "join-edit") {
        await joinLobbySlot(slot, { editAfter: true });
      } else if (action === "edit") {
        if (!state.slot) {
          await joinLobbySlot(slot, { editAfter: true });
        } else if (state.slot === slot) {
          openEditProfile();
        }
      }
    };

    el.addEventListener("click", activate);

    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });

  // Juice: quando alguém confirma "pronto", carimbo + confete no card dele
  // (efeito numa camada separada, sem mexer na geometria do card).
  ["p1", "p2"].forEach(slot => {
    const isReady = !!room.players?.[slot] && !!room.ready?.[slot];
    const was = state.lastReady[slot];
    state.lastReady[slot] = isReady;
    if (was !== false || !isReady) return;

    const card = slot === "p1" ? $("#lobbyP1") : $("#lobbyP2");
    const color = normalizePlayerColor(room.players?.[slot]?.color, slot);
    card.classList.remove("ready-pop");
    void card.offsetWidth;
    card.classList.add("ready-pop");
    setTimeout(() => card.classList.remove("ready-pop"), 1000);

    requestAnimationFrame(() => {
      const c = centerOf(card.querySelector(".ready-stamp")) || centerOf(card);
      if (!c) return;
      fxRingAt(c.x, c.y, color, 200);
      fxBurst(c.x, c.y, { colors: [color, "#ffffff", "#ffe77a"], count: 24, spread: 150 });
    });
  });

  const readyAttention = !!ownPlayer && count === 2 && !room.ready?.[state.slot];
  $("#readyBtn").classList.toggle("attention", readyAttention);

  playMirroredProfileChange(room);
}

function updateShortTitle(title) {
  const wrap = $("#shortTitleWrap");
  const viewport = wrap?.querySelector(".title-marquee-viewport");
  const textEl = $("#shortTitleText");
  const tooltip = $("#shortTitleTooltip");
  if (!wrap || !viewport || !textEl || !tooltip) return;

  textEl.textContent = title;
  tooltip.textContent = title;
  wrap.classList.remove("is-overflowing");
  wrap.style.setProperty("--title-shift", "0px");

  requestAnimationFrame(() => {
    const textWidth = Math.ceil(textEl.scrollWidth || textEl.getBoundingClientRect().width);
    const viewportWidth = Math.floor(viewport.clientWidth || viewport.getBoundingClientRect().width);
    const overflow = Math.max(0, textWidth - viewportWidth + 24);
    if (overflow > 3) {
      wrap.classList.add("is-overflowing");
      wrap.style.setProperty("--title-shift", `${overflow}px`);
    }
  });
}

/* Capa listrada do palco: fica por baixo do 3-2-1, do número de curtidas
   e do suspense final — uma única camada contínua, então nunca aparece
   o fundo preto do player entre uma animação e outra. */
function setStageCover(on) {
  const cover = $("#stageCover");
  if (!cover) return;
  if (on) {
    cover.classList.remove("hidden", "is-leaving");
  } else {
    cover.classList.add("hidden");
    cover.classList.remove("is-leaving");
  }
}

/* Troféu / medalha no centro quando alguém confirma #1, #2 ou #3 (os dois veem). */
const PODIUM = { 1: { icon: "🏆", label: "TOP 1", cls: "gold" }, 2: { icon: "🥈", label: "TOP 2", cls: "silver" }, 3: { icon: "🥉", label: "TOP 3", cls: "bronze" } };
const podiumSeen = new Set();
let podiumPrimed = false;
function detectPodiumPicks(room, round) {
  const fresh = [];
  ["p1", "p2"].forEach(sl => {
    const pos = Number(room.picks?.[sl]?.[String(round)]);
    if (!PODIUM[pos]) return;
    const key = `${room.startedAt || ""}:${sl}:${round}:${pos}`;
    if (podiumSeen.has(key)) return;
    podiumSeen.add(key);
    if (podiumPrimed) fresh.push({ sl, pos });
  });
  podiumPrimed = true; // na primeira leitura (F5) não anima o que já existia
  fresh.forEach((f, i) => setTimeout(() => showPodium(f.sl, f.pos, room), i * 900));
}

function showPodium(slot, pos, room) {
  const stage = document.querySelector(".battle-stage");
  const info = PODIUM[pos];
  if (!stage || !info) return;
  const pl = room.players?.[slot] || {};
  const color = normalizePlayerColor(pl.color, slot);
  const el = document.createElement("div");
  el.className = `podium-pop ${info.cls}`;
  el.style.setProperty("--pc", color);
  el.innerHTML = `
    <span class="podium-rays" aria-hidden="true"></span>
    <span class="podium-icon">${info.icon}</span>
    <span class="podium-who">${pl.photo ? `<img src="${pl.photo}" alt="">` : `<i>${esc(initials(pl.name || slot))}</i>`}<b>${esc(pl.name || slot)}</b></span>
    <small>${info.label}</small>`;
  stage.appendChild(el);
  requestAnimationFrame(() => {
    const c = centerOf(el.querySelector(".podium-icon"));
    if (c) fxBurst(c.x, c.y, { colors: [info.cls === "gold" ? "#ffd35a" : info.cls === "silver" ? "#dfe8ee" : "#e0995a", color, "#ffffff"], count: 22, spread: 150, size: 9 });
  });
  el.addEventListener("animationend", (e) => { if (e.target === el) el.remove(); });
  setTimeout(() => el.remove(), 2400);
}

function setBothLocked(show) {
  const el = $("#bothLocked");
  if (!el) return;
  const was = el.classList.contains("show");
  el.classList.toggle("show", !!show);
  el.setAttribute("aria-hidden", show ? "false" : "true");
  if (show && !was) {
    requestAnimationFrame(() => {
      const c = centerOf(el.querySelector(".both-locked-check"));
      if (c) fxBurst(c.x, c.y, { colors: [playerColor("p1"), playerColor("p2"), "#ffffff"], count: 20, spread: 120, size: 8 });
    });
  }
}

function renderGame(room, { preview = false } = {}) {
  if (!state.slot || !room.players?.[state.slot]) return;

  const transitionOverlay = $("#shortTransitionOverlay");
  if (transitionOverlay && !preview && !transitionOverlay.classList.contains("leave")) {
    transitionOverlay.classList.add("hidden");
    transitionOverlay.classList.remove("leave", "tick");
    transitionOverlay.setAttribute("aria-hidden", "true");
  }
  setBothLocked(room.status === "confirmed");

  if (!preview) hideCountdownOverlay();

  const round = Number(room.currentRound || 0);
  const shorts = room.shorts || [];
  const current = shorts[round];
  if (!current) return;

  $("#roundNumber").textContent = `${round + 1}/10`;
  updateShortTitle(current.title || `Short #${round + 1}`);

  const p1 = room.players?.p1 || { name: "Player 1", photo: "" };
  const p2 = room.players?.p2 || { name: "Player 2", photo: "" };

  $("#p1Name").textContent = p1.name || "Player 1";
  $("#p2Name").textContent = p2.name || "Player 2";

  document.querySelector(".player-one-panel")?.style.setProperty("--player-color", normalizePlayerColor(p1.color, "p1"));
  document.querySelector(".player-two-panel")?.style.setProperty("--player-color", normalizePlayerColor(p2.color, "p2"));
  $("#cursorP1")?.style.setProperty("--cursor-color", normalizePlayerColor(p1.color, "p1"), "important");
  $("#cursorP2")?.style.setProperty("--cursor-color", normalizePlayerColor(p2.color, "p2"), "important");

  $("#p1MiniAvatar").innerHTML = p1.photo
    ? `<img src="${p1.photo}" alt="">`
    : esc(initials(p1.name || "1"));

  $("#p2MiniAvatar").innerHTML = p2.photo
    ? `<img src="${p2.photo}" alt="">`
    : esc(initials(p2.name || "2"));

  renderRankingSlotsTo(
    "#p1RankingSlots",
    room.rankings?.p1 || {},
    shorts,
    state.slot === "p1",
    room.thinking?.p1 || null,
    p1.name || "Player 1",
    "p1"
  );

  renderRankingSlotsTo(
    "#p2RankingSlots",
    room.rankings?.p2 || {},
    shorts,
    state.slot === "p2",
    room.thinking?.p2 || null,
    p2.name || "Player 2",
    "p2"
  );

  const ranking = room.rankings?.[state.slot] || {};
  const pickedThisRound = room.picks?.[state.slot]?.[String(round)] != null;
  const revealDone = state.revealRound === round;

  // Não recriar o iframe/video em cada atualização do Firebase.
  // Isso evita pausar/reiniciar o Short ao escolher ou confirmar posição.
  if (preview) {
    setStageCover(true);
  } else if (!revealDone) {
    startApprovalReveal(round, current);
  } else {
    $("#approvalReveal").classList.add("hidden");

    if (state.mountedMediaRound !== round || !$("#mediaWrap").children.length) {
      mountMedia(current, round);
    }
  }

  renderPositionButtons(ranking, pickedThisRound || !revealDone, revealDone ? round : null);

  detectPodiumPicks(room, round);

  const pickedPos = room.picks?.[state.slot]?.[String(round)];
  if (pickedPos != null) {
    const wp = $("#waitingPosition");
    wp.textContent = `#${pickedPos}`;
    wp.style.setProperty("--pick-color", positionColor(pickedPos));
  }

  $("#waitingBox").classList.toggle("hidden", !pickedThisRound);
  $("#positionButtons").classList.toggle("hidden", pickedThisRound);

  $("#gameStatus").textContent = preview
    ? "começando"
    : room.status === "confirmed"
    ? "os dois escolheram"
    : !revealDone
    ? "revelando avaliação"
    : pickedThisRound
      ? "posição confirmada"
      : "escolhendo";

  $("#gameStatus").classList.toggle("live", revealDone && !pickedThisRound);
}

function findShortById(shorts, id) {
  return (shorts || []).find(s => s?.id === id);
}

function prepareRankingTitleHovers(container) {
  if (!container) return;
  requestAnimationFrame(() => {
    container.querySelectorAll(".rank-title").forEach(title => {
      const span = title.querySelector(".rank-title-text");
      if (!span) return;
      title.classList.remove("is-overflowing");
      title.style.setProperty("--rank-title-shift", "0px");
      const available = Math.floor(title.clientWidth);
      const needed = Math.ceil(span.scrollWidth || span.getBoundingClientRect().width);
      const overflow = Math.max(0, needed - available + 14);
      if (overflow > 3) {
        title.classList.add("is-overflowing");
        title.style.setProperty("--rank-title-shift", `${overflow}px`);
      }
    });
  });
}

function renderRankingSlotsTo(
  selector,
  ranking,
  shorts,
  isSelf = false,
  thinking = null,
  playerName = "Jogador",
  playerSlot = ""
) {
  const el = $(selector);
  const currentRound = Number(state.room?.currentRound || 0);
  const burstKeys = [];
  el.innerHTML = Array.from({ length: 10 }, (_, i) => {
    const pos = String(i + 1);
    const shortId = ranking[pos];
    const item = shortId ? findShortById(shorts, shortId) : null;
    const thumb = item ? thumbFor(item) : "";
    const isThinking = thinking && Number(thinking.round) === currentRound && Number(thinking.position) === i + 1 && !item;
    const animationKey = item ? `${playerSlot}:${pos}:${shortId}` : "";
    const shouldAnimate = item && !state.animatedSlots.has(animationKey);
    if (shouldAnimate) {
      if (state.lastObservedRound !== null) setTimeout(() => state.animatedSlots.add(animationKey), 1000);
      else state.animatedSlots.add(animationKey);
    }
    const classes = ["rank-slot", item ? "filled" : "", isThinking ? "thinking" : "", shouldAnimate && state.lastObservedRound !== null ? "just-added" : ""].filter(Boolean).join(" ");
    if (shouldAnimate && state.lastObservedRound !== null && !state.burstedSlots.has(animationKey)) {
      state.burstedSlots.add(animationKey);
      burstKeys.push(pos);
    }
    const rawTitle = item ? (item.title || "Short") : isThinking ? `${playerName} está pensando nessa posição` : "— livre —";
    return `
      <div class="${classes}" data-anchor="${playerSlot}-slot-${pos}" ${isSelf ? 'data-self="1"' : ''}>
        <div class="rank-num">${i + 1}</div>
        <div class="rank-content">
          ${item && thumb ? `<img class="rank-thumb" src="${thumb}" alt="">` : item ? `<div class="rank-thumb"></div>` : ""}
          <div class="rank-title" data-full-title="${esc(rawTitle)}"><span class="rank-title-text">${esc(rawTitle)}</span></div>
          ${isThinking ? `<div class="thinking-badge">pensando</div>` : ""}
        </div>
      </div>`;
  }).join("");
  prepareRankingTitleHovers(el);

  // Confete no slot que acabou de ser preenchido (visível para os dois jogadores).
  if (burstKeys.length) {
    const color = normalizePlayerColor(state.room?.players?.[playerSlot]?.color, playerSlot);
    setTimeout(() => {
      burstKeys.forEach(pos => {
        const slotEl = el.querySelector(`[data-anchor="${playerSlot}-slot-${pos}"]`);
        const c = centerOf(slotEl);
        if (!c) return;
        fxRingAt(c.x, c.y, color, 150);
        fxBurst(c.x, c.y, { colors: [color, positionColor(pos), "#ffffff"], count: 18, spread: 120, size: 8 });
      });
    }, 260);
  }
}



/* =====================================================================
   Revelação de "quantas pessoas gostaram"
   Fundo com listras infinitas (só no container central), reações subindo,
   contagem tremendo e um "SLAM" no número final.
   ===================================================================== */
const APPROVAL_COUNT_MS = 1750;   // duração da contagem
const APPROVAL_EXIT_AT = 3050;    // quando começa a saída
const APPROVAL_EXIT_MS = 480;     // duração da saída (cortina)
const REACTION_EMOJIS = ["👍", "❤️", "🔥", "😂", "🤩", "💯", "👏", "😍"];

function spawnApprovalReaction(container, { fromCenter = false } = {}) {
  if (!container || !container.isConnected) return;
  const rect = container.getBoundingClientRect();
  if (!rect.width) return;

  const el = document.createElement("i");
  el.className = "approval-reaction";
  el.textContent = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
  const size = 20 + Math.random() * 22;
  el.style.fontSize = `${size}px`;

  let startX, startY, endX, endY, duration;
  if (fromCenter) {
    startX = rect.width / 2;
    startY = rect.height * .46;
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.min(rect.width, rect.height) * (.28 + Math.random() * .3);
    endX = startX + Math.cos(angle) * dist;
    endY = startY + Math.sin(angle) * dist - 40;
    duration = 900 + Math.random() * 500;
  } else {
    startX = rect.width * (.06 + Math.random() * .88);
    startY = rect.height + 30;
    endX = startX + (Math.random() - .5) * 120;
    endY = -60;
    duration = 1700 + Math.random() * 1100;
  }

  el.style.left = "0px";
  el.style.top = "0px";
  container.appendChild(el);

  const sway = (Math.random() - .5) * 50;
  const anim = el.animate([
    { transform: `translate(${startX}px,${startY}px) translate(-50%,-50%) scale(.2) rotate(0deg)`, opacity: 0 },
    { transform: `translate(${startX + sway}px,${startY + (endY - startY) * .25}px) translate(-50%,-50%) scale(1.1) rotate(${sway * .3}deg)`, opacity: 1, offset: .18 },
    { transform: `translate(${endX - sway}px,${startY + (endY - startY) * .7}px) translate(-50%,-50%) scale(1) rotate(${-sway * .3}deg)`, opacity: .95, offset: .7 },
    { transform: `translate(${endX}px,${endY}px) translate(-50%,-50%) scale(.85) rotate(0deg)`, opacity: 0 }
  ], { duration, easing: fromCenter ? "cubic-bezier(.12,.8,.3,1)" : "linear", fill: "forwards" });
  anim.onfinish = () => el.remove();
  setTimeout(() => el.remove(), duration + 400);
}

function stopApprovalReactions() {
  clearInterval(state.approvalReactionTimer);
  state.approvalReactionTimer = null;
}

function clearApprovalReactions() {
  stopApprovalReactions();
  const box = $("#approvalReactions");
  if (box) box.innerHTML = "";
}

function animateCount(target, duration = APPROVAL_COUNT_MS, onDone = null) {
  const el = $("#fakeVotes");
  const fill = $("#approvalMeterFill");
  const start = performance.now();
  const total = Math.max(0, Number(target || 0));
  let lastText = "";

  el.classList.remove("is-slam");
  el.classList.add("is-counting");
  if (fill) fill.style.transform = "scaleX(0)";

  function frame(now) {
    if (!el.isConnected || $("#approvalReveal")?.classList.contains("hidden")) return;
    const p = Math.min(1, (now - start) / duration);
    // Começa rápido, desacelera no fim para dar suspense.
    const eased = 1 - Math.pow(1 - p, 3.2);
    const text = formatCount(Math.floor(total * eased));
    if (text !== lastText) {
      el.textContent = text;
      lastText = text;
    }
    if (fill) fill.style.transform = `scaleX(${eased.toFixed(4)})`;

    if (p < 1) {
      requestAnimationFrame(frame);
    } else {
      el.textContent = formatCount(total);
      el.classList.remove("is-counting");
      void el.offsetWidth;
      el.classList.add("is-slam");
      onDone?.();
    }
  }
  el.textContent = formatCount(0);
  requestAnimationFrame(frame);
}

function approvalSlam() {
  const overlay = $("#approvalReveal");
  if (!overlay || overlay.classList.contains("hidden")) return;
  overlay.classList.remove("is-slammed");
  void overlay.offsetWidth;
  overlay.classList.add("is-slammed");

  const numberCenter = centerOf($("#fakeVotes"));
  if (numberCenter) {
    fxBurst(numberCenter.x, numberCenter.y, {
      colors: ["#ffe77a", "#66efff", "#ffffff", "#ff9b42"],
      count: 26,
      spread: 190,
      size: 10,
      gravity: 80
    });
  }
  const box = $("#approvalReactions");
  for (let i = 0; i < 10; i++) spawnApprovalReaction(box, { fromCenter: true });
}

function startApprovalReveal(round, item) {
  if (!item) return;
  if (state.revealRound === round) return;
  if (state.revealTimer && state.revealingRound === round) return;
  if (state.revealTimer) { clearTimeout(state.revealTimer); state.revealTimer = null; }
  state.revealingRound = round;
  setStageCover(true);

  // Nada do próximo Short pode existir atrás da revelação.
  // O iframe/video só é montado depois que a animação terminou por completo.
  unmountMedia();
  state.mediaPausedByUser = false;

  const overlay = $("#approvalReveal");
  overlay.classList.remove("hidden", "approval-exit", "is-slammed");
  overlay.setAttribute("aria-hidden", "false");
  void overlay.offsetWidth;
  overlay.classList.add("approval-enter");

  clearApprovalReactions();
  const box = $("#approvalReactions");
  if (!prefersReducedMotion()) {
    for (let i = 0; i < 5; i++) setTimeout(() => spawnApprovalReaction(box), i * 90);
    state.approvalReactionTimer = setInterval(() => spawnApprovalReaction(box), 170);
  }

  animateCount(Number(item.fakeVotes || 0), APPROVAL_COUNT_MS, approvalSlam);

  state.revealTimer = setTimeout(() => {
    stopApprovalReactions();
    overlay.classList.remove("approval-enter");
    overlay.classList.add("approval-exit");
    $("#stageCover")?.classList.add("is-leaving");
    state.revealTimer = setTimeout(() => {
      state.revealRound = round;
      state.revealTimer = null;
      state.revealingRound = null;
      overlay.classList.add("hidden");
      overlay.classList.remove("approval-exit", "is-slammed");
      overlay.setAttribute("aria-hidden", "true");
      setStageCover(false);
      clearApprovalReactions();
      mountMedia(item, round);
      if (state.room?.status === "playing" && Number(state.room.currentRound || 0) === round) renderGame(state.room);
    }, APPROVAL_EXIT_MS);
  }, APPROVAL_EXIT_AT);
}

function animateCountdownNumber(value) {
  const el = $("#countdownValue");
  const isWord = String(value).includes("JULGUE");
  el.textContent = value;
  el.classList.toggle("is-word", isWord);
  el.classList.remove("countdown-number-animate");
  const motion = el.closest(".countdown-motion");
  const overlayEl = $("#countdownOverlay");
  const CD_COLORS = { "3": "#19c7ec", "2": "#ffc93a", "1": "#ff6b85" };
  overlayEl?.style.setProperty("--cd-color", CD_COLORS[value] || "#ffe77a");
  overlayEl?.classList.remove("cd-flash");
  motion?.classList.remove("is-ticking", "is-word-tick");
  void el.offsetWidth;
  el.classList.add("countdown-number-animate");
  overlayEl?.classList.add("cd-flash");
  motion?.classList.add(isWord ? "is-word-tick" : "is-ticking");

  if (isWord) {
    requestAnimationFrame(() => {
      const c = centerOf(el);
      if (c) fxBurst(c.x, c.y, { colors: ["#66efff", "#ffe77a", "#ffffff"], count: 30, spread: 260, size: 12, gravity: 90 });
    });
  }
}

function startCountdown(room) {
  const key = String(room.countdownEndsAt || room.startedAt || "countdown");

  if (
    $("#screen-lobby")?.classList.contains("active") &&
    state.lobbyTransitionKey !== key
  ) {
    state.lobbyTransitionKey = key;

    const lobby = $("#screen-lobby");
    lobby.classList.remove("lobby-leaving");
    void lobby.offsetWidth;
    lobby.classList.add("lobby-leaving");

    clearTimeout(state.lobbyTransitionTimer);
    state.lobbyTransitionTimer = setTimeout(() => {
      lobby.classList.remove("lobby-leaving");
      state.lobbyTransitionTimer = null;
      startCountdownCore(room);
    }, 480);

    return;
  }

  if (state.lobbyTransitionTimer) return;
  startCountdownCore(room);
}

function startCountdownCore(room) {
  showScreen("screen-game");
  destroyCurrentMedia();
  renderGame(room, { preview: true });
  const overlay = $("#countdownOverlay");
  overlay.classList.remove("hidden", "countdown-fade-out");
  overlay.setAttribute("aria-hidden", "false");
  $("#gameStatus").textContent = "começando";

  clearInterval(state.countdownTimer);

  const end = Number(room.countdownEndsAt || (serverNow() + 5200));
  let lastValue = null;

  const tick = async () => {
    const left = end - serverNow();

    if (left <= 0) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      // O número de curtidas já começa por baixo da contagem que está sumindo.
      state.revealRound = null;
      startApprovalReveal(0, room.shorts?.[0]);
      overlay.classList.add("countdown-fade-out");
      const gameScreen = $("#screen-game");
      gameScreen.classList.remove("game-reveal");
      void gameScreen.offsetWidth;
      gameScreen.classList.add("game-reveal");
      setTimeout(() => gameScreen.classList.remove("game-reveal"), 900);

      setTimeout(() => {
        overlay.classList.add("hidden");
        overlay.classList.remove("countdown-fade-out");
        overlay.setAttribute("aria-hidden", "true");
      }, 780);

      try {
        await hostTurn();
        await runTransaction(ref(db, ROOM_PATH), live => {
          if (!live || live.status !== "countdown") return live;
          if (Number(live.countdownEndsAt || 0) > serverNow() + 150) return live;
          live.status = "playing";
          live.currentRound = 0;
          return live;
        });
      } catch (err) {
        console.error("Falha ao terminar contagem:", err);
      }
      return;
    }

    // The lobby transition consumes roughly half a second before this starts.
    // Explicit stages avoid the old one-frame "4" caused by Math.ceil().
    // O JULGUE! fica ~1,6 s na tela (antes era só meio segundo).
    const value =
      left > 3600 ? "3" :
      left > 2600 ? "2" :
      left > 1600 ? "1" :
                    "JULGUE!";

    if (value !== lastValue) {
      lastValue = value;
      animateCountdownNumber(value);
    }
  };

  tick();
  state.countdownTimer = setInterval(tick, 100);
}

/* Os 10 botões são criados uma vez só e depois apenas atualizados.
   Assim as posições já usadas aparecem marcadas desde o começo da
   rodada (durante o número de curtidas), sem "piscar" no fim da animação. */
function ensurePositionButtons() {
  const container = $("#positionButtons");
  if (container.querySelectorAll(".pos-btn").length === 10) return container;
  container.innerHTML = Array.from({ length: 10 }, (_, i) => {
    const pos = String(i + 1);
    return `<button class="pos-btn" style="--i:${i}" data-pos="${pos}" data-sync-key="position-${pos}" disabled><span class="pos-btn-num">${pos}</span><kbd class="pos-btn-key">${pos === "10" ? "0" : pos}</kbd></button>`;
  }).join("");
  container.querySelectorAll(".pos-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const c = centerOf(btn);
      const color = positionColor(btn.dataset.pos);
      if (c) fxBurst(c.x, c.y, { colors: [color, "#ffffff"], count: 12, spread: 70, size: 7, gravity: 30, duration: 620 });
      openConfirm(Number(btn.dataset.pos));
    });
  });
  return container;
}

function renderPositionButtons(ranking, locked, round = null) {
  const container = ensurePositionButtons();
  const wasLocked = container.classList.contains("is-locked");
  container.classList.toggle("is-locked", !!locked);

  container.querySelectorAll(".pos-btn").forEach(btn => {
    const pos = btn.dataset.pos;
    const isUsed = !!ranking[pos];
    btn.classList.toggle("used", isUsed);
    btn.disabled = isUsed || !!locked;
    btn.style.setProperty("--position-color", positionColor(pos));
    btn.setAttribute("aria-label", isUsed ? `Posição ${pos} (ocupada)` : `Posição ${pos}`);

    // Foto de quem escolheu esta posição NESTE Short (os dois jogadores veem):
    // confirmado = foto normal; só selecionado (pensando) = foto pulsando.
    const curRound = Number(state.room?.currentRound || 0);
    const owners = ["p1", "p2"].map(sl => {
      const picked = state.room?.picks?.[sl]?.[String(curRound)];
      if (picked != null) return Number(picked) === Number(pos) ? { sl, kind: "done" } : null;
      const th = state.room?.thinking?.[sl];
      if (th && Number(th.round) === curRound && Number(th.position) === Number(pos)) return { sl, kind: "thinking" };
      return null;
    }).filter(Boolean);
    const sig = owners.map(o => `${o.sl}:${o.kind}:${state.room?.players?.[o.sl]?.name || ""}:${(state.room?.players?.[o.sl]?.photo || "").length}:${state.room?.players?.[o.sl]?.color || ""}`).join("|");
    if (btn.dataset.ownersSig !== sig) {
      const prevDone = (btn.dataset.ownersSig || "").split("|").filter(x => x.includes(":done:")).length;
      btn.dataset.ownersSig = sig;
      let box = btn.querySelector(".pos-owners");
      if (!box) {
        box = document.createElement("span");
        box.className = "pos-owners";
        btn.appendChild(box);
      }
      box.innerHTML = owners.map(o => {
        const pl = state.room?.players?.[o.sl] || {};
        const color = normalizePlayerColor(pl.color, o.sl);
        const cls = `pos-owner ${o.kind === "thinking" ? "is-thinking" : "is-done"}`;
        return pl.photo
          ? `<img class="${cls}" src="${pl.photo}" alt="" style="--oc:${color}">`
          : `<i class="${cls}" style="--oc:${color}">${esc(initials(pl.name || o.sl))}</i>`;
      }).join("");
      const nm = (o) => state.room?.players?.[o.sl]?.name || (o.sl === "p1" ? "Player 1" : "Player 2");
      if (owners.length) {
        btn.dataset.ownerNames = owners.map(nm).join(" e ");
        btn.dataset.fullTitle = owners.map(o => `${nm(o)} ${o.kind === "done" ? "escolheu" : "está pensando no"} #${pos}`).join(" • ");
      } else {
        delete btn.dataset.ownerNames;
        delete btn.dataset.fullTitle;
      }
      btn.classList.toggle("has-owners", owners.length > 0);
      const nowDone = owners.filter(o => o.kind === "done").length;
      if (nowDone > prevDone && btn.dataset.ownersInit === "1") {
        box.classList.remove("pop");
        void box.offsetWidth;
        box.classList.add("pop");
      }
      btn.dataset.ownersInit = "1";
      if (posTipTarget === btn && btn.dataset.fullTitle) showFloatTip(btn);
    }
  });

  // Quando destrava numa rodada nova, os botões livres dão um "acordar".
  if (wasLocked && !locked && round != null && state.buttonsIntroRound !== round) {
    state.buttonsIntroRound = round;
    const free = [...container.querySelectorAll(".pos-btn:not(.used)")];
    free.forEach(btn => {
      btn.classList.remove("wake");
      void btn.offsetWidth;
      btn.classList.add("wake");
      setTimeout(() => btn.classList.remove("wake"), 900);
    });
  }
}

function setThinkingPosition(pos) {
  if (!state.slot || !state.room || state.room.status !== "playing") return;

  const round = Number(state.room.currentRound || 0);

  set(ref(db, `${ROOM_PATH}/thinking/${state.slot}`), {
    round,
    position: Number(pos)
  }).catch(err => console.error("Falha ao sincronizar pensamento:", err));
}

function clearThinkingPosition() {
  if (!state.slot) return;

  set(ref(db, `${ROOM_PATH}/thinking/${state.slot}`), null)
    .catch(err => console.error("Falha ao limpar pensamento:", err));
}

function openConfirm(pos) {
  if (state.lockingPick) return;
  state.pendingPosition = pos;
  const color = positionColor(pos);
  const modal = $("#confirmModal");
  const card = modal.querySelector(".confirm-card");
  $("#confirmPosition").textContent = pos;
  $("#confirmPositionText").textContent = pos;
  card.style.setProperty("--pick-color", color);

  const round = Number(state.room?.currentRound || 0);
  const short = state.room?.shorts?.[round];
  $("#confirmShortTitle").textContent = short?.title ? `“${short.title}”` : "";

  modal.classList.remove("hidden", "is-locking");
  modal.setAttribute("aria-hidden", "false");
  // reinicia as animações de entrada
  card.classList.remove("is-open");
  void card.offsetWidth;
  card.classList.add("is-open");
  setThinkingPosition(pos);
  setTimeout(() => $("#confirmPickBtn")?.focus({ preventScroll: true }), 30);
}

function closeConfirm() {
  state.pendingPosition = null;
  $("#confirmModal").classList.add("hidden");
  $("#confirmModal").classList.remove("is-locking");
  $("#confirmModal").setAttribute("aria-hidden", "true");
  clearThinkingPosition();
}
$("#cancelPickBtn").addEventListener("click", () => {
  if (!state.lockingPick) closeConfirm();
});
$("#confirmModal").addEventListener("click", e => {
  if (e.target.id === "confirmModal" && !state.lockingPick) closeConfirm();
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function showLockStamp(position) {
  const stage = document.querySelector(".battle-stage");
  if (!stage) return;
  if (Number(position) <= 3) return; // #1–#3 ganham troféu/medalha no lugar do carimbo
  stage.querySelectorAll(".lock-stamp").forEach(el => el.remove());
  const stamp = document.createElement("div");
  stamp.className = "lock-stamp";
  stamp.style.setProperty("--pick-color", positionColor(position));
  stamp.style.setProperty("--player-color", playerColor(state.slot));
  stamp.innerHTML = `<small>TRAVADO</small><strong>#${esc(position)}</strong>`;
  stage.appendChild(stamp);
  stamp.addEventListener("animationend", () => stamp.remove(), { once: true });
  setTimeout(() => stamp.remove(), 1600);
}

$("#confirmPickBtn").addEventListener("click", async () => {
  const position = state.pendingPosition;
  if (!position || !state.slot || state.lockingPick) return;
  state.lockingPick = true;
  $("#confirmPickBtn").disabled = true;
  try {
    await lockPick(position);

    // Carimbo: o cadeado fecha, anel + confete na cor da posição.
    const modal = $("#confirmModal");
    modal.classList.add("is-locking");
    const c = centerOf($("#confirmBadge"));
    const color = positionColor(position);
    if (c) {
      fxRingAt(c.x, c.y, color, 240);
      fxBurst(c.x, c.y, { colors: [color, playerColor(state.slot), "#ffffff"], count: 28, spread: 190, size: 10 });
    }
    await wait(460);
    state.lockingPick = false;
    closeConfirm();
    showLockStamp(position);
  } catch (err) {
    console.error(err);
    state.lockingPick = false;
    toast(friendlyError(err));
  } finally {
    state.lockingPick = false;
    $("#confirmPickBtn").disabled = false;
  }
});

/* Atalhos de teclado (qualidade de vida):
   1–9 e 0 escolhem a posição, Enter confirma, Esc volta/fecha. */
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = e.target?.closest?.("input, textarea, [contenteditable='true']");

  const confirmOpen = !$("#confirmModal").classList.contains("hidden");
  if (confirmOpen) {
    if (e.key === "Escape") { e.preventDefault(); if (!state.lockingPick) closeConfirm(); }
    else if (e.key === "Enter") { e.preventDefault(); $("#confirmPickBtn").click(); }
    return;
  }

  if (e.key === "Escape") {
    if (!$("#cropModal").classList.contains("hidden")) { e.preventDefault(); closeCropper(); return; }
  }

  if (typing) return;
  if (!/^[0-9]$/.test(e.key)) return;
  if (!$("#screen-game").classList.contains("active")) return;
  if (state.room?.status !== "playing") return;
  const pos = e.key === "0" ? "10" : e.key;
  const btn = $(`#positionButtons .pos-btn[data-pos="${pos}"]`);
  if (btn && !btn.disabled && !$("#positionButtons").classList.contains("hidden")) {
    e.preventDefault();
    btn.click();
  }
});

/* Registrar a escolha SEM transação na sala inteira.
   Antes, cada voto baixava e reenviava a sala toda (com as duas fotos) e
   brigava com as escritas do outro jogador — na internet real isso podia
   travar o popup ou falhar. Como só este navegador escreve no próprio slot,
   basta conferir o estado atual e gravar os 3 campos de uma vez. */
async function lockPick(position) {
  const room = state.room;
  if (!room || room.status !== "playing") throw new Error("A rodada já mudou.");
  const round = Number(room.currentRound || 0);
  const posKey = String(position);
  const roundKey = String(round);
  if (room.picks?.[state.slot]?.[roundKey] != null) return;
  if (room.rankings?.[state.slot]?.[posKey]) throw new Error("Essa posição já foi usada.");
  const current = room.shorts?.[round];
  if (!current) throw new Error("Short não encontrado.");

  await update(ref(db, ROOM_PATH), {
    [`rankings/${state.slot}/${posKey}`]: current.id,
    [`picks/${state.slot}/${roundKey}`]: Number(position),
    [`thinking/${state.slot}`]: null
  });
}

/* Mudanças de fase (contagem → jogo, confirmação → transição...) são feitas
   pelo P1; o P2 só age se, depois de um instante, ninguém tiver feito.
   Evita os dois navegadores disputando a mesma transação ao mesmo tempo. */
async function hostTurn() {
  if (state.slot === "p2") await new Promise(r => setTimeout(r, 1200));
}



function preloadNextRoundMedia(room) {
  const target = Number(room.transitionToRound);
  const item = room.shorts?.[target];
  if (!item) return;

  // Do not mount the next iframe inside the visible player during the countdown.
  // The transition overlay hides the old Short; after the countdown, the approval
  // animation runs, and only then is the new player mounted fresh with autoplay.
  state.revealRound = null;
  state.mediaPausedByUser = false;
}

function renderConfirmedPause(room) {
  showScreen("screen-game");
  renderGame(room);
  const endAt = Number(room.confirmPauseEndsAt || 0);
  const delay = Math.max(0, endAt - serverNow());
  clearTimeout(state.confirmPauseTimer);
  state.confirmPauseTimer = setTimeout(async () => {
    try {
      await hostTurn();
      await runTransaction(ref(db, ROOM_PATH), live => {
        if (!live || live.status !== "confirmed") return live;
        if (Number(live.confirmPauseEndsAt || 0) > serverNow() + 60) return live;
        const r = Number(live.currentRound || 0);
        live.confirmPauseEndsAt = null;
        if (r >= 9) {
          live.status = "finishing";
          live.finishTransitionEndsAt = serverNow() + 3000;
        } else {
          live.status = "transition";
          live.transitionFromRound = r;
          live.transitionToRound = r + 1;
          live.transitionEndsAt = serverNow() + 4000;
        }
        return live;
      });
    } catch (err) {
      console.error("Falha ao iniciar contagem pós-confirmação:", err);
    }
  }, delay + 20);
}

function renderSyncedStageTransition(room, isFinish = false) {
  showScreen("screen-game");
  const overlay = $("#shortTransitionOverlay");
  const value = $("#shortTransitionValue");
  const label = $("#shortTransitionLabel");
  if (!overlay || !value || !label) return;

  if (!isFinish) {
    preloadNextRoundMedia(room);
    pausePreparedMedia();
  }

  const endAt = Number(isFinish ? room.finishTransitionEndsAt : room.transitionEndsAt) || (serverNow() + (isFinish ? 3000 : 4000));
  const wasFinish = overlay.classList.contains("is-finish") && !overlay.classList.contains("hidden");
  label.textContent = isFinish ? "FIM DOS SHORTS" : "PRÓXIMO SHORT";
  overlay.classList.toggle("is-finish", !!isFinish);
  overlay.classList.remove("hidden", "leave");
  overlay.setAttribute("aria-hidden", "false");
  setBothLocked(false);
  setStageCover(true);
  if (state.revealingRound == null) $("#approvalReveal")?.classList.add("hidden");
  $("#stageCover")?.classList.toggle("is-finish", !!isFinish);

  if (isFinish) {
    // Final: sem 3-2-1, só um suspense curtinho (~3 s) com tambores.
    stopCurrentMedia();
    if (!wasFinish) {
      value.innerHTML = 'Preparando os resultados<span class="suspense-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>';
      value.classList.add("is-word");
      overlay.classList.remove("tick", "is-word-tick");
      overlay.style.setProperty("--suspense-ms", `${Math.max(400, endAt - serverNow())}ms`);
      void overlay.offsetWidth;
      overlay.classList.add("suspense-run");
    }
  } else {
    overlay.classList.remove("suspense-run");
  }

  if (!isFinish) {
    // Prevent any one-frame flash of the previous Short underneath the transition.
    unmountMedia();
  }

  clearTimeout(state.roundTransitionTimer);

  const tick = async () => {
    const left = endAt - serverNow();
    if (left <= 0) {
      if (!isFinish) {
        // JULGUE! sai de cena enquanto o número de curtidas já entra por baixo.
        const target = Number(room.transitionToRound ?? (Number(room.currentRound || 0) + 1));
        state.revealRound = null;
        startApprovalReveal(target, room.shorts?.[target]);
      }
      overlay.classList.add("leave");
      state.roundTransitionTimer = setTimeout(async () => {
        overlay.classList.add("hidden");
        overlay.classList.remove("leave", "tick", "is-word-tick", "suspense-run");
        overlay.setAttribute("aria-hidden", "true");
        value.textContent = "";
        value.classList.remove("is-word");

        try {
          await hostTurn();
          await runTransaction(ref(db, ROOM_PATH), live => {
            if (!live) return live;
            if (!isFinish && live.status === "transition") {
              const target = Number(live.transitionToRound ?? (Number(live.currentRound || 0) + 1));
              if (Number(live.transitionEndsAt || 0) > serverNow() + 60) return live;
              live.currentRound = target;
              live.status = "playing";
              live.transitionEndsAt = null;
              live.transitionFromRound = null;
              live.transitionToRound = null;
              return live;
            }
            if (isFinish && live.status === "finishing") {
              if (Number(live.finishTransitionEndsAt || 0) > serverNow() + 60) return live;
              live.status = "finished";
              live.finishedAt = serverNow();
              live.finishTransitionEndsAt = null;
              return live;
            }
            return live;
          });
        } catch (err) {
          console.error("Falha ao concluir transição sincronizada:", err);
        }
      }, 260);
      return;
    }

    if (isFinish) {
      state.roundTransitionTimer = setTimeout(tick, 70);
      return;
    }

    const displayValue = (
          left > 3000 ? "3" :
          left > 2000 ? "2" :
          left > 1000 ? "1" :
                        "JULGUE!"
        );

    if (value.textContent !== displayValue) {
      const isWord = displayValue.includes("JULGUE");
      value.textContent = displayValue;
      value.classList.toggle("is-word", isWord);
      overlay.classList.remove("tick");
      overlay.classList.toggle("is-word-tick", isWord);
      void overlay.offsetWidth;
      overlay.classList.add("tick");
      if (isWord) {
        requestAnimationFrame(() => {
          const c = centerOf(value);
          if (c) fxBurst(c.x, c.y, { colors: ["#66efff", "#ffe77a", "#ffffff"], count: 22, spread: 170, size: 10 });
        });
      }
    }

    state.roundTransitionTimer = setTimeout(tick, 70);
  };
  tick();
}

let advancingRound = false;
async function maybeAdvanceRound(room) {
  if (advancingRound || room.status !== "playing") return;
  const round = Number(room.currentRound || 0);
  const key = String(round);
  if (room.picks?.p1?.[key] == null || room.picks?.p2?.[key] == null) return;

  advancingRound = true;
  try {
    await hostTurn();
    await runTransaction(ref(db, ROOM_PATH), live => {
      if (!live || live.status !== "playing") return live;
      const r = Number(live.currentRound || 0);
      const k = String(r);
      if (live.picks?.p1?.[k] == null || live.picks?.p2?.[k] == null) return live;
      live.status = "confirmed";
      live.confirmPauseEndsAt = serverNow() + 3600;
      return live;
    });
  } catch (err) {
    console.error("Falha ao iniciar confirmação:", err);
  } finally {
    advancingRound = false;
  }
}



/* Cada Short usa uma das 10 cores dos botões de posição (as mesmas do ADM),
   então o jogo e o resultado falam a mesma "língua" de cores. */
function colorForShort(index) {
  return positionColor(Number(index) + 1);
}

function positionOfShort(room, slot, shortId) {
  const ranking = room.rankings?.[slot] || {};
  return Object.entries(ranking).find(([, id]) => id === shortId)?.[0] || "—";
}

function animateFinalRows(room) {
  const shorts = room.shorts || [];

  clearTimeout(state.finalRevealTimer);
  document.querySelectorAll(".final-row").forEach(row => {
    row.classList.add("reveal-hidden");
    row.classList.remove("reveal-in", "reveal-focus");
  });

  let index = 0;

  state.finalHoverReady = false;
  const showNext = () => {
    if (index >= shorts.length) {
      state.finalRevealTimer = setTimeout(() => {
        // O destaque cruzado só libera depois do confete (dá tempo da chuva começar).
        setTimeout(() => { state.finalHoverReady = true; }, 3000);
        document.querySelectorAll(".final-row").forEach(row => {
          row.classList.remove("reveal-focus");
        });
        burstConfetti();
      }, 520);
      return;
    }

    document.querySelectorAll(".final-row.reveal-focus").forEach(row => {
      row.classList.remove("reveal-focus");
    });

    const item = shorts[index];
    const rows = document.querySelectorAll(
      `.final-row[data-short-id="${CSS.escape(item.id)}"]`
    );

    rows.forEach(row => {
      row.classList.remove("reveal-hidden");
      row.classList.add("reveal-in", "reveal-focus");
    });

    index += 1;
    state.finalRevealTimer = setTimeout(showNext, 610);
  };

  state.finalRevealTimer = setTimeout(showNext, 300);
}

function renderFinal(room) {
  // Evita reiniciar a revelação a cada atualização do Firebase na tela final.
  const renderKey = `${room.finishedAt || ""}|${JSON.stringify(room.rankings || {})}|${room.players?.p1?.name}|${room.players?.p2?.name}`;
  if (state.finalRenderKey === renderKey && $("#finalBoard").children.length) return;
  state.finalRenderKey = renderKey;

  const shorts = room.shorts || [];
  const p1Name = room.players?.p1?.name || "Player 1";
  const p2Name = room.players?.p2?.name || "Player 2";

  $("#finalBoard").innerHTML = ["p1","p2"].map(slot => {
    const p = room.players?.[slot] || { name: slot.toUpperCase(), photo: "" };
    const ranking = room.rankings?.[slot] || {};
    const otherSlot = slot === "p1" ? "p2" : "p1";
    const otherName = otherSlot === "p1" ? p1Name : p2Name;
    const otherRanking = room.rankings?.[otherSlot] || {};

    const rows = Array.from({ length: 10 }, (_, i) => {
      const pos = String(i + 1);
      const item = findShortById(shorts, ranking[pos]);
      const thumb = item ? thumbFor(item) : "";
      const shortIndex = item ? shorts.findIndex(s => s?.id === item.id) : -1;
      const color = shortIndex >= 0 ? colorForShort(shortIndex) : "hsl(260 35% 45%)";
      const shortId = item?.id || `empty-${slot}-${pos}`;

      const otherPosition = item
        ? Object.entries(otherRanking).find(([, id]) => id === item.id)?.[0]
        : null;

      return `
        <div
          class="final-row reveal-hidden"
          data-anchor="final-${slot}-row-${pos}"
          data-short-id="${esc(shortId)}"
          style="--video-color:${color};--pos-color:${positionColor(pos)}"
        >
          <div class="rank-num">${i + 1}</div>
          ${thumb
            ? `<img class="final-thumb" src="${thumb}" alt="">`
            : `<div class="final-thumb"></div>`
          }
          <strong>
            <span class="video-color-dot"></span>
            <span class="final-title-text">${item ? esc(item.title || `Short #${shortIndex + 1}`) : "—"}</span>
            ${
              item && otherPosition
                ? `<span class="final-other-pos"><span>${esc(otherName)}</span><b>#${esc(otherPosition)}</b></span>`
                : ""
            }
          </strong>
        </div>`;
    }).join("");

    return `
      <article class="final-player glass final-player-${slot}" data-anchor="final-${slot}" style="--player-color:${normalizePlayerColor(p.color, slot)}">
        <div class="final-player-head">
          ${avatarMarkup(p, "player-avatar")}
          <div>
            <small>${slot === "p1" ? "PLAYER 1" : "PLAYER 2"}</small>
            <h3>${esc(p.name)}</h3>
          </div>
        </div>
        <div class="final-list">${rows}</div>
      </article>`;
  }).join("");

  animateFinalRows(room);
  requestAnimationFrame(() => {
    document.querySelectorAll("#finalBoard .final-title-text").forEach(t => {
      t.classList.toggle("is-overflowing", t.scrollWidth > t.clientWidth + 2);
      t.dataset.fullTitle = t.textContent;
    });
  });
}

/* ---------------------------------------------------------------------
   Tooltip flutuante dos títulos longos
   Fica numa camada própria, ACIMA do texto (o nome do cursor fica
   embaixo/à direita da seta, então nunca cobre o tooltip). O marquee
   continua preso dentro da própria caixa, sem vazar sobre a thumbnail.
   --------------------------------------------------------------------- */
const TIP_SELECTOR = ".rank-title.is-overflowing, .final-title-text.is-overflowing, .title-strip.is-overflowing";
let floatTipTarget = null;
function floatTipEl() {
  let tip = document.getElementById("floatTip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "floatTip";
    tip.className = "float-tip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
  }
  return tip;
}
function showFloatTip(target) {
  const tip = floatTipEl();
  const text = target.dataset.fullTitle || target.querySelector?.("#shortTitleText")?.textContent || target.textContent;
  tip.textContent = (text || "").trim();
  tip.classList.add("show");
  const r = target.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
  let y = r.top - th - 8;
  let below = false;
  if (y < 6) { y = r.bottom + 8; below = true; }
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.classList.toggle("below", below);
  floatTipTarget = target;
}
function hideFloatTip() {
  floatTipTarget = null;
  document.getElementById("floatTip")?.classList.remove("show");
}
document.addEventListener("pointerover", (e) => {
  const t = e.target.closest?.(TIP_SELECTOR);
  if (t && t !== floatTipTarget) showFloatTip(t);
  else if (!t && floatTipTarget && !floatTipTarget.classList?.contains("pos-btn")) hideFloatTip();
}, { passive: true });
document.addEventListener("pointerleave", hideFloatTip);
window.addEventListener("scroll", hideFloatTip, { passive: true, capture: true });

/* ---------------------------------------------------------------------
   Resultado: passar o cursor num Short destaca o MESMO Short na lista
   do outro jogador. Também funciona com o cursor do outro jogador
   (os dois veem o destaque).
   --------------------------------------------------------------------- */
/* Botões desabilitados não disparam eventos de mouse em alguns navegadores,
   então o balão com o nome de quem escolheu a posição é checado por quadro. */
let posTipTarget = null;
function updatePosOwnerTip() {
  if (!localPointer.inside || localPointer.x == null || !document.getElementById("screen-game")?.classList.contains("active")) {
    if (posTipTarget) { posTipTarget = null; hideFloatTip(); }
    return;
  }
  const el = document.elementFromPoint(localPointer.x, localPointer.y);
  const btn = el?.closest?.(".pos-btn[data-owner-names]") || null;
  if (btn === posTipTarget) return;
  posTipTarget = btn;
  if (btn) showFloatTip(btn);
  else if (floatTipTarget?.classList?.contains("pos-btn")) hideFloatTip();
}

let finalHotKey = "";
function updateFinalHover() {
  const board = document.getElementById("finalBoard");
  if (!board || !state.finalHoverReady || !document.getElementById("screen-final")?.classList.contains("active")) {
    if (finalHotKey) { finalHotKey = ""; board?.classList.remove("has-hot"); }
    return;
  }
  const rowAt = (x, y) => {
    if (x == null) return null;
    const el = document.elementFromPoint(x, y);
    return el?.closest?.(".final-row:not(.reveal-hidden)") || null;
  };
  let row = localPointer.inside ? rowAt(localPointer.x, localPointer.y) : null;
  if (!row) {
    for (const slot of ["p1", "p2"]) {
      const rt = cursorRuntime[slot];
      if (slot !== state.slot && rt.shown) { row = rowAt(rt.x, rt.y); if (row) break; }
    }
  }
  const id = row?.dataset.shortId || "";
  const key = id ? `${id}|${row.dataset.anchor}` : "";
  if (key === finalHotKey) return;
  finalHotKey = key;
  board.querySelectorAll(".final-row.is-hot, .final-row.is-match").forEach(r => r.classList.remove("is-hot", "is-match"));
  board.classList.toggle("has-hot", !!id && !id.startsWith("empty-"));
  if (!id || id.startsWith("empty-")) return;
  board.querySelectorAll(`.final-row[data-short-id="${CSS.escape(id)}"]`).forEach(r => {
    r.classList.add(r === row ? "is-hot" : "is-match");
  });
}


function burstConfetti() {
  if (document.querySelector(".confetti-bit")) return;
  for (let i = 0; i < 44; i++) {
    const bit = document.createElement("i");
    bit.className = "confetti-bit";
    bit.style.cssText = `
      position:fixed;z-index:99;left:${Math.random()*100}vw;top:-20px;
      width:${6+Math.random()*8}px;height:${8+Math.random()*13}px;
      background:hsl(${Math.random()*360} 90% 65%);border-radius:3px;
      transform:rotate(${Math.random()*360}deg);
      animation:confettiFall ${2.6+Math.random()*2.3}s linear forwards;
      pointer-events:none;`;
    document.body.appendChild(bit);
    setTimeout(() => bit.remove(), 5200);
  }
  if (!document.querySelector("#confettiStyle")) {
    const st = document.createElement("style");
    st.id = "confettiStyle";
    st.textContent = `@keyframes confettiFall{to{transform:translate(${(Math.random()-.5)*120}px,110vh) rotate(760deg);opacity:.15}}`;
    document.head.appendChild(st);
  }
}

function friendlyError(err) {
  const msg = err?.message || "Algo deu errado.";
  if (msg.includes("auth/configuration-not-found")) return "Ative o login Anônimo no Firebase Authentication.";
  if (msg.includes("PERMISSION_DENIED") || msg.includes("permission_denied")) return "O Realtime Database bloqueou a operação. Confira as Regras.";
  if (msg.includes("api-key-not-valid")) return "A configuração do Firebase está incorreta.";
  return msg;
}


function destroyCurrentMedia() {
  unmountMedia();
  state.mediaPausedByUser = false;

  $("#approvalReveal")?.classList.add("hidden");
  $("#shortTransitionOverlay")?.classList.add("hidden");
  setStageCover(false);
  setBothLocked(false);
  clearApprovalReactions();
}

function resetLocalPlayerState({ keepIdentity = true } = {}) {
  destroyCurrentMedia();
  state.slot = null;
  updateNativeCursorVisibility();
  state.room = null;
  state.pendingPosition = null;
  state.revealRound = null;
  state.lastObservedRound = null;
  state.mountedMediaRound = null;
  state.animatedSlots.clear();
  state.burstedSlots.clear();
  state.finalRenderKey = null;
  state.buttonsIntroRound = null;
  state.roundTransitionRound = null;
  state.finishSuspenseRunning = false;
  state.finishShown = false;

  if (state.roundTransitionTimer) {
    clearTimeout(state.roundTransitionTimer);
    state.roundTransitionTimer = null;
  }

  if (state.revealTimer) {
    clearTimeout(state.revealTimer);
    state.revealTimer = null;
  }
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  if (state.finalRevealTimer) {
    clearTimeout(state.finalRevealTimer);
    state.finalRevealTimer = null;
  }
  if (state.confirmPauseTimer) {
    clearTimeout(state.confirmPauseTimer);
    state.confirmPauseTimer = null;
  }

  sessionStorage.removeItem("shortRankSlot");

  if (!keepIdentity) {
    state.clientId = uuid();
    sessionStorage.setItem("shortRankClientId", state.clientId);
  }

  hideCountdownOverlay(true);
  $("#confirmModal")?.classList.add("hidden");
  $("#editProfileModal")?.classList.add("hidden");
  $("#joinBtn").disabled = false;
  $("#readyBtn").disabled = true;
  $("#editProfileBtn").disabled = true;
  message($("#entryMessage"), "");
}

function goToEntryScreen(reason = "") {
  resetLocalPlayerState({ keepIdentity: false });
  showScreen("screen-lobby");
  renderLobby(state.room || {});
  if (reason) toast(reason);
}

function currentSlotStillBelongsToThisTab(room) {
  if (!state.slot) return false;
  const player = room?.players?.[state.slot];
  return !!player && player.clientId === state.clientId;
}

/* ---------------------------------------------------------------------
   Conexão
   O bug do "carregando infinito até dar F5": as regras do banco exigem
   login (auth != null), mas os listeners eram ligados ANTES do login
   anônimo terminar. Na primeira visita o Firebase negava a leitura e
   cancelava o listener para sempre. No F5 o login já estava salvo, por
   isso funcionava. Agora: primeiro login, depois listeners — e se algum
   listener cair, ele é religado sozinho.
   --------------------------------------------------------------------- */
async function ensureSignedIn() {
  if (auth.currentUser) return auth.currentUser;
  let attempt = 0;
  while (true) {
    try {
      const cred = await signInAnonymously(auth);
      return cred.user;
    } catch (err) {
      attempt += 1;
      console.error("Falha no login anônimo:", err);
      $("#lobbyPulse") && ($("#lobbyPulse").textContent = attempt > 2 ? "sem conexão — tentando de novo..." : "conectando...");
      if (String(err?.message || "").includes("configuration-not-found")) {
        toast("Ative o login Anônimo no Firebase Authentication.");
      }
      await new Promise(r => setTimeout(r, Math.min(8000, 800 * attempt)));
    }
  }
}

function listenWithRetry(path, onData, label) {
  let retryTimer = null;
  const attach = () => {
    onValue(ref(db, path), onData, async (err) => {
      console.error(`Listener ${label} caiu:`, err);
      clearTimeout(retryTimer);
      try { await ensureSignedIn(); } catch {}
      retryTimer = setTimeout(attach, 1200);
    });
  };
  attach();
}

function installPrefsPanel() {
  const btn = document.getElementById("prefsToggle");
  const panel = document.getElementById("prefsPanel");
  if (!btn || !panel) return;
  const setOpen = (open) => {
    panel.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(!panel.classList.contains("open"));
  });
  panel.addEventListener("click", (e) => {
    e.stopPropagation();
    const opt = e.target.closest("[data-pref]");
    if (!opt) return;
    localPrefs[opt.dataset.pref] = opt.dataset.value;
    saveLocalPrefs();
    applyLocalPrefs();
  });
  document.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
  applyLocalPrefs();
}

async function boot() {
  $("#lobbyPulse") && ($("#lobbyPulse").textContent = "conectando...");
  await resolveTabIdentity();
  updateNativeCursorVisibility();
  onAuthStateChanged(auth, user => { state.user = user; });
  installShortUi();
  installPrefsPanel();
  await ensureSignedIn();
  installCursorSync();
  installMirrorSync();

  listenWithRetry(ROOM_PATH, (snap) => {
    // Se a sala foi apagada/resetada, sair imediatamente da partida.
    if (!snap.exists()) {
      resetLocalPlayerState({ keepIdentity: true });
      state.room = { status: "lobby", players: {}, ready: { p1: false, p2: false } };
      showScreen("screen-lobby");
      renderLobby(state.room);
      return;
    }

    const room = snap.val();
    state.room = room;

    // Recuperar slot apenas se esta aba realmente for dona dele.
    if (!state.slot) {
      const owned = ["p1", "p2"].find(
        s => room.players?.[s]?.clientId === state.clientId
      );

      if (owned) {
        state.slot = owned;
        updateNativeCursorVisibility();
        sessionStorage.setItem("shortRankSlot", owned);
      }
    }

    // Se esta aba tinha um jogador, mas ele foi removido/trocado remotamente,
    // ela sai imediatamente da partida e volta à entrada.
    if (state.slot && !currentSlotStillBelongsToThisTab(room)) {
      goToEntryScreen("Você saiu desta partida.");
      return;
    }

    if (room.status === "lobby") {
      destroyCurrentMedia();
      // Volta ao lobby: desliga o espelhamento do Short (cada um liga de novo se quiser).
      if (state.slot && mirror.optin[state.slot]) setMirrorOptin(false);

      if (state.countdownTimer) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
      }
      if (state.revealTimer) {
        clearTimeout(state.revealTimer);
        state.revealTimer = null;
      }

      state.revealRound = null;
      state.lastObservedRound = null;
      state.mountedMediaRound = null;
      state.animatedSlots.clear();
      state.burstedSlots.clear();
      state.finalRenderKey = null;
      state.buttonsIntroRound = null;
      state.lobbyTransitionKey = null;
      hideCountdownOverlay(true);
      state.room = room;
      showScreen("screen-lobby");
      renderLobby(room);
      maybeStartGame(room);

    } else if (room.status === "countdown") {
      if (currentSlotStillBelongsToThisTab(room)) {
        startCountdown(room);
      } else {
        destroyCurrentMedia();
        showScreen("screen-lobby");
        renderLobby(state.room || {});
      }

    } else if (room.status === "playing") {
      if (currentSlotStillBelongsToThisTab(room)) {
        hideCountdownOverlay();
        const currentRound = Number(room.currentRound || 0);
        if (state.lastObservedRound !== null && state.lastObservedRound !== currentRound) {
          state.mountedMediaRound = null;
          if (state.revealRound !== currentRound) state.revealRound = null;
          if (state.revealTimer && state.revealingRound !== currentRound) {
            clearTimeout(state.revealTimer);
            state.revealTimer = null;
            state.revealingRound = null;
          }
        }
        state.lastObservedRound = currentRound;
        showScreen("screen-game");
        renderGame(room);
        maybeAdvanceRound(room);
      } else { destroyCurrentMedia(); showScreen("screen-lobby"); renderLobby(state.room || {}); }

    } else if (room.status === "confirmed") {
      if (currentSlotStillBelongsToThisTab(room)) {
        hideCountdownOverlay();
        renderConfirmedPause(room);
      } else { destroyCurrentMedia(); showScreen("screen-lobby"); renderLobby(state.room || {}); }

    } else if (room.status === "transition") {
      if (currentSlotStillBelongsToThisTab(room)) {
        hideCountdownOverlay();
        stopCurrentMedia();
        showScreen("screen-game");
        renderSyncedStageTransition(room, false);
      } else { destroyCurrentMedia(); showScreen("screen-lobby"); renderLobby(state.room || {}); }

    } else if (room.status === "finishing") {
      if (currentSlotStillBelongsToThisTab(room)) {
        hideCountdownOverlay();
        stopCurrentMedia();
        showScreen("screen-game");
        renderSyncedStageTransition(room, true);
      } else { destroyCurrentMedia(); showScreen("screen-lobby"); renderLobby(state.room || {}); }

    } else if (room.status === "finished") {
      if (currentSlotStillBelongsToThisTab(room)) {
        hideCountdownOverlay();
        stopCurrentMedia();
        showScreen("screen-final");
        renderFinal(room);
      } else {
        destroyCurrentMedia();
        showScreen("screen-lobby");
        renderLobby(state.room || {});
      }
    }
  }, "sala");

  listenWithRetry(`${CONFIG_PATH}/settings`, snap => {
    applyGameSettings(snap.exists() ? snap.val() : {});
  }, "config");
}

boot();
