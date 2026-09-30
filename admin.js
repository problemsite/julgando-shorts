import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  update,
  remove,
  onValue,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { initTheme } from "./theme.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

initTheme();

/* ---------------------------------------------------------------------
   Utilidades
   --------------------------------------------------------------------- */
const DEFAULT_POSITION_COLORS = [
  "#55D98A", "#71D477", "#8FCE64", "#AEC852", "#C9BF49",
  "#D8A94A", "#E18E4D", "#E27251", "#DE5B58", "#D84C60"
];

function esc(text = "") {
  return String(text)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function initials(name = "?") {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}

function makeId(i) {
  return `short-${i + 1}`;
}

function randomVotes() {
  return Math.floor(42000 + Math.random() * 860000);
}

function formatCount(n) {
  return new Intl.NumberFormat("pt-BR").format(Number(n || 0));
}

function normalizePositionColors(colors) {
  return Array.from({ length: 10 }, (_, i) => {
    const value = Array.isArray(colors) ? colors[i] : null;
    return /^#[0-9A-F]{6}$/i.test(String(value || "")) ? value : DEFAULT_POSITION_COLORS[i];
  });
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

function thumbFor(url) {
  const id = getYoutubeId(url);
  return id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` : "";
}

function validVideoUrl(value) {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
}

async function fetchYoutubeTitle(url) {
  const id = getYoutubeId(url);
  if (!id) throw new Error("Use um link válido do YouTube/Shorts.");
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error("Não consegui buscar o título desse vídeo.");
  const data = await res.json();
  if (!data?.title) throw new Error("O YouTube não devolveu um título.");
  return data.title;
}

let toastTimer = null;
function toast(text, type = "") {
  const el = $("#admToast");
  el.textContent = text;
  el.className = `adm-toast show ${type}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

/* ---------------------------------------------------------------------
   Abas
   --------------------------------------------------------------------- */
$$(".adm-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    $$(".adm-tab").forEach(t => {
      const on = t === tab;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    $$(".adm-tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tab.dataset.tab}`));
    try { sessionStorage.setItem("admTab", tab.dataset.tab); } catch {}
  });
});
try {
  const saved = sessionStorage.getItem("admTab");
  if (saved) $(`.adm-tab[data-tab="${saved}"]`)?.click();
} catch {}

/* ---------------------------------------------------------------------
   Alterações não salvas
   --------------------------------------------------------------------- */
let adminDirty = false;
let suppressDirtyTracking = true;
let savedConfigFingerprint = "";
let savedConfig = { shorts: [], settings: {} };

function currentConfigFingerprint() {
  try {
    return JSON.stringify({ shorts: readEditor(), settings: readVisualSettings() });
  } catch {
    return "";
  }
}

function setAdminDirty(value = true) {
  if (suppressDirtyTracking) return;
  adminDirty = !!value;
  $("#unsavedBar").classList.toggle("hidden", !adminDirty);
  if (adminDirty) $("#saveState").textContent = "alterações não salvas";
}

function refreshDirtyState() {
  if (suppressDirtyTracking) return;
  setAdminDirty(currentConfigFingerprint() !== savedConfigFingerprint);
}

/* ---------------------------------------------------------------------
   Editor dos 10 Shorts
   --------------------------------------------------------------------- */
function shortRow(i, item = {}) {
  const url = item.url || "";
  const thumb = thumbFor(url);
  const valid = validVideoUrl(url);
  return `
    <li class="short-row ${valid ? "is-valid" : url ? "is-invalid" : "is-empty"}" draggable="false">
      <button class="drag-handle" type="button" title="Arrastar para reordenar" aria-label="Arrastar">⠿</button>
      <span class="short-index">${i + 1}</span>
      <div class="short-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : `<span>${url ? "🎞️" : "+"}</span>`}</div>
      <div class="short-fields">
        <div class="field-row">
          <input class="url" value="${esc(url)}" placeholder="Cole o link do Short (youtube.com/shorts/...)" spellcheck="false">
          <span class="url-state" aria-hidden="true"></span>
        </div>
        <div class="field-row">
          <input class="title" value="${esc(item.title || "")}" placeholder="Título (deixe vazio para buscar automático)">
          <button type="button" class="icon-btn fetch-title-btn" title="Buscar título no YouTube">↻</button>
        </div>
      </div>
      <label class="votes-field" title="Pessoas que acharam muito bom">
        <span>👍</span>
        <input class="votes" type="number" min="0" step="1" value="${Number(item.fakeVotes ?? randomVotes())}">
        <small class="votes-preview">${formatCount(item.fakeVotes ?? 0)}</small>
      </label>
      <div class="row-move">
        <button type="button" class="icon-btn move-up" title="Subir">▲</button>
        <button type="button" class="icon-btn move-down" title="Descer">▼</button>
      </div>
    </li>`;
}

function renumber() {
  $$("#shortsEditor .short-row").forEach((row, i) => {
    $(".short-index", row).textContent = i + 1;
  });
  updateShortsCount();
}

function updateRowState(row) {
  const url = $(".url", row).value.trim();
  const valid = validVideoUrl(url);
  row.classList.toggle("is-valid", valid);
  row.classList.toggle("is-invalid", !!url && !valid);
  row.classList.toggle("is-empty", !url);
  const thumb = thumbFor(url);
  const box = $(".short-thumb", row);
  const current = $("img", box)?.getAttribute("src") || "";
  if (thumb !== current) box.innerHTML = thumb ? `<img src="${thumb}" alt="" loading="lazy">` : `<span>${url ? "🎞️" : "+"}</span>`;
  $(".votes-preview", row).textContent = formatCount($(".votes", row).value);
}

function updateShortsCount() {
  const ok = $$("#shortsEditor .short-row").filter(r => r.classList.contains("is-valid")).length;
  const el = $("#shortsCount");
  el.textContent = `${ok}/10`;
  el.classList.toggle("ok", ok === 10);
}

async function fillTitle(row, { force = false, quiet = false } = {}) {
  const urlInput = $(".url", row);
  const titleInput = $(".title", row);
  const btn = $(".fetch-title-btn", row);
  if (!force && titleInput.value.trim()) return;
  if (!getYoutubeId(urlInput.value.trim())) {
    if (!quiet) toast("Esse link não é do YouTube.", "error");
    return;
  }
  btn.classList.add("spinning");
  try {
    titleInput.value = await fetchYoutubeTitle(urlInput.value.trim());
    refreshDirtyState();
    if (!quiet) toast("Título preenchido!", "ok");
  } catch (err) {
    if (!quiet) toast(err?.message || "Não consegui buscar o título.", "error");
  } finally {
    btn.classList.remove("spinning");
  }
}

function bindRow(row) {
  $(".url", row).addEventListener("input", () => { updateRowState(row); updateShortsCount(); refreshDirtyState(); });
  $(".url", row).addEventListener("change", () => fillTitle(row, { quiet: true }));
  $(".url", row).addEventListener("paste", () => setTimeout(() => { updateRowState(row); updateShortsCount(); fillTitle(row, { quiet: true }); }, 30));
  $(".title", row).addEventListener("input", refreshDirtyState);
  $(".votes", row).addEventListener("input", () => { updateRowState(row); refreshDirtyState(); });
  $(".fetch-title-btn", row).addEventListener("click", () => fillTitle(row, { force: true }));
  $(".move-up", row).addEventListener("click", () => moveRow(row, -1));
  $(".move-down", row).addEventListener("click", () => moveRow(row, 1));

  // Arrastar pela alça
  const handle = $(".drag-handle", row);
  handle.addEventListener("pointerdown", () => { row.draggable = true; });
  row.addEventListener("dragstart", (e) => {
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", "row"); } catch {}
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    row.draggable = false;
    $$("#shortsEditor .short-row").forEach(r => r.classList.remove("drop-before", "drop-after"));
    renumber();
    refreshDirtyState();
  });
}

function moveRow(row, dir) {
  const list = $("#shortsEditor");
  if (dir < 0 && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
  if (dir > 0 && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
  row.classList.remove("moved");
  void row.offsetWidth;
  row.classList.add("moved");
  renumber();
  refreshDirtyState();
}

$("#shortsEditor").addEventListener("dragover", (e) => {
  const dragging = $("#shortsEditor .short-row.dragging");
  if (!dragging) return;
  e.preventDefault();
  const rows = $$("#shortsEditor .short-row:not(.dragging)");
  const after = rows.find(r => {
    const rect = r.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2;
  });
  if (after) $("#shortsEditor").insertBefore(dragging, after);
  else $("#shortsEditor").appendChild(dragging);
});

function render(items = []) {
  $("#shortsEditor").innerHTML = Array.from({ length: 10 }, (_, i) => shortRow(i, items?.[i] || {})).join("");
  $$("#shortsEditor .short-row").forEach(row => { bindRow(row); updateRowState(row); });
  updateShortsCount();
}

function readEditor() {
  return $$("#shortsEditor .short-row").map((row, i) => {
    const url = $(".url", row).value.trim();
    const title = $(".title", row).value.trim() || `Short #${i + 1}`;
    const fakeVotes = Number($(".votes", row).value || 0);
    return { id: makeId(i), url, title, fakeVotes };
  });
}

$("#fetchAllTitlesBtn").addEventListener("click", async () => {
  const btn = $("#fetchAllTitlesBtn");
  btn.disabled = true;
  const rows = $$("#shortsEditor .short-row").filter(r => getYoutubeId($(".url", r).value.trim()));
  await Promise.all(rows.map(r => fillTitle(r, { force: true, quiet: true })));
  btn.disabled = false;
  toast(rows.length ? `Títulos atualizados (${rows.length}).` : "Nenhum link do YouTube para buscar.", rows.length ? "ok" : "");
});

$("#randomVotesBtn").addEventListener("click", () => {
  $$("#shortsEditor .short-row").forEach(row => {
    $(".votes", row).value = randomVotes();
    updateRowState(row);
  });
  refreshDirtyState();
  toast("Curtidas sorteadas!");
});

/* ---------------------------------------------------------------------
   Visual
   --------------------------------------------------------------------- */
function renderColorGrid(colors) {
  $("#positionColorAdminGrid").innerHTML = colors.map((color, i) => `
    <label class="color-chip" style="--c:${color}">
      <input type="color" class="position-color-input" data-pos="${i + 1}" value="${color}">
      <span>${i + 1}</span>
    </label>`).join("");
  $$(".position-color-input").forEach(input => {
    input.addEventListener("input", () => {
      input.closest(".color-chip").style.setProperty("--c", input.value);
      refreshDirtyState();
    });
  });
}

function updateBgPreview() {
  const on = $("#stageBgEnabled").checked;
  const blur = Number($("#stageBgBlur").value);
  const opacity = Number($("#stageBgOpacity").value);
  $("#stageBgBlurValue").textContent = `${blur}px`;
  $("#stageBgOpacityValue").textContent = `${opacity}%`;
  $("#bgSettings").classList.toggle("is-off", !on);
  const preview = $("#bgPreview");
  preview.style.setProperty("--pv-blur", `${blur * 0.45}px`);
  preview.style.setProperty("--pv-opacity", String(on ? opacity / 100 : 0));
  const firstThumb = $$("#shortsEditor .short-row img")[0]?.getAttribute("src");
  preview.style.setProperty("--pv-image", firstThumb ? `url("${firstThumb}")` : "none");
  preview.classList.toggle("with-outline", on);
}

function renderVisualSettings(settings = {}) {
  $("#customCursorEnabled").checked = settings.customCursorEnabled !== false;
  $("#stageBgEnabled").checked = settings.stageBgEnabled !== false;
  $("#stageBgBlur").value = Number.isFinite(Number(settings.stageBgBlur)) ? settings.stageBgBlur : 18;
  $("#stageBgOpacity").value = Number.isFinite(Number(settings.stageBgOpacity)) ? settings.stageBgOpacity : 45;
  renderColorGrid(normalizePositionColors(settings.positionColors));
  updateBgPreview();
}

["#customCursorEnabled", "#stageBgEnabled", "#stageBgBlur", "#stageBgOpacity"].forEach(sel => {
  $(sel).addEventListener("input", () => { updateBgPreview(); refreshDirtyState(); });
  $(sel).addEventListener("change", () => { updateBgPreview(); refreshDirtyState(); });
});

$("#resetColorsBtn").addEventListener("click", () => {
  renderColorGrid([...DEFAULT_POSITION_COLORS]);
  refreshDirtyState();
});

function readVisualSettings() {
  const colors = $$(".position-color-input")
    .sort((a, b) => Number(a.dataset.pos) - Number(b.dataset.pos))
    .map(input => input.value);
  return {
    customCursorEnabled: $("#customCursorEnabled").checked,
    positionColors: normalizePositionColors(colors),
    stageBgEnabled: $("#stageBgEnabled").checked,
    stageBgBlur: Number($("#stageBgBlur").value),
    stageBgOpacity: Number($("#stageBgOpacity").value)
  };
}

/* ---------------------------------------------------------------------
   Ao vivo
   --------------------------------------------------------------------- */
const STATUS_LABEL = {
  lobby: "no lobby",
  countdown: "3 • 2 • 1",
  playing: "rodada",
  confirmed: "os dois escolheram",
  transition: "próximo Short",
  finishing: "suspense final",
  finished: "resultado"
};

function avatarMarkup(player, fallback) {
  if (player?.photo) return `<img class="live-avatar" src="${player.photo}" alt="">`;
  return `<span class="live-avatar">${esc(player ? initials(player.name) : fallback)}</span>`;
}

function renderLive(room) {
  lastRoom = room;
  const status = room?.status;
  const r = Number(room?.currentRound || 0);
  const inRound = ["playing", "confirmed", "transition"].includes(status);

  const pill = $("#liveStatus");
  pill.textContent = !room ? "sem partida" : status === "playing" ? `rodada ${r + 1}/10` : (STATUS_LABEL[status] || status || "ativo");
  pill.dataset.state = status || "none";
  $("#liveRoundLabel").textContent = inRound || status === "finishing" ? `Short ${r + 1} de 10` : status === "finished" ? "terminou" : "—";

  // Short atual
  const item = room?.shorts?.[r];
  const shortEl = $("#liveShortPreview");
  if (item && (inRound || status === "finishing")) {
    const thumb = thumbFor(item.url);
    shortEl.innerHTML = `
      <div class="live-short-thumb">${thumb ? `<img src="${thumb}" alt="">` : "🎞️"}<b>${r + 1}/10</b></div>
      <div class="live-short-copy">
        <strong title="${esc(item.title)}">${esc(item.title || `Short ${r + 1}`)}</strong>
        <span>👍 ${formatCount(item.fakeVotes)} acharam muito bom</span>
      </div>`;
  } else {
    shortEl.innerHTML = `<div class="live-empty">${status === "finished" ? "Partida finalizada — os jogadores estão vendo o resultado." : "Nenhum Short em exibição agora."}</div>`;
  }

  // Jogadores
  $("#livePlayers").innerHTML = ["p1", "p2"].map((slot, idx) => {
    const p = room?.players?.[slot];
    const pick = room?.picks?.[slot]?.[String(r)];
    const thinking = Number(room?.thinking?.[slot]?.round) === r ? room?.thinking?.[slot]?.position : null;
    let st;
    if (!p) st = `<span class="tag muted">vaga vazia</span>`;
    else if (inRound && pick != null) st = `<span class="tag ok">travou #${pick}</span>`;
    else if (inRound && thinking != null) st = `<span class="tag warn">pensando em #${thinking}</span>`;
    else if (inRound) st = `<span class="tag">escolhendo...</span>`;
    else if (status === "lobby" || !status) st = room?.ready?.[slot] ? `<span class="tag ok">pronto</span>` : `<span class="tag">no lobby</span>`;
    else st = `<span class="tag">jogando</span>`;
    return `
      <div class="live-player" style="--pc:${esc(p?.color || (idx ? "#FF9B42" : "#41E5FF"))}">
        ${avatarMarkup(p, String(idx + 1))}
        <div><strong>${esc(p?.name || `Player ${idx + 1}`)}</strong><small>${slot.toUpperCase()}${p?.debug ? " • teste" : ""}</small></div>
        ${st}
      </div>`;
  }).join("");

  // Rankings
  const colors = normalizePositionColors(readVisualSettingsSafe().positionColors);
  $("#liveRankings").innerHTML = ["p1", "p2"].map((slot, idx) => {
    const p = room?.players?.[slot];
    const ranking = room?.rankings?.[slot] || {};
    const cells = Array.from({ length: 10 }, (_, i) => {
      const pos = String(i + 1);
      const shortItem = (room?.shorts || []).find(s => s?.id === ranking[pos]);
      return `<div class="rank-cell ${shortItem ? "filled" : ""}" style="--c:${colors[i]}" title="${esc(shortItem?.title || "vazio")}">
        <b>${pos}</b><span>${shortItem ? esc(shortItem.title) : "—"}</span>
      </div>`;
    }).join("");
    return `<div class="rank-col" style="--pc:${esc(p?.color || (idx ? "#FF9B42" : "#41E5FF"))}"><h3>${esc(p?.name || `Player ${idx + 1}`)}</h3>${cells}</div>`;
  }).join("");

  updateDebugControls(room);
}

function readVisualSettingsSafe() {
  try { return readVisualSettings(); } catch { return { positionColors: DEFAULT_POSITION_COLORS }; }
}

let lastRoom = null;

/* ---------------------------------------------------------------------
   Jogadores de teste
   --------------------------------------------------------------------- */
function updateDebugControls(room) {
  for (const slot of ["p1", "p2"]) {
    const player = room?.players?.[slot];
    const box = $(`.debug-slot[data-slot="${slot}"]`);
    $(".add-debug-player", box).disabled = !!player;
    $(".remove-debug-player", box).disabled = !player;
    const readyBtn = $(".ready-debug-player", box);
    readyBtn.disabled = !player || room?.status !== "lobby";
    readyBtn.textContent = room?.ready?.[slot] ? "✓ Pronto" : "Pronto";
    const input = $(".debug-name", box);
    input.disabled = !!player;
    if (player && document.activeElement !== input) input.value = player.name || "";
  }
}

async function addDebugPlayer(slot) {
  const roomSnap = await get(ref(db, "room"));
  const room = roomSnap.exists() ? roomSnap.val() : null;
  if (room?.players?.[slot]) throw new Error(`${slot.toUpperCase()} já está ocupado.`);

  const input = $(`.debug-name[data-slot="${slot}"]`);
  const name = input.value.trim() || input.placeholder;
  const player = {
    clientId: `debug-${slot}-${Date.now()}`,
    name,
    photo: "",
    color: slot === "p1" ? "#41E5FF" : "#FF9B42",
    debug: true
  };

  if (!room) {
    await update(ref(db), {
      room: {
        status: "lobby",
        createdAt: serverTimestamp(),
        players: { [slot]: player },
        ready: { p1: false, p2: false },
        rankings: { p1: {}, p2: {} },
        picks: { p1: {}, p2: {} },
        currentRound: 0
      }
    });
  } else {
    const updates = {
      [`players/${slot}`]: player,
      [`ready/${slot}`]: false,
      [`rankings/${slot}`]: {},
      [`picks/${slot}`]: {}
    };
    if (room.status === "finished") {
      updates.status = "lobby";
      updates.currentRound = 0;
    }
    await update(ref(db, "room"), updates);
  }
  toast(`${name} entrou como ${slot.toUpperCase()}.`, "ok");
}

async function removeDebugPlayer(slot) {
  const roomSnap = await get(ref(db, "room"));
  const room = roomSnap.exists() ? roomSnap.val() : null;
  const player = room?.players?.[slot];
  if (!player) return;
  if (!confirm(`Remover ${player.name || slot.toUpperCase()} da partida?`)) return;

  const updates = {
    [`players/${slot}`]: null,
    [`ready/${slot}`]: false,
    [`rankings/${slot}`]: null,
    [`picks/${slot}`]: null,
    [`thinking/${slot}`]: null
  };

  // Remover alguém no meio da partida volta todo mundo ao lobby.
  if (room.status && room.status !== "lobby") {
    Object.assign(updates, {
      status: "lobby",
      currentRound: 0,
      shorts: null,
      countdownEndsAt: null,
      transitionEndsAt: null,
      confirmPauseEndsAt: null,
      finishTransitionEndsAt: null,
      thinking: null,
      rankings: { p1: {}, p2: {} },
      picks: { p1: {}, p2: {} },
      ready: { p1: false, p2: false }
    });
    delete updates[`ready/${slot}`];
    delete updates[`rankings/${slot}`];
    delete updates[`picks/${slot}`];
    delete updates[`thinking/${slot}`];
  }

  await update(ref(db, "room"), updates);
  toast(`${player.name || slot.toUpperCase()} removido.`, "ok");
}

async function toggleDebugReady(slot) {
  const snap = await get(ref(db, "room"));
  const room = snap.val();
  if (!room?.players?.[slot] || room.status !== "lobby") return;
  await update(ref(db, "room/ready"), { [slot]: !room.ready?.[slot] });
}

function wireButton(selector, fn, errMsg) {
  $$(selector).forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await fn(btn.dataset.slot);
      } catch (err) {
        console.error(err);
        toast(err?.message || errMsg, "error");
      } finally {
        updateDebugControls(lastRoom);
      }
    });
  });
}
wireButton(".add-debug-player", addDebugPlayer, "Erro ao adicionar jogador.");
wireButton(".remove-debug-player", removeDebugPlayer, "Erro ao remover jogador.");
wireButton(".ready-debug-player", toggleDebugReady, "Erro ao marcar pronto.");

/* ---------------------------------------------------------------------
   Controle da partida
   --------------------------------------------------------------------- */
$("#backToLobbyBtn").addEventListener("click", async () => {
  const btn = $("#backToLobbyBtn");
  btn.disabled = true;
  try {
    const snap = await get(ref(db, "room"));
    if (!snap.exists()) {
      toast("Não existe partida ativa.", "error");
      return;
    }
    await update(ref(db, "room"), {
      status: "lobby",
      currentRound: 0,
      countdownEndsAt: null,
      transitionEndsAt: null,
      confirmPauseEndsAt: null,
      finishTransitionEndsAt: null,
      shorts: null,
      rankings: { p1: {}, p2: {} },
      picks: { p1: {}, p2: {} },
      ready: { p1: false, p2: false },
      thinking: null
    });
    toast("Todos voltaram ao lobby.", "ok");
  } catch (err) {
    console.error(err);
    toast(err?.message || "Erro ao voltar ao lobby.", "error");
  } finally {
    btn.disabled = false;
  }
});

$("#resetRoomBtn").addEventListener("click", async () => {
  if (!confirm("Resetar completamente o lobby e a partida atual?")) return;
  const btn = $("#resetRoomBtn");
  btn.disabled = true;
  try {
    await remove(ref(db, "room"));
    toast("Partida resetada.", "ok");
  } catch (err) {
    console.error(err);
    toast(err?.message || "Erro ao resetar.", "error");
  } finally {
    btn.disabled = false;
  }
});

/* ---------------------------------------------------------------------
   Salvar / carregar
   --------------------------------------------------------------------- */
async function saveAdminChanges() {
  const btn = $("#unsavedSaveBtn");
  btn.disabled = true;
  try {
    const shorts = readEditor();
    const bad = shorts.findIndex(s => !validVideoUrl(s.url));
    if (bad !== -1) {
      $("#tab-shorts").classList.contains("active") || $('.adm-tab[data-tab="shorts"]').click();
      const row = $$("#shortsEditor .short-row")[bad];
      row?.classList.add("shake");
      setTimeout(() => row?.classList.remove("shake"), 600);
      row?.querySelector(".url")?.focus();
      throw new Error(`O Short ${bad + 1} precisa de uma URL válida.`);
    }

    const settings = readVisualSettings();
    await update(ref(db, "config"), { shorts, settings, updatedAt: serverTimestamp() });

    savedConfig = { shorts, settings };
    savedConfigFingerprint = currentConfigFingerprint();
    adminDirty = false;
    $("#unsavedBar").classList.add("hidden");
    $("#saveState").textContent = "salvo agora ✓";
    toast("Alterações salvas! Valem para a próxima partida.", "ok");
  } catch (err) {
    console.error(err);
    toast(err?.message || "Erro ao salvar.", "error");
  } finally {
    btn.disabled = false;
  }
}

$("#unsavedSaveBtn").addEventListener("click", saveAdminChanges);
$("#discardBtn").addEventListener("click", () => {
  suppressDirtyTracking = true;
  render(savedConfig.shorts);
  renderVisualSettings(savedConfig.settings);
  suppressDirtyTracking = false;
  savedConfigFingerprint = currentConfigFingerprint();
  setAdminDirty(false);
  $("#saveState").textContent = "alterações descartadas";
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (adminDirty) saveAdminChanges();
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!adminDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

async function ensureSignedIn() {
  if (auth.currentUser) return;
  let attempt = 0;
  while (true) {
    try {
      await signInAnonymously(auth);
      return;
    } catch (err) {
      attempt += 1;
      console.error(err);
      $("#liveStatus").textContent = "sem conexão — tentando...";
      await new Promise(r => setTimeout(r, Math.min(8000, 800 * attempt)));
    }
  }
}

async function load() {
  render([]);
  renderVisualSettings({});
  renderLive(null);

  await ensureSignedIn();
  const snap = await get(ref(db, "config"));
  const config = snap.exists() ? snap.val() : {};
  const items = Array.isArray(config.shorts) ? config.shorts : [];
  savedConfig = { shorts: items, settings: config.settings || {} };

  render(items);
  renderVisualSettings(config.settings || {});

  suppressDirtyTracking = false;
  savedConfigFingerprint = currentConfigFingerprint();
  setAdminDirty(false);

  $("#saveState").textContent = items.filter(Boolean).length === 10 ? "10 Shorts salvos" : "nenhuma lista válida salva";

  const listen = () => onValue(ref(db, "room"), s => renderLive(s.exists() ? s.val() : null), err => {
    console.error(err);
    setTimeout(listen, 1500);
  });
  listen();
}

load().catch(err => {
  console.error(err);
  toast("Não consegui conectar ao Firebase. Confira Authentication e as Regras.", "error");
});
