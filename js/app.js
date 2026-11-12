import { initStore, store } from "./store.js";
import { WORD_PAIRS } from "./words.js";
import { ROLES, WIN_SCREENS, SETTINGS_ROLES, DEFAULT_SETTINGS, composition, letterIndexes, maskWord } from "./roles.js";

/* ============================================================
   Constantes
   ============================================================ */
const AVATARS = ["🦊","🐼","🐸","🐙","🦄","🐯","🐵","🐧","🦁","🐻","🐨","🐷","🦖","👽","🤖","👻","🎃","🐲","🦉","🐝","🦩","🐳","🦔","🍄"];
const COLORS = ["#ff4d8d","#ffb020","#2ee6a8","#4dc3ff","#a66bff","#ff6b4d","#c6ff3d","#ff8ad8","#5ef0ff","#ffd23f"];
const EMOTES = ["😂","🤔","😱","🤨","👀","🔥","👍","😈","🤫","❤️"];
const CLUE_TIMES = [30, 45, 60, 90, 0];
const MAX_PLAYERS = 16;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/* ============================================================
   Utilitaires
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const genCode = () => Array.from({ length: 4 }, () => pick(CODE_CHARS)).join("");

function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem("nc_profile"));
    if (p && p.name) return p;
  } catch {}
  return { name: "", avatar: pick(AVATARS), color: pick(COLORS) };
}
const saveProfile = () => localStorage.setItem("nc_profile", JSON.stringify(S.profile));

/* ============================================================
   État global
   ============================================================ */
const S = {
  code: null,
  room: null,
  secret: null,       // { word, role } — role seulement si ROLES[role].reveal
  hostSecrets: null,  // (hôte uniquement) { _roles, _words }
  unsubs: [],
  profile: loadProfile(),
  seenEmotes: new Set(),
  seenClues: new Set(),
  hostDone: new Set(),
  showWord: false,
  revealFlipped: false,
  myVoteDraft: null,
  connected: true,
  muted: localStorage.getItem("nc_muted") === "1",
  lastTurnKey: null,
  lastStatus: null,
  menuOpen: false,
  rulesOpen: false,
};
const app = document.getElementById("app");
const me = () => store.uid;
const roomPath = (p = "") => `rooms/${S.code}${p ? "/" + p : ""}`;

/* ============================================================
   Sons & vibrations
   ============================================================ */
let actx;
function blip(freqs = [660], dur = 0.09, type = "triangle", vol = 0.08) {
  if (S.muted) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    let t = actx.currentTime;
    for (const f of freqs) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
      t += dur * 0.85;
    }
  } catch {}
}
const sfx = {
  tap: () => blip([520], 0.05),
  turn: () => { blip([523, 659, 784], 0.1); navigator.vibrate?.([60, 40, 60]); },
  send: () => blip([784, 988], 0.07),
  vote: () => blip([330, 262], 0.12, "square", 0.05),
  elim: () => { blip([392, 330, 262, 196], 0.16, "sawtooth", 0.05); navigator.vibrate?.(200); },
  win: () => blip([523, 659, 784, 1047, 1319], 0.12),
  emote: () => blip([880], 0.04, "sine", 0.04),
};

/* ============================================================
   Toast
   ============================================================ */
function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 300); }, 2600);
}

/* ============================================================
   Dérivés de l'état de la room
   ============================================================ */
const R = {
  meta: () => S.room?.meta || {},
  status: () => S.room?.meta?.status,
  settings: () => ({ ...DEFAULT_SETTINGS, ...(S.room?.meta?.settings || {}) }),
  isHost: () => S.room?.meta?.host === me(),
  players: () => S.room?.players || {},
  list: () => Object.entries(R.players()).map(([id, p]) => ({ id, ...p })).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0)),
  inGame: () => R.list().filter((p) => !p.spectator),
  alive: () => R.list().filter((p) => p.alive && !p.spectator),
  game: () => S.room?.game || {},
  p: (id) => R.players()[id],
  current: () => { const g = R.game(); return g.order ? g.order[g.turn] : null; },
  votes: () => (S.room?.votes || {})[R.game().round] || {},
};

/* ============================================================
   Entrée / sortie de room
   ============================================================ */
async function createRoom() {
  if (!validateProfile()) return;
  let code;
  for (let i = 0; i < 12; i++) {
    code = genCode();
    if (!(await store.get(`rooms/${code}/meta`))) break;
  }
  const now = store.now();
  await store.set(`rooms/${code}`, {
    meta: { host: me(), status: "lobby", createdAt: now, settings: { ...DEFAULT_SETTINGS } },
    players: { [me()]: { ...profilePayload(), joinedAt: now, online: true, alive: true, score: 0 } },
  });
  await enterRoom(code);
}

function profilePayload() {
  return { name: S.profile.name.trim().slice(0, 16), avatar: S.profile.avatar, color: S.profile.color };
}

function validateProfile() {
  if (!S.profile.name.trim()) { toast("Choisis un pseudo d'abord 😉", "warn"); $("#name")?.focus(); return false; }
  saveProfile();
  return true;
}

async function joinRoom(raw) {
  if (!validateProfile()) return;
  const code = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  if (code.length !== 4) return toast("Le code fait 4 caractères", "warn");
  const meta = await store.get(`rooms/${code}/meta`);
  if (!meta) return toast("Room introuvable 🤷", "warn");
  const players = (await store.get(`rooms/${code}/players`)) || {};
  const existing = players[me()];
  if (!existing && Object.keys(players).length >= MAX_PLAYERS) return toast("Room pleine 😬", "warn");
  const inGame = meta.status !== "lobby";
  const payload = { ...profilePayload(), online: true };
  if (!existing) Object.assign(payload, { joinedAt: store.now(), alive: !inGame, spectator: inGame || null, score: 0 });
  await store.update(`rooms/${code}/players/${me()}`, payload);
  if (inGame && !existing) toast("Partie en cours : tu regardes en spectateur 👀");
  await enterRoom(code);
}

async function enterRoom(code) {
  leaveListeners();
  S.code = code;
  S.room = null; S.secret = null; S.hostSecrets = null;
  S.seenEmotes.clear(); S.hostDone.clear();
  localStorage.setItem("nc_lastRoom", code);
  const url = new URL(location.href);
  url.searchParams.set("r", code);
  history.replaceState(null, "", url);

  store.onDisconnect(roomPath(`players/${me()}`)).update({ online: false, typing: null });
  const joinTime = store.now();

  S.unsubs.push(store.onValue(roomPath(), (val) => {
    if (!val || !val.meta) { toast("La room a été fermée"); return goHome(); }
    if (!val.players?.[me()]) { toast("Tu n'es plus dans cette room"); return goHome(); }
    const prevStatus = S.room?.meta?.status;
    S.room = val;
    onRoomChange(prevStatus);
  }));
  S.unsubs.push(store.onValue(`secrets/${code}/${me()}`, (v) => {
    const prev = S.secret;
    S.secret = v;
    if (v?.masked && prev?.masked && prev.word !== v.word) { toast("🧐 Nouvelle lettre révélée !"); sfx.send(); }
    render();
  }));
  S.unsubs.push(store.onValue(`emotes/${code}`, (v) => onEmotes(v || {}, joinTime), { limitLast: 25 }));
  render();
}

function leaveListeners() {
  S.unsubs.forEach((u) => u && u());
  S.unsubs = [];
  S.hostSecretsUnsub?.(); S.hostSecretsUnsub = null;
}

async function leaveRoom() {
  if (!S.code) return goHome();
  const code = S.code;
  const status = R.status();
  const others = R.list().filter((p) => p.id !== me() && p.online);
  store.onDisconnect(roomPath(`players/${me()}`)).cancel();
  if (status === "lobby" || !status) {
    if (R.isHost()) {
      if (others.length) await store.update(`rooms/${code}`, { "meta/host": others[0].id, [`players/${me()}`]: null });
      else { await store.remove(`rooms/${code}`); await store.remove(`emotes/${code}`); }
    } else {
      await store.remove(`rooms/${code}/players/${me()}`);
    }
  } else {
    await store.update(`rooms/${code}/players/${me()}`, { online: false, typing: null });
  }
  localStorage.removeItem("nc_lastRoom");
  goHome();
}

function goHome() {
  leaveListeners();
  S.code = null; S.room = null; S.secret = null;
  const url = new URL(location.href);
  url.searchParams.delete("r");
  history.replaceState(null, "", url);
  localStorage.removeItem("nc_lastRoom");
  render();
}

function inviteLink() {
  const u = new URL(location.href);
  u.search = ""; u.hash = "";
  u.searchParams.set("r", S.code);
  return u.toString();
}

async function shareRoom() {
  const link = inviteLink();
  const text = `Rejoins ma partie de Not Cover 🕵️ Code : ${S.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: "Not Cover", text, url: link }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  copyLink();
}
async function copyLink() {
  try { await navigator.clipboard.writeText(inviteLink()); toast("Lien copié ✅"); }
  catch { prompt("Copie ce lien :", inviteLink()); }
}

/* ============================================================
   Réaction aux changements
   ============================================================ */
function onRoomChange(prevStatus) {
  const status = R.status();
  if (status !== prevStatus) {
    S.showWord = false;
    S.myVoteDraft = null;
    if (status === "reveal") S.revealFlipped = false;
    if (status === "vote") sfx.vote();
    if (status === "elim" || status === "guess") sfx.elim();
    if (status === "over") { sfx.win(); setTimeout(confetti, 200); }
  }
  const turnKey = status === "clue" ? `${R.game().round}-${R.game().turn}` : null;
  if (turnKey && turnKey !== S.lastTurnKey && R.current() === me()) sfx.turn();
  S.lastTurnKey = turnKey;

  // Lecture des secrets complets (hôte)
  if (R.isHost() && !S.hostSecretsUnsub) {
    S.hostSecretsUnsub = store.onValue(`secrets/${S.code}`, (v) => { S.hostSecrets = v; hostTick(); });
  }
  lobbyHostMigration();
  render();
  hostTick();
}

// Si l'hôte disparaît, le premier joueur en ligne reprend la main
// (immédiat dans le salon, après 8 s de déconnexion en partie).
let hostOfflineSince = null;
function lobbyHostMigration() {
  if (!S.room) return;
  const host = R.p(R.meta().host);
  if (host && host.online) { hostOfflineSince = null; return; }
  hostOfflineSince ??= Date.now();
  const grace = R.status() === "lobby" ? 0 : 8000;
  if (Date.now() - hostOfflineSince < grace) return;
  const first = R.list().find((p) => p.online && !p.spectator) || R.list().find((p) => p.online);
  if (first && first.id === me()) { hostOfflineSince = null; store.update(roomPath("meta"), { host: me() }); }
}
setInterval(lobbyHostMigration, 1000);

/* ============================================================
   Logique de l'hôte (autorité du jeu)
   ============================================================ */
function once(key, fn) {
  if (S.hostDone.has(key)) return;
  S.hostDone.add(key);
  fn();
}

function hostTick() {
  if (!S.room || !R.isHost()) return;
  const st = R.status(), g = R.game();
  if (st === "reveal") {
    const waiting = R.alive().filter((p) => p.online && !p.ready);
    if (R.alive().length && !waiting.length) once(`clues-${g.round}`, startClues);
  }
  if (st === "vote") {
    const votes = R.votes();
    const voters = R.alive().filter((p) => p.online);
    if (voters.length && voters.every((p) => votes[p.id])) once(`resolve-${g.round}`, () => setTimeout(resolveVote, 900));
  }
  if (st === "guess" && g.mwGuess != null && S.hostSecrets) once(`mw-${g.round}`, resolveGuess);
}

// Timer de l'hôte : saute les tours expirés / joueurs déconnectés
setInterval(() => {
  if (!S.room || !R.isHost() || R.status() !== "clue") return;
  const g = R.game(), cur = R.current();
  if (!cur) return;
  const p = R.p(cur);
  const now = store.now();
  const expired = g.turnEndsAt && now > g.turnEndsAt + 800;
  const ghost = (!p || !p.online || !p.alive) && now - (g.turnStartedAt || 0) > 5000;
  if (expired || ghost) once(`skip-${g.round}-${g.turn}`, () => advanceTurn(null, true));
}, 1000);

async function startGame() {
  const players = R.list().filter((p) => p.online);
  const n = players.length;
  if (n < 3) return toast("Il faut au moins 3 joueurs", "warn");
  const { counts } = composition(n, R.settings());

  const pairIndex = Math.floor(Math.random() * WORD_PAIRS.length);
  let [civilWord, underWord] = WORD_PAIRS[pairIndex];
  if (Math.random() < 0.5) [civilWord, underWord] = [underWord, civilWord];
  const words = { civil: civilWord, undercover: underWord };

  // Distribution : rôles spéciaux d'abord, le reste en civils
  const ids = shuffle(players.map((p) => p.id));
  const roles = {};
  let i = 0;
  for (const [role, c] of Object.entries(counts)) {
    if (role === "civil") continue;
    for (let k = 0; k < c; k++) roles[ids[i++]] = role;
  }
  for (; i < ids.length; i++) roles[ids[i]] = "civil";

  const secrets = { _roles: roles, _words: words, _masks: {} };
  for (const id of ids) {
    const r = ROLES[roles[id]];
    const word = r.word ? words[r.word] : null;
    if (word && r.mask) {
      // Ordre de révélation des lettres tiré au sort, gardé côté hôte
      const order = shuffle(letterIndexes(word));
      secrets._masks[id] = order;
      secrets[id] = { word: maskWord(word, order, 1), masked: true, role: r.reveal ? roles[id] : null };
    } else {
      secrets[id] = { word, role: r.reveal ? roles[id] : null };
    }
  }
  await store.set(`secrets/${S.code}`, secrets);

  const up = {
    "meta/status": "reveal",
    game: { round: 1, startedAt: store.now(), composition: counts },
    clues: null, votes: null, reveal: null,
  };
  for (const p of R.list()) {
    if (!p.online) { up[`players/${p.id}`] = null; continue; }
    up[`players/${p.id}/alive`] = true;
    up[`players/${p.id}/ready`] = null;
    up[`players/${p.id}/spectator`] = null;
    up[`players/${p.id}/typing`] = null;
  }
  S.hostDone.clear();
  await store.update(roomPath(), up);
}

async function startClues(newRound) {
  const roles = S.hostSecrets?._roles || {};
  let order = shuffle(R.alive().map((p) => p.id));
  // Certains rôles (Mr. White) ne parlent jamais en premier
  const canStart = (id) => ROLES[roles[id]]?.firstSpeaker !== false;
  if (!canStart(order[0]) && order.length > 1) {
    const j = order.findIndex(canStart);
    if (j > 0) [order[0], order[j]] = [order[j], order[0]];
  }
  // Rôles masqués (Borgne) : une lettre de plus à chaque nouvelle manche
  if (newRound && S.hostSecrets?._masks) {
    const up = {};
    for (const [id, letters] of Object.entries(S.hostSecrets._masks)) {
      const word = S.hostSecrets._words?.[ROLES[roles[id]]?.word];
      if (word) up[`${id}/word`] = maskWord(word, letters, newRound);
    }
    if (Object.keys(up).length) await store.update(`secrets/${S.code}`, up);
  }
  const t = R.settings().clueTime;
  const now = store.now();
  await store.update(roomPath(), {
    "meta/status": "clue",
    ...(newRound ? { "game/round": newRound } : {}),
    "game/order": order,
    "game/turn": 0,
    "game/turnStartedAt": now,
    "game/turnEndsAt": t ? now + t * 1000 : null,
    "game/elim": null,
    "game/mwGuess": null,
    "game/mwFail": null,
  });
}

async function advanceTurn(text, skipped = false) {
  const g = R.game();
  const turn = g.turn ?? 0;
  const who = g.order[turn];
  const next = turn + 1;
  const t = R.settings().clueTime;
  const now = store.now();
  const up = {
    [`clues/${g.round}/${turn}`]: { uid: who, text: skipped ? null : text, skipped: skipped || null, at: now },
    "game/turn": next,
    "game/turnStartedAt": now,
    "game/turnEndsAt": t ? now + t * 1000 : null,
    [`players/${who}/typing`]: null,
  };
  if (next >= g.order.length) up["meta/status"] = "vote";
  await store.update(roomPath(), up);
}

async function resolveVote() {
  if (R.status() !== "vote") return;
  const votes = R.votes();
  const aliveIds = new Set(R.alive().map((p) => p.id));
  const tally = {};
  for (const [voter, target] of Object.entries(votes)) {
    if (aliveIds.has(voter) && aliveIds.has(target)) tally[target] = (tally[target] || 0) + 1;
  }
  const entries = Object.entries(tally);
  if (!entries.length) { S.hostDone.delete(`resolve-${R.game().round}`); return toast("Personne n'a voté", "warn"); }
  const top = Math.max(...entries.map(([, c]) => c));
  const tied = entries.filter(([, c]) => c === top).map(([id]) => id);
  const target = pick(tied);
  await eliminate(target, tied.length > 1, tally);
}

async function eliminate(target, tie, tally) {
  const roles = S.hostSecrets?._roles || {};
  const role = roles[target] || "civil";
  const def = ROLES[role];
  const up = {
    [`players/${target}/alive`]: false,
    [`players/${target}/typing`]: null,
    [`game/dead/${target}`]: role,
    "game/elim": { uid: target, role, tie: tie || null, tally: tally || null },
    "game/mwGuess": null,
    "game/mwFail": null,
  };
  if (def.onElim === "win" && !tie) return finish(role, up);
  if (def.onElim === "guess") {
    up["meta/status"] = "guess";
    return store.update(roomPath(), up);
  }
  const winner = computeWinner(roles, target);
  if (winner) return finish(winner, up);
  up["meta/status"] = "elim";
  await store.update(roomPath(), up);
}

function computeWinner(roles, justDead) {
  const teams = R.alive().filter((p) => p.id !== justDead).map((p) => ROLES[roles[p.id]]?.team);
  const imp = teams.filter((t) => t === "impostor").length;
  const civ = teams.filter((t) => t === "civil").length;
  if (imp === 0) return "civil";
  if (civ <= 1) return "impostors";
  return null;
}

async function resolveGuess() {
  const g = R.game();
  const words = S.hostSecrets?._words || {};
  const ok = norm(g.mwGuess) && norm(g.mwGuess) === norm(words.civil);
  if (ok) return finish(g.elim?.role || "mrwhite", {});
  const roles = S.hostSecrets._roles;
  const winner = computeWinner(roles, g.elim?.uid);
  const up = { "game/mwFail": true };
  if (winner) return finish(winner, up);
  up["meta/status"] = "elim";
  await store.update(roomPath(), up);
}

async function finish(winner, up = {}) {
  const roles = S.hostSecrets?._roles || {};
  const words = S.hostSecrets?._words || {};
  // winner = "civil" | "impostors" (équipes) ou un rôle qui gagne seul ("mrwhite", "clown"…)
  const winners = Object.keys(roles).filter((id) => {
    if (winner === "civil") return ROLES[roles[id]].team === "civil";
    if (winner === "impostors") return ROLES[roles[id]].team === "impostor";
    return roles[id] === winner;
  });
  for (const id of winners) {
    const p = R.p(id);
    if (p) up[`players/${id}/score`] = (p.score || 0) + ROLES[roles[id]].points;
  }
  up.reveal = { winner, winners, roles, words };
  up["meta/status"] = "over";
  await store.update(roomPath(), up);
}

async function nextRound() {
  if (!R.isHost()) return;
  if (R.status() !== "elim") return;
  await startClues((R.game().round || 1) + 1);
}

async function replay() {
  const up = { "meta/status": "lobby", game: null, clues: null, votes: null, reveal: null };
  for (const p of R.list()) {
    if (!p.online) { up[`players/${p.id}`] = null; continue; }
    Object.assign(up, { [`players/${p.id}/alive`]: true, [`players/${p.id}/ready`]: null, [`players/${p.id}/spectator`]: null, [`players/${p.id}/typing`]: null });
  }
  await store.remove(`secrets/${S.code}`);
  S.hostDone.clear();
  await store.update(roomPath(), up);
}

/* ============================================================
   Actions des joueurs
   ============================================================ */
async function submitClue() {
  const input = $("#clue");
  const text = (input?.value || "").trim().replace(/\s+/g, " ").slice(0, 32);
  if (!text) return;
  if (R.current() !== me() || R.status() !== "clue") return;
  if (S.secret?.word && !S.secret.masked && norm(text).includes(norm(S.secret.word))) {
    input.classList.add("shake"); setTimeout(() => input.classList.remove("shake"), 500);
    return toast("Tu ne peux pas donner ton propre mot 🙃", "warn");
  }
  sfx.send();
  input.value = "";
  await advanceTurn(text);
}

let typingTimer = null, typingOn = false;
function onTyping() {
  if (!typingOn) { typingOn = true; store.update(roomPath(`players/${me()}`), { typing: true }); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { typingOn = false; store.update(roomPath(`players/${me()}`), { typing: null }); }, 2500);
}

async function castVote(target) {
  if (R.status() !== "vote") return;
  const mePl = R.p(me());
  if (!mePl?.alive || mePl.spectator) return toast("Les éliminés ne votent pas 👻");
  if (target === me()) return toast("Voter pour soi ? Audacieux… mais non 😅");
  sfx.tap();
  const cur = R.votes()[me()];
  await store.set(roomPath(`votes/${R.game().round}/${me()}`), cur === target ? null : target);
}

async function submitGuess() {
  const v = ($("#guess")?.value || "").trim().slice(0, 40);
  if (!v) return;
  await store.update(roomPath("game"), { mwGuess: v });
}

let lastEmote = 0;
function sendEmote(e) {
  const now = store.now();
  if (now - lastEmote < 350) return;
  lastEmote = now;
  store.push(`emotes/${S.code}`, { uid: me(), e, at: now });
}

function onEmotes(all, joinTime) {
  const now = store.now();
  for (const [k, v] of Object.entries(all)) {
    if (S.seenEmotes.has(k)) continue;
    S.seenEmotes.add(k);
    if (v.at > now - 5000 && v.at >= joinTime - 2000) floatEmote(v.uid, v.e);
    if (v.uid === me() && v.at < now - 12000) store.remove(`emotes/${S.code}/${k}`);
  }
}

function floatEmote(uid, e) {
  sfx.emote();
  const anchor = document.querySelector(`[data-pid="${uid}"] .av`) || document.querySelector(".players");
  const layer = $("#emote-layer");
  if (!layer) return;
  const r = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const el = document.createElement("div");
  el.className = "float-emote";
  el.textContent = e;
  el.style.left = `${r.left + r.width / 2}px`;
  el.style.top = `${r.top + r.height / 2}px`;
  el.style.setProperty("--dx", `${(Math.random() - 0.5) * 60}px`);
  layer.appendChild(el);
  setTimeout(() => el.remove(), 1800);
  anchor?.closest(".pl")?.classList.add("emoting");
  setTimeout(() => anchor?.closest(".pl")?.classList.remove("emoting"), 400);
}

async function kick(id) {
  if (!R.isHost() || id === me()) return;
  const p = R.p(id);
  if (!confirm(`Exclure ${p?.name} ?`)) return;
  await store.remove(roomPath(`players/${id}`));
}

async function updateSettings(patch) {
  if (!R.isHost()) return;
  sfx.tap();
  await store.update(roomPath("meta/settings"), patch);
}

/* ============================================================
   Rendu
   ============================================================ */
function avatarHTML(p, size = "") {
  if (!p) return `<div class="av ${size}" style="--c:#555">❔</div>`;
  return `<div class="av ${size}" style="--c:${p.color || "#888"}">${esc(p.avatar || "🙂")}</div>`;
}

function render() {
  if (!S.code) return renderHome();
  if (!S.room) { app.dataset.screen = "loading"; return (app.innerHTML = `<div class="screen center"><div class="loader"></div></div>`); }
  if (R.status() === "lobby") return renderLobby();
  renderGame();
}

/* ---------- Accueil ---------- */
function renderHome() {
  const invited = new URL(location.href).searchParams.get("r");
  app.dataset.screen = "home";
  app.innerHTML = `
  <div class="screen home">
    <div class="logo-wrap">
      <div class="logo-badge">🕵️</div>
      <h1 class="logo"><span>NOT</span><span>COVER</span></h1>
      <p class="tagline">Démasque l'imposteur… ou deviens-le.</p>
    </div>

    <div class="card profile">
      <button class="av big pick" id="avpick" style="--c:${S.profile.color}" aria-label="Changer d'avatar">${S.profile.avatar}</button>
      <div class="grow">
        <label class="lbl" for="name">Ton pseudo</label>
        <input id="name" class="field" maxlength="16" placeholder="Agent 007" value="${esc(S.profile.name)}" autocomplete="nickname" />
      </div>
    </div>
    <div class="avatar-grid hidden" id="avgrid">
      ${AVATARS.map((a) => `<button class="av-opt ${a === S.profile.avatar ? "on" : ""}" data-av="${a}">${a}</button>`).join("")}
      <div class="colors">${COLORS.map((c) => `<button class="col-opt ${c === S.profile.color ? "on" : ""}" data-col="${c}" style="--c:${c}"></button>`).join("")}</div>
    </div>

    ${invited ? `
      <div class="card invite">
        <div class="lbl">Tu es invité·e dans la room</div>
        <div class="code-tiles sm">${[...invited.toUpperCase()].map((c) => `<span>${esc(c)}</span>`).join("")}</div>
        <button class="btn pink xl" id="joinInvite">Rejoindre la partie</button>
      </div>` : ""}

    <button class="btn yellow xl" id="create">✨ Créer une room</button>

    <div class="sep"><span>ou rejoins tes potes</span></div>

    <div class="join-row">
      <input id="code" class="field code-field" maxlength="4" placeholder="CODE" autocapitalize="characters" autocomplete="off" spellcheck="false" value="${invited ? esc(invited.toUpperCase()) : ""}" />
      <button class="btn mint" id="join">GO</button>
    </div>

    <button class="link-btn" id="rules">📖 Comment jouer ?</button>
    ${store.mode === "local" ? `<div class="mode-badge">Mode local · ouvre plusieurs onglets pour tester</div>` : ""}
  </div>
  ${S.rulesOpen ? rulesModal() : ""}
  `;
  $("#name").oninput = (e) => { S.profile.name = e.target.value; saveProfile(); };
  $("#avpick").onclick = () => { sfx.tap(); $("#avgrid").classList.toggle("hidden"); };
  app.querySelectorAll("[data-av]").forEach((b) => (b.onclick = () => { S.profile.avatar = b.dataset.av; saveProfile(); renderHome(); $("#avgrid").classList.remove("hidden"); }));
  app.querySelectorAll("[data-col]").forEach((b) => (b.onclick = () => { S.profile.color = b.dataset.col; saveProfile(); renderHome(); $("#avgrid").classList.remove("hidden"); }));
  $("#create").onclick = withBusy($("#create"), createRoom);
  $("#join").onclick = withBusy($("#join"), () => joinRoom($("#code").value));
  $("#code").onkeydown = (e) => { if (e.key === "Enter") $("#join").click(); };
  $("#code").oninput = (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
  if (invited) $("#joinInvite").onclick = withBusy($("#joinInvite"), () => joinRoom(invited));
  $("#rules").onclick = () => { S.rulesOpen = true; renderHome(); };
  bindRules(renderHome);
}

function withBusy(btn, fn) {
  return async () => {
    if (btn.disabled) return;
    sfx.tap();
    btn.disabled = true;
    try { await fn(); } catch (e) { console.error(e); toast("Oups : " + (e.message || e), "warn"); }
    finally { if (btn.isConnected) btn.disabled = false; }
  };
}

function rulesModal() {
  return `
  <div class="modal-bg" id="rulesBg">
    <div class="modal rules">
      <h2>Comment jouer</h2>
      <ol>
        <li><b>🙂 Civils</b> : vous avez tous le même mot secret.</li>
        <li><b>🕵️ Undercover</b> : un mot proche mais différent… et il ne sait pas qu'il est l'intrus !</li>
        <li><b>👻 Mr. White</b> : aucun mot. Il bluffe et improvise.</li>
        <li>Chacun son tour, donne <b>un indice</b> sur ton mot, sans le dire.</li>
        <li>Puis tout le monde <b>vote</b> pour éliminer un suspect.</li>
        <li>Mr. White éliminé ? Il peut gagner en devinant le mot des civils.</li>
        <li><b>🧐 Borgne</b> (optionnel) : un civil qui ne voit qu'une lettre du mot, et une de plus à chaque manche.</li>
        <li><b>🤡 Clown</b> (optionnel) : il a le mot des civils mais gagne seul s'il se fait éliminer au vote.</li>
      </ol>
      <div class="win-rules">
        <div><b>Civils</b> gagnent s'ils éliminent tous les imposteurs.</div>
        <div><b>Imposteurs</b> gagnent s'il ne reste qu'un civil.</div>
      </div>
      <div class="pts">Points : ${Object.values(ROLES).map((r) => `${r.label} +${r.points}`).join(" · ")}</div>
      <button class="btn yellow" id="rulesClose">Compris !</button>
    </div>
  </div>`;
}
function bindRules(rerender) {
  const close = () => { S.rulesOpen = false; rerender(); };
  $("#rulesClose") && ($("#rulesClose").onclick = close);
  $("#rulesBg") && ($("#rulesBg").onclick = (e) => e.target.id === "rulesBg" && close());
}

/* ---------- Lobby ---------- */
function renderLobby() {
  const list = R.list();
  const online = list.filter((p) => p.online);
  const host = R.isHost();
  const set = R.settings();
  const n = online.length;
  const { counts, blocked, max } = composition(n, set);
  const und = counts.undercover;
  const imp = Object.entries(counts).filter(([r, c]) => c && ROLES[r].team === "impostor").reduce((a, [, c]) => a + c, 0);

  app.dataset.screen = "lobby";
  app.innerHTML = `
  <div class="screen lobby">
    ${topbar(`<span class="pill">Salon</span>`)}

    <div class="card code-card">
      <div class="lbl">Code de la room</div>
      <button class="code-tiles" id="copyCode" aria-label="Copier le lien">${[...S.code].map((c, i) => `<span style="--i:${i}">${c}</span>`).join("")}</button>
      <div class="row gap">
        <button class="btn blue grow" id="share">📨 Inviter</button>
        <button class="btn ghost" id="qrBtn">▦ QR</button>
      </div>
      <div class="qr hidden" id="qr"><img alt="QR code d'invitation" src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(inviteLink())}" onerror="this.parentElement.innerHTML='<small>QR indisponible hors-ligne</small>'"/></div>
    </div>

    <div class="section-title">Joueurs <span class="count">${n}/${MAX_PLAYERS}</span></div>
    <div class="lobby-players">
      ${list.map((p, i) => `
        <div class="lp ${p.online ? "" : "off"} ${p.id === me() ? "me" : ""}" data-pid="${p.id}" style="--i:${i}">
          ${avatarHTML(p)}
          <div class="lp-name">${esc(p.name)}${p.id === R.meta().host ? ` <span class="crown">👑</span>` : ""}</div>
          ${p.score ? `<div class="lp-score">⭐ ${p.score}</div>` : ""}
          ${host && p.id !== me() ? `<button class="kick" data-kick="${p.id}" aria-label="Exclure">✕</button>` : ""}
        </div>`).join("")}
      ${n < 3 ? `<div class="lp ghost-slot"><div class="av dashed">＋</div><div class="lp-name">Invite ${3 - n} joueur${3 - n > 1 ? "s" : ""}</div></div>` : ""}
    </div>

    <div class="section-title">Réglages ${host ? "" : `<span class="count">par l'hôte</span>`}</div>
    <div class="card settings ${host ? "" : "readonly"}">
      <div class="set-row">
        <div><div class="set-name">🕵️ Undercover</div><div class="set-sub">max ${max} avec ${n} joueurs</div></div>
        <div class="stepper">
          <button data-und="-1" ${und <= 1 ? "disabled" : ""}>−</button>
          <span>${und}</span>
          <button data-und="1" ${imp >= max ? "disabled" : ""}>+</button>
        </div>
      </div>
      ${SETTINGS_ROLES.map(({ key, setting, sub }) => {
        const on = !!set[setting], off = blocked.includes(key);
        return `
      <div class="set-row ${off ? "blocked" : ""}">
        <div><div class="set-name">${ROLES[key].icon} ${ROLES[key].label}</div><div class="set-sub">${off ? "pas assez de joueurs, ignoré" : sub}</div></div>
        <button class="toggle ${on ? "on" : ""}" data-role-toggle="${setting}" aria-pressed="${on}"><span></span></button>
      </div>`;
      }).join("")}
      <div class="set-row col">
        <div class="set-name">⏱️ Temps par indice</div>
        <div class="chips">
          ${CLUE_TIMES.map((t) => `<button class="chip ${set.clueTime === t ? "on" : ""}" data-time="${t}">${t ? t + "s" : "∞"}</button>`).join("")}
        </div>
      </div>
      <div class="compo">${compoTags(counts, true)}</div>
    </div>

    <div class="dock-spacer"></div>
  </div>
  <div class="dock lobby-dock">
    ${host
      ? `<button class="btn pink xl" id="start" ${n < 3 ? "disabled" : ""}>${n < 3 ? `Encore ${3 - n} joueur${3 - n > 1 ? "s" : ""}…` : "🚀 Lancer la partie"}</button>`
      : `<div class="waiting">En attente de l'hôte <span class="dots"><i></i><i></i><i></i></span></div>`}
    ${emoteBar()}
  </div>
  <div id="emote-layer"></div>
  ${menuHTML()}
  ${S.rulesOpen ? rulesModal() : ""}
  `;
  bindTopbar(renderLobby);
  $("#share").onclick = shareRoom;
  $("#copyCode").onclick = copyLink;
  $("#qrBtn").onclick = () => $("#qr").classList.toggle("hidden");
  app.querySelectorAll("[data-kick]").forEach((b) => (b.onclick = () => kick(b.dataset.kick)));
  if (host) {
    app.querySelectorAll("[data-und]").forEach((b) => (b.onclick = () => updateSettings({ undercover: Math.max(1, und + +b.dataset.und) })));
    app.querySelectorAll("[data-role-toggle]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.roleToggle;
      updateSettings({ [k]: !set[k] });
    }));
    app.querySelectorAll("[data-time]").forEach((b) => (b.onclick = () => updateSettings({ clueTime: +b.dataset.time })));
    $("#start").onclick = withBusy($("#start"), startGame);
  }
  bindEmotes();
}

function compoTags(counts, long = false) {
  return Object.entries(ROLES)
    .filter(([key]) => counts[key])
    .map(([key, r]) => `<span class="tag ${r.cls}">${r.icon} ${counts[key]}${long && key === "civil" ? ` civil${counts[key] > 1 ? "s" : ""}` : ""}</span>`)
    .join("");
}

function topbar(center) {
  return `
  <header class="topbar">
    <button class="code-pill" id="tbCode">#${S.code}</button>
    <div class="tb-center">${center}</div>
    <button class="icon-btn" id="menuBtn" aria-label="Menu">☰</button>
  </header>
  ${!S.connected ? `<div class="offline-banner">Connexion perdue… reconnexion</div>` :
    S.room && R.status() !== "lobby" && !R.p(R.meta().host)?.online ? `<div class="offline-banner">L'hôte est déconnecté… un autre joueur va reprendre la main</div>` : ""}`;
}
function bindTopbar(rerender) {
  $("#tbCode").onclick = shareRoom;
  $("#menuBtn").onclick = () => { S.menuOpen = !S.menuOpen; rerender(); };
  if (S.menuOpen) {
    $("#menuBg").onclick = (e) => { if (e.target.id === "menuBg") { S.menuOpen = false; rerender(); } };
    $("#mRules").onclick = () => { S.menuOpen = false; S.rulesOpen = true; rerender(); };
    $("#mShare").onclick = () => { S.menuOpen = false; shareRoom(); rerender(); };
    $("#mMute").onclick = () => { S.muted = !S.muted; localStorage.setItem("nc_muted", S.muted ? "1" : "0"); rerender(); };
    $("#mLeave").onclick = () => { S.menuOpen = false; if (confirm("Quitter la room ?")) leaveRoom(); else rerender(); };
  }
  bindRules(rerender);
}
function menuHTML() {
  if (!S.menuOpen) return "";
  return `
  <div class="modal-bg top" id="menuBg">
    <div class="menu">
      <button id="mShare">📨 Inviter des joueurs</button>
      <button id="mRules">📖 Règles</button>
      <button id="mMute">${S.muted ? "🔇 Son coupé" : "🔊 Son activé"}</button>
      <button id="mLeave" class="danger">🚪 Quitter la room</button>
    </div>
  </div>`;
}

function emoteBar() {
  return `<div class="emote-bar">${EMOTES.map((e) => `<button data-emo="${e}">${e}</button>`).join("")}</div>`;
}
function bindEmotes() {
  app.querySelectorAll("[data-emo]").forEach((b) => {
    b.onclick = () => { sendEmote(b.dataset.emo); b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); };
  });
}

/* ---------- Jeu ---------- */
let dockKey = null, feedScrollLock = false;

function renderGame() {
  const st = R.status();
  const g = R.game();
  const mePl = R.p(me());
  const spectator = !!mePl?.spectator;

  // Structure persistante (évite de perdre le focus de l'input)
  if (app.dataset.screen !== "game") {
    app.dataset.screen = "game";
    dockKey = null;
    app.innerHTML = `
      <div class="screen game">
        <div id="tb"></div>
        <section class="players" id="players"></section>
        <section class="feed" id="feed"></section>
        <div id="dock" class="dock"></div>
        ${emoteBar()}
      </div>
      <div id="overlay"></div>
      <div id="emote-layer"></div>
      <div id="menuSlot"></div>`;
    bindEmotes();
    $("#feed").addEventListener("scroll", (e) => {
      const f = e.target; feedScrollLock = f.scrollHeight - f.scrollTop - f.clientHeight > 60;
    });
  }

  // Barre du haut
  const myRole = S.secret?.role && ROLES[S.secret.role];
  const myWord = !S.secret ? "…" : [myRole?.icon, S.secret.word || myRole?.label].filter(Boolean).join(" ");
  $("#tb").innerHTML = topbar(`
    ${S.showWord ? "" : `<span class="pill round">Manche ${g.round || 1}</span>`}
    ${spectator ? `<span class="pill spec">👀 Spectateur</span>` :
      `<button class="word-chip ${S.showWord ? "on" : ""}" id="wordChip">${S.showWord ? esc(myWord) : "👁 Mot"}</button>`}
  `);
  $("#menuSlot").innerHTML = menuHTML() + (S.rulesOpen ? rulesModal() : "");
  bindTopbar(renderGame);
  const chip = $("#wordChip");
  if (chip) chip.onclick = () => { S.showWord = !S.showWord; renderGame(); if (S.showWord) setTimeout(() => { S.showWord = false; S.code && render(); }, 3500); };

  renderPlayers();
  renderFeed();
  renderDock();
  renderOverlay();
}

function renderPlayers() {
  const st = R.status(), g = R.game();
  const cur = R.current();
  const votes = st === "vote" ? R.votes() : {};
  const counts = {};
  Object.values(votes).forEach((t) => (counts[t] = (counts[t] || 0) + 1));
  const myVote = votes[me()];
  const list = R.inGame();
  const el = $("#players");
  el.className = `players ${st === "vote" ? "voting" : ""} n${Math.min(list.length, 8)}`;
  el.innerHTML = list.map((p) => {
    const dead = !p.alive;
    const role = g.dead?.[p.id];
    const turn = st === "clue" && cur === p.id;
    const voters = Object.entries(votes).filter(([, t]) => t === p.id).map(([v]) => R.p(v));
    return `
    <button class="pl ${dead ? "dead" : ""} ${turn ? "turn" : ""} ${p.online ? "" : "off"} ${p.id === me() ? "me" : ""} ${myVote === p.id ? "voted" : ""} ${st === "reveal" && p.ready ? "ready" : ""}"
      data-pid="${p.id}" ${st === "vote" && !dead ? `data-vote="${p.id}"` : ""}>
      <div class="av-wrap">
        ${avatarHTML(p)}
        ${dead ? `<span class="dead-badge ${ROLES[role]?.cls || ""}">${ROLES[role]?.icon || "💀"}</span>` : ""}
        ${p.typing && turn ? `<span class="typing-badge"><i></i><i></i><i></i></span>` : ""}
        ${counts[p.id] ? `<span class="vote-count">${counts[p.id]}</span>` : ""}
        ${st === "vote" && votes[p.id] ? `<span class="has-voted">✓</span>` : ""}
        ${st === "reveal" && p.ready ? `<span class="has-voted">✓</span>` : ""}
      </div>
      <div class="pl-name">${p.id === me() ? "Toi" : esc(p.name)}</div>
      ${voters.length ? `<div class="voters">${voters.map((v) => `<span style="--c:${v?.color}">${esc(v?.avatar || "")}</span>`).join("")}</div>` : ""}
    </button>`;
  }).join("");
  el.querySelectorAll("[data-vote]").forEach((b) => (b.onclick = () => castVote(b.dataset.vote)));
}

function renderFeed() {
  const st = R.status(), g = R.game();
  const clues = S.room.clues || {};
  const feed = $("#feed");
  const rounds = Object.keys(clues).map(Number).sort((a, b) => a - b);
  if (st === "clue" && !rounds.includes(g.round)) rounds.push(g.round);
  let html = "";
  if (!rounds.length) {
    html = `<div class="feed-empty"><div class="big-emo">🤫</div>Les indices apparaîtront ici</div>`;
  }
  for (const r of rounds) {
    html += `<div class="round-sep"><span>Manche ${r}</span></div>`;
    const list = Object.entries(clues[r] || {}).sort((a, b) => +a[0] - +b[0]);
    for (const [, c] of list) {
      const p = R.p(c.uid);
      const ck = `${r}-${c.at}`;
      const isNew = !S.seenClues.has(ck); S.seenClues.add(ck);
      html += `
      <div class="clue ${c.uid === me() ? "mine" : ""} ${isNew ? "new" : ""}">
        ${avatarHTML(p, "sm")}
        <div class="bubble" style="--c:${p?.color || "#888"}">
          <div class="who">${esc(p?.name || "?")}</div>
          ${c.skipped ? `<div class="txt skipped">⏰ a passé son tour</div>` : `<div class="txt">${esc(c.text)}</div>`}
        </div>
      </div>`;
    }
    if (st === "clue" && r === g.round) {
      const cur = R.p(R.current());
      if (cur) html += `
      <div class="clue pending ${R.current() === me() ? "mine" : ""}">
        ${avatarHTML(cur, "sm")}
        <div class="bubble" style="--c:${cur.color}">
          <div class="who">${esc(cur.name)}</div>
          <div class="txt">${cur.typing ? `<span class="dots"><i></i><i></i><i></i></span>` : `<span class="think">réfléchit…</span>`}</div>
        </div>
      </div>`;
    }
  }
  const atBottom = !feedScrollLock;
  feed.innerHTML = html;
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

function renderDock() {
  const st = R.status(), g = R.game();
  const mePl = R.p(me());
  const myTurn = st === "clue" && R.current() === me();
  const amAlive = mePl?.alive && !mePl?.spectator;
  const key = `${st}-${g.round}-${g.turn}-${myTurn}-${amAlive}-${R.isHost()}`;
  const dock = $("#dock");

  if (key !== dockKey) {
    dockKey = key;
    if (st === "clue" && myTurn) {
      dock.innerHTML = `
        <div class="your-turn">
          <div class="yt-title">🎤 À toi ! Donne un indice</div>
          <div class="composer">
            <input id="clue" class="field" maxlength="32" placeholder="Un mot, une idée…" autocomplete="off" enterkeyhint="send" />
            <button class="btn pink send" id="sendClue">➤</button>
          </div>
          <div class="timer"><div class="timer-fill" id="timerFill"></div></div>
        </div>`;
      const inp = $("#clue");
      inp.oninput = onTyping;
      inp.onkeydown = (e) => { if (e.key === "Enter") submitClue(); };
      $("#sendClue").onclick = submitClue;
      setTimeout(() => inp.focus(), 50);
    } else if (st === "clue") {
      const cur = R.p(R.current());
      dock.innerHTML = `
        <div class="status-line">
          ${avatarHTML(cur, "sm")}
          <div class="grow">C'est au tour de <b>${esc(cur?.name || "…")}</b></div>
          ${R.isHost() ? `<button class="btn ghost sm" id="skip">Passer ⏭</button>` : ""}
        </div>
        <div class="timer"><div class="timer-fill" id="timerFill"></div></div>`;
      $("#skip") && ($("#skip").onclick = () => { if (confirm(`Passer le tour de ${cur?.name} ?`)) advanceTurn(null, true); });
    } else if (st === "vote") {
      dock.innerHTML = `<div class="vote-dock" id="voteDock"></div>`;
    } else {
      dock.innerHTML = "";
    }
  }
  if (st === "vote") {
    const votes = R.votes();
    const pending = R.alive().filter((p) => !votes[p.id]);
    const vd = $("#voteDock");
    if (vd) vd.innerHTML = `
      <div class="vote-title">${amAlive ? (votes[me()] ? `Tu votes contre <b>${esc(R.p(votes[me()])?.name)}</b> — touche un autre joueur pour changer` : "🗳️ Touche un joueur pour l'accuser") : "👻 Les vivants votent…"}</div>
      <div class="vote-sub">${pending.length ? `En attente : ${pending.map((p) => esc(p.avatar)).join(" ")}` : "Dépouillement…"}</div>
      ${R.isHost() && pending.length ? `<button class="btn ghost sm" id="forceVote">Clore le vote</button>` : ""}`;
    $("#forceVote") && ($("#forceVote").onclick = () => { S.hostDone.add(`resolve-${R.game().round}`); resolveVote(); });
  }
}

// Animation de la barre de temps
(function tickTimer() {
  const fill = document.getElementById("timerFill");
  if (fill && S.room && R.status() === "clue") {
    const g = R.game();
    if (g.turnEndsAt) {
      const total = R.settings().clueTime * 1000;
      const left = Math.max(0, g.turnEndsAt - store.now());
      const pct = Math.max(0, Math.min(100, (left / total) * 100));
      fill.style.width = pct + "%";
      fill.classList.toggle("hurry", left < 10000);
      fill.parentElement.dataset.left = Math.ceil(left / 1000) + "s";
    } else {
      fill.style.width = "100%";
      fill.parentElement.dataset.left = "∞";
    }
  }
  requestAnimationFrame(tickTimer);
})();

function renderOverlay() {
  const st = R.status(), g = R.game();
  const ov = $("#overlay");
  const key = `${st}-${g.round}-${S.revealFlipped}-${R.p(me())?.ready}-${g.mwGuess ?? ""}-${g.mwFail ?? ""}-${R.isHost()}-${!!S.secret}-${st === "reveal" ? R.alive().filter((p) => p.ready).length : ""}-${st === "over" ? JSON.stringify(R.list().map((p) => p.score)) : ""}`;
  if (ov.dataset.key === key) return;
  ov.dataset.key = key;

  if (st === "reveal") return (ov.innerHTML = revealOverlay(), bindReveal());
  if (st === "elim" || st === "guess") return (ov.innerHTML = elimOverlay(), bindElim());
  if (st === "over") return (ov.innerHTML = overOverlay(), bindOver());
  ov.innerHTML = "";
}

function revealOverlay() {
  const mePl = R.p(me());
  const spectator = mePl?.spectator;
  const ready = R.alive().filter((p) => p.ready).length;
  const total = R.alive().length;
  const c = R.game().composition || {};
  if (spectator) return `
    <div class="overlay-screen"><div class="reveal-wrap"><h2 class="ov-title">Distribution des mots…</h2>
    <p class="ov-sub">${ready}/${total} joueurs prêts</p></div></div>`;
  const sec = S.secret;
  const r = sec?.role ? ROLES[sec.role] : null;
  return `
  <div class="overlay-screen">
    <div class="reveal-wrap">
      <h2 class="ov-title">Ton mot secret</h2>
      <p class="ov-sub">Cache ton écran 🤫</p>
      <button class="flip-card ${S.revealFlipped ? "flipped" : ""}" id="flip">
        <div class="face front"><div class="fc-emo">🕵️</div><div>Touche pour révéler</div></div>
        <div class="face back ${r ? r.cls : ""}">
          ${!sec ? `<div class="loader"></div>` : `
            ${r ? `<div class="fc-emo">${r.icon}</div><div class="fc-role">${esc(r.label)}</div>` : ""}
            ${sec.word ? `<div class="fc-label">${sec.masked ? "Ce que tu vois du mot" : "Ton mot"}</div><div class="fc-word ${sec.masked ? "masked" : ""}">${esc(sec.word)}</div>` : `<div class="fc-word">Aucun mot</div>`}
            <div class="fc-hint">${esc((r || ROLES.civil).hint)}</div>`}
        </div>
      </button>
      <div class="compo centered">
        ${compoTags(c)}
      </div>
      ${mePl?.ready
        ? `<div class="waiting">Prêts : ${ready}/${total} <span class="dots"><i></i><i></i><i></i></span></div>`
        : `<button class="btn yellow xl" id="readyBtn" ${S.revealFlipped && S.secret ? "" : "disabled"}>C'est bon, je l'ai !</button>`}
    </div>
  </div>`;
}
function bindReveal() {
  const f = $("#flip");
  if (f) f.onclick = () => { sfx.tap(); S.revealFlipped = !S.revealFlipped; f.classList.toggle("flipped", S.revealFlipped); const rb = $("#readyBtn"); if (rb && S.secret) rb.disabled = false; };
  const rb = $("#readyBtn");
  if (rb) rb.onclick = () => { sfx.send(); store.update(roomPath(`players/${me()}`), { ready: true }); };
}

function elimOverlay() {
  const st = R.status(), g = R.game();
  const e = g.elim || {};
  const p = R.p(e.uid);
  const role = ROLES[e.role] || ROLES.civil;
  const isMe = e.uid === me();
  let extra = "";
  if (st === "guess") {
    if (isMe && g.mwGuess == null) extra = `
      <div class="mw-box">
        <div class="mw-title">Dernière chance ! Devine le mot des civils</div>
        <div class="composer"><input id="guess" class="field" maxlength="40" placeholder="Le mot est…" autocomplete="off" enterkeyhint="send"/><button class="btn pink send" id="guessBtn">➤</button></div>
      </div>`;
    else extra = `<div class="mw-box"><div class="mw-title">${g.mwGuess != null ? `${esc(role.label)} propose « <b>${esc(g.mwGuess)}</b> »…` : `${esc(role.label)} tente de deviner le mot des civils…`}</div><span class="dots"><i></i><i></i><i></i></span>
      ${R.isHost() && !isMe && g.mwGuess == null ? `<button class="btn ghost sm" id="mwSkip">Il ne répond pas ? Passer</button>` : ""}</div>`;
  } else if (g.mwFail) {
    extra = `<div class="mw-box fail">❌ Raté ! « ${esc(g.mwGuess)} » n'est pas le bon mot.</div>`;
  }
  const tally = e.tally ? Object.entries(e.tally).sort((a, b) => b[1] - a[1]).map(([id, c]) => `<span>${esc(R.p(id)?.avatar)} ${c}</span>`).join("") : "";
  return `
  <div class="overlay-screen dim">
    <div class="elim-card">
      ${e.tie ? `<div class="tie">⚖️ Égalité ! Le sort a tranché…</div>` : ""}
      <div class="elim-av">${avatarHTML(p, "xl")}<div class="cross">✕</div></div>
      <h2 class="ov-title">${isMe ? "Tu es éliminé·e !" : `${esc(p?.name)} est éliminé·e`}</h2>
      ${tally ? `<div class="tally">${tally}</div>` : ""}
      <div class="role-reveal ${role.cls}"><span>${role.icon}</span> C'était ${role.article}<b>${role.label}</b> !</div>
      ${extra}
      ${st === "elim" ? (R.isHost() ? `<button class="btn yellow xl" id="nextRound">Manche suivante ➜</button>` : `<div class="waiting">L'hôte lance la manche suivante <span class="dots"><i></i><i></i><i></i></span></div>`) : ""}
    </div>
  </div>`;
}
function bindElim() {
  const gb = $("#guessBtn");
  if (gb) { gb.onclick = submitGuess; $("#guess").onkeydown = (e) => { if (e.key === "Enter") submitGuess(); }; setTimeout(() => $("#guess")?.focus(), 100); }
  const ms = $("#mwSkip");
  if (ms) ms.onclick = () => store.update(roomPath("game"), { mwGuess: "" });
  const nr = $("#nextRound");
  if (nr) nr.onclick = withBusy(nr, nextRound);
}

function overOverlay() {
  const rv = S.room.reveal || {};
  const ws = WIN_SCREENS[rv.winner] || { title: "Fin de partie", emo: "🏁" };
  const winTitle = ws.title, winEmo = ws.emo;
  const iWon = (rv.winners || []).includes(me());
  const players = R.list().filter((p) => rv.roles?.[p.id]).sort((a, b) => (b.score || 0) - (a.score || 0));
  return `
  <div class="overlay-screen over ${rv.winner}">
    <div class="over-wrap">
      <div class="win-emo">${winEmo}</div>
      <h2 class="win-title">${winTitle}</h2>
      ${R.p(me())?.spectator ? "" : `<div class="you-result ${iWon ? "won" : "lost"}">${iWon ? "🏆 Victoire !" : "💀 Défaite"}</div>`}
      <div class="words-reveal">
        <div class="wr civil"><small>Mot des civils</small><b>${esc(rv.words?.civil)}</b></div>
        <div class="wr under"><small>Mot undercover</small><b>${esc(rv.words?.undercover)}</b></div>
      </div>
      <div class="final-list">
        ${players.map((p) => {
          const role = ROLES[rv.roles[p.id]];
          const won = (rv.winners || []).includes(p.id);
          return `<div class="fl ${won ? "won" : ""}">
            ${avatarHTML(p, "sm")}
            <div class="grow"><div class="fl-name">${esc(p.name)}${p.id === me() ? " (toi)" : ""}</div><div class="fl-role ${role.cls}">${role.icon} ${role.label}</div></div>
            <div class="fl-score">${won ? `<span class="plus">+${role.points}</span>` : ""}⭐ ${p.score || 0}</div>
          </div>`;
        }).join("")}
      </div>
      ${R.isHost() ? `<button class="btn yellow xl" id="replay">🔁 Rejouer</button>` : `<div class="waiting">L'hôte peut relancer une partie <span class="dots"><i></i><i></i><i></i></span></div>`}
      <button class="link-btn" id="quit">Quitter la room</button>
    </div>
  </div>`;
}
function bindOver() {
  const rb = $("#replay");
  if (rb) rb.onclick = withBusy(rb, replay);
  $("#quit").onclick = () => leaveRoom();
}

/* ============================================================
   Confettis
   ============================================================ */
function confetti() {
  const c = document.createElement("canvas");
  c.className = "confetti";
  c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
  document.body.appendChild(c);
  const ctx = c.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    s: 5 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
    col: pick(COLORS),
  }));
  let t = 0;
  (function frame() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.col;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
    }
    if (++t < 200) requestAnimationFrame(frame); else c.remove();
  })();
}

/* ============================================================
   Démarrage
   ============================================================ */
async function boot() {
  app.innerHTML = `<div class="screen center"><div class="logo-badge pulse">🕵️</div><div class="loader"></div></div>`;
  try {
    await initStore();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="screen center"><div class="card error"><h2>Connexion impossible</h2><p>${esc(e.message || e)}</p><p class="small">Vérifie la config Firebase et que l'auth anonyme est activée.</p><button class="btn yellow" onclick="location.reload()">Réessayer</button></div></div>`;
    return;
  }
  if (store.mode === "local") window.__ncStore = store; // debug / tests
  store.onConnection((c) => { const was = S.connected; S.connected = c; if (was !== c && S.code) render(); });

  const params = new URL(location.href).searchParams;
  const invited = params.get("r");
  const last = localStorage.getItem("nc_lastRoom");
  // Reconnexion automatique après un rechargement
  if (last && (!invited || invited.toUpperCase() === last) && S.profile.name) {
    const p = await store.get(`rooms/${last}/players/${me()}`);
    if (p) { await store.update(`rooms/${last}/players/${me()}`, { online: true }); return enterRoom(last); }
  }
  render();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.code && S.room?.players?.[me()]) {
    store.update(roomPath(`players/${me()}`), { online: true });
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

boot();
