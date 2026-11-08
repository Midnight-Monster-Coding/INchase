/* =============================================================================
 * INchase MULTIPLAYER  (loaded by index.html as <script type="module" src="multiplayer.js">)
 *
 *   Menu -> Global | Play with friend (Generate code | Enter code)
 *
 *   Transport   WebRTC data channels between the two players (mp-net.js).
 *               ICE order: STUN -> Metered TURN -> ExpressTURN (mp-config.js).
 *   Firestore   signaling + matchmaking only (a handful of small documents per match):
 *                 mp_codes/{CODE}                 friend code + offer / answer
 *                 mp_slots/b{band}s{shard}        ONE waiting ticket per skill band and shard  (O(1) pairing)
 *                 mp_invites/{shard}/items/{uid}  "wants to play globally" notices, sent to a few subscribers only
 *                 mp_ghosts/b{band}_{n}           recorded runs, the rival when nobody else is searching
 *                 mpstats/{uid}                   rating, wins, losses, streak
 *                 mp_config/main                  { mmShards, subShards } you raise these as the player count grows
 *   Game        the engine side is in index.html (section 10b). This file only talks to it through
 *               a one-time private handshake (window.__inchaseMPLink), same idea as auth.js.
 *   Rules       HYBRID duel: both players run their own game on their own device, but the WORLD is shared: the drones are a pure
 *               function of (seed, match clock) and the green orb is ONE contested orb. A touch is a claim stamped with the match
 *               clock; the host settles it (earliest wins, ties by seeded coin flip) and the next orb appears for both.
 *               Ghost / practice races keep a parallel race (the orb sequence is the same, nobody can snatch it).
 *               Both players run the SAME seeded match on their own device
 *               (same field, same spawns on the same clock) and see each other as an orb. 90 s, last 15 s count x2.
 * ========================================================================== */
import { getApp, initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, runTransaction, serverTimestamp, Timestamp,
  collection, query, where, limit, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { ICE_WORKER_URL, ICE_STUN_FALLBACK, FRIEND_POLICY, GLOBAL_POLICY, SCORE_WORKER_URL } from "./mp-config.js";
import { Peer } from "./mp-net.js";
import {
  MP, makeCode, normalizeCode, isValidCode, prettyCode, bandOf, ratingBand, bandsToScan, slotId, homeShard, shardsToProbe, pickShards,
  eloDelta, decideWinner, encodeSnap, decodeSnap, Interp, ClockSync, buildIceServers, hasTurn, OrbReferee,
  encodeGhost, decodeGhost, botGhost, ghostAt, fmtClock, cleanName
} from "./mp-core.js";

/* ---------------------------------------------------------------------------
 * 0. Handshake with the game + Firebase
 * ------------------------------------------------------------------------ */
const bridge = (typeof window.__inchaseMPLink === 'function') ? window.__inchaseMPLink() : null;
if (!bridge) throw new Error('INchase multiplayer: game bridge unavailable');

let app;
try { app = getApp(); } catch (e) { app = initializeApp(firebaseConfig); }
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
const DEBUG = lsGet('inchase_debug') === '1';
const log = (...a) => { if (DEBUG) console.log('[mp]', ...a); };
const toast = (m) => bridge.toast(m);
const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };

/* ICE servers: STUN-only fallback now, the full STUN + Metered + ExpressTURN list from the Cloudflare Worker once a player is logged in */
let ICE = buildIceServers({ stun: ICE_STUN_FALLBACK });
let iceAt = 0;
let icePromise = null;
function cleanIce(list) {
  if (!Array.isArray(list)) return [];
  const okUrl = (u) => typeof u === 'string' && u.length < 200 && /^(stun|turn|turns):/i.test(u);
  const out = [];
  list.slice(0, 12).forEach((s) => {
    if (!s) return;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(okUrl).slice(0, 8);
    if (!urls.length) return;
    const e = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof s.username === 'string' && typeof s.credential === 'string' && s.username.length < 512 && s.credential.length < 512) { e.username = s.username; e.credential = s.credential; }
    else if (urls.some((u) => /^turns?:/i.test(u))) return;   // a TURN entry without credentials can not work
    out.push(e);
  });
  return out;
}
async function loadIce() {
  const u = auth.currentUser;
  if (!u) return;
  const token = await u.getIdToken();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(ICE_WORKER_URL, { headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('ice worker ' + r.status);
    const list = cleanIce(await r.json());
    if (list.length) { ICE = list; iceAt = Date.now(); log('ice servers', list.length, 'turn:', hasTurn(list)); }
  } finally { clearTimeout(t); }
}
// resolves quickly; a failure keeps the STUN fallback and retries in about a minute
function ensureIce() {
  if (Date.now() - iceAt < 45 * 60 * 1000) return Promise.resolve();
  if (!icePromise) {
    icePromise = loadIce().catch((e) => { log('ice worker failed', e); iceAt = Date.now() - 44 * 60 * 1000; }).finally(() => { icePromise = null; });
  }
  return icePromise;
}
const iceReady = () => Promise.race([ensureIce(), new Promise((r) => setTimeout(r, 3000))]);

/* server clock: Date.now() + srvOffset = Firestore server time (used to judge how old a ticket / invite is) */
let srvOffset = 0;
let srvSyncedAt = 0;
const nowSrv = () => Date.now() + srvOffset;
const tsMs = (t) => (t && typeof t.toMillis === 'function') ? t.toMillis() : 0;
const age = (d) => { const t = tsMs(d && d.ts); return t ? nowSrv() - t : Infinity; };

/* ---------------------------------------------------------------------------
 * 1. Identity, avatars, stats
 * ------------------------------------------------------------------------ */
function safeImg(u) {
  if (typeof u !== 'string' || u.length > 20000) return '';
  // SECURITY: same allow-list as firestore.rules. A rival can not make your browser load an image from a server of their choice.
  return (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u) || /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\/[A-Za-z0-9_.\/=%~+-]*$/.test(u)) ? u : '';
}
function identity() {
  const u = auth.currentUser;
  if (!u || !bridge.isLoggedIn()) return null;
  let p = null;
  try { p = JSON.parse(lsGet('inchase_profile_v1') || 'null'); } catch (e) { p = null; }
  if (!p || p.uid !== u.uid || !/^[A-Za-z0-9_]{3,16}$/.test(String(p.username))) return null;
  return { uid: u.uid, name: cleanName(p.username), photo: safeImg(p.photoURL) };
}
// Google profile pictures are served as 96 px by default; the big VS screen asks for a larger copy of the same picture
function hiRes(u) {
  if (typeof u !== 'string' || !/^https:\/\/[^/]*googleusercontent\.com\//i.test(u)) return u;
  return u.replace(/=s\d+(-c)?$/, '=s512-c').replace(/\/s\d+-c\//, '/s512-c/');
}
function fillAvatar(d, who, hi) {
  d.textContent = '';
  if (who && who.photo) {
    const i = new Image();
    i.alt = ''; i.draggable = false; i.decoding = 'sync'; i.referrerPolicy = 'no-referrer';
    i.src = hi ? hiRes(who.photo) : who.photo;
    d.appendChild(i);
  } else d.textContent = ((who && who.name) || '?').charAt(0).toUpperCase();
}
function avatar(size, who, hi) {
  const d = el('div', 'mp-av');
  d.style.width = d.style.height = size + 'px';
  d.style.fontSize = Math.round(size * 0.46) + 'px';
  fillAvatar(d, who, hi);
  return d;
}
// start downloading / decoding a photo early (while the clocks sync), so it is ready when the VS screen opens
function warmPhoto(u) {
  if (!u) return;
  try { const i = new Image(); i.referrerPolicy = 'no-referrer'; i.src = hiRes(u); if (i.decode) i.decode().catch(() => {}); } catch (e) { /* ignore */ }
}

const DEFAULT_STATS = { rating: 1000, wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, games: 0, bestScore: 0 };
let stats = Object.assign({}, DEFAULT_STATS);
let statsLoaded = false;
const myBand = () => ratingBand(stats.rating);   // same-level matchmaking: by multiplayer rating

// reads my stats and, in the same round trip, measures the server clock offset
async function syncProfileAndClock() {
  const id = identity();
  if (!id) return;
  const ref = doc(db, 'mpstats', id.uid);
  try {
    if (!statsLoaded || Date.now() - srvSyncedAt > 30 * 60 * 1000) {
      const t0 = Date.now();
      await setDoc(ref, { seen: serverTimestamp() }, { merge: true });
      const snap = await getDoc(ref);
      const t1 = Date.now();
      const d = snap.data() || {};
      if (d.seen) { srvOffset = tsMs(d.seen) - (t0 + t1) / 2; srvSyncedAt = Date.now(); }
      stats = Object.assign({}, DEFAULT_STATS, pickStats(d));
      statsLoaded = true;
    }
  } catch (e) { log('profile sync failed', e); }
}
function pickStats(d) {
  const o = {};
  Object.keys(DEFAULT_STATS).forEach((k) => { if (typeof d[k] === 'number' && Number.isFinite(d[k])) o[k] = d[k]; });
  return o;
}
async function fetchOpponent(uid) {
  const out = { photo: '', rating: 0 };
  try { const s = await getDoc(doc(db, 'leaderboard', uid)); if (s.exists()) out.photo = safeImg((s.data() || {}).photoURL); } catch (e) { /* optional */ }
  try { const s = await getDoc(doc(db, 'mpstats', uid)); if (s.exists()) out.rating = num((s.data() || {}).rating, 0, 4000, 0); } catch (e) { /* optional */ }
  return out;
}

/* ---------------------------------------------------------------------------
 * 2. Sound (uses the game's own synth, so MUTE keeps working)
 * ------------------------------------------------------------------------ */
const tone = (f, type, d, g, slide) => { try { bridge.tone(f, type, d, g, slide); } catch (e) { /* ignore */ } };
const sfx = {
  whoosh(up) { tone(up ? 110 : 900, 'sawtooth', 0.38, 0.09, up ? 760 : 140); },
  pop() { tone(660, 'triangle', 0.09, 0.1, 990); setTimeout(() => tone(990, 'sine', 0.1, 0.07), 70); },
  boom() { tone(95, 'sine', 0.7, 0.3, 36); tone(70, 'square', 0.4, 0.09, 28); setTimeout(() => { tone(329.6, 'sawtooth', 0.5, 0.07); tone(493.9, 'sawtooth', 0.5, 0.06); tone(659.3, 'triangle', 0.6, 0.06); }, 40); },
  sting() { [523.25, 783.99, 1046.5].forEach((f, i) => setTimeout(() => tone(f, 'triangle', 0.2, 0.1, f * 1.02), i * 90)); },
  beep() { tone(520, 'sine', 0.13, 0.12); },
  go() { tone(784, 'triangle', 0.1, 0.14); setTimeout(() => tone(1175, 'triangle', 0.45, 0.14, 1250), 90); },
  win() { [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => setTimeout(() => tone(f, 'triangle', 0.26, 0.13, f * 1.02), i * 85)); },
  lose() { [392, 330, 262, 196].forEach((f, i) => setTimeout(() => tone(f, 'sawtooth', 0.3, 0.09, f * 0.96), i * 130)); },
  ko() { tone(200, 'square', 0.5, 0.16, 40); setTimeout(() => sfx.win(), 220); },
  invite() { tone(740, 'sine', 0.12, 0.1, 988); setTimeout(() => tone(988, 'sine', 0.18, 0.1, 1250), 110); }
};

/* ---------------------------------------------------------------------------
 * 3. State + UI shell (menu / friend / code / search / connecting / error)
 * ------------------------------------------------------------------------ */
const Z = { match: null, host: null, search: null, view: null, matchSeq: 0, joinFails: [], notify: lsGet('inchase_mp_notify') === '1' };

const modal = el('div', 'auth-modal hidden fixed inset-0 z-[55] flex items-center justify-center p-5 bg-black/80');
modal.id = 'mpModal';
const card = el('div', 'max-w-sm w-full retro-chassis rounded-2xl p-6 text-center mp-card');
modal.appendChild(card);
document.body.appendChild(modal);

const views = {};
function view(name, build) { const v = el('div', 'mp-view hidden'); v.dataset.view = name; build(v); card.appendChild(v); views[name] = v; return v; }
function show(name) {
  Z.view = name;
  Object.keys(views).forEach((k) => views[k].classList.toggle('hidden', k !== name));
  modal.classList.remove('hidden');
}
function hideModal() { modal.classList.add('hidden'); Z.view = null; }
const title = (t, col) => { const h = el('h2', 'text-2xl mb-3 t-ink', t); h.style.textShadow = '3px 3px 0 var(--' + (col || 'cyan') + ')'; return h; };
const btn = (label, cls, fn) => { const b = el('button', 'retro-key ' + cls + ' w-full py-3 px-6 rounded-xl text-sm tracking-wide mt-3', label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const note = (t) => el('p', 'text-[11px] leading-relaxed opacity-80', t);

let ui = {};
view('menu', (v) => {
  v.appendChild(title('MULTIPLAYER', 'pink'));
  ui.statLine = el('div', 'nb-pill c-cyan inline-block mb-2 text-[10px] tracking-widest', '');
  v.appendChild(ui.statLine);
  v.appendChild(note('90 SECOND DUEL. BEST SCORE WINS. LAST 15 SECONDS COUNT DOUBLE.'));
  v.appendChild(btn('GLOBAL', 'retro-key-active', () => startGlobal()));
  v.appendChild(btn('PLAY WITH FRIEND', 'c-lime', () => show('friend')));
  const lab = el('label', 'mp-check');
  ui.notifyChk = el('input'); ui.notifyChk.type = 'checkbox'; ui.notifyChk.checked = Z.notify;
  ui.notifyChk.addEventListener('change', () => { Z.notify = ui.notifyChk.checked; lsSet('inchase_mp_notify', Z.notify ? '1' : '0'); syncInbox(); });
  lab.appendChild(ui.notifyChk);
  lab.appendChild(el('span', '', 'ACCEPT GLOBAL MULTIPLAYER NOTIFICATIONS'));
  v.appendChild(lab);
  v.appendChild(btn('CLOSE', 'c-white', hideModal));
});
view('friend', (v) => {
  v.appendChild(title('PLAY WITH FRIEND', 'lime'));
  v.appendChild(note('ONE PLAYER MAKES A CODE, THE OTHER TYPES IT IN.'));
  v.appendChild(btn('GENERATE CODE', 'retro-key-active', () => hostFriend()));
  v.appendChild(btn('ENTER CODE', 'c-orange', () => { ui.codeInput.value = ''; ui.joinMsg.textContent = ''; show('join'); setTimeout(() => ui.codeInput.focus(), 50); }));
  v.appendChild(btn('BACK', 'c-white', () => show('menu')));
});
view('host', (v) => {
  v.appendChild(title('YOUR CODE', 'lime'));
  ui.hostCode = el('div', 'mp-code', '......');
  v.appendChild(ui.hostCode);
  ui.hostMsg = note('CREATING A SECURE CODE...');
  v.appendChild(ui.hostMsg);
  const row = el('div', 'grid grid-cols-2 gap-3');
  const copy = el('button', 'retro-key c-white py-2 rounded-xl text-xs mt-3', 'COPY'); copy.type = 'button';
  copy.addEventListener('click', () => copyText(Z.host && Z.host.code ? Z.host.code : '', 'CODE COPIED'));
  const share = el('button', 'retro-key c-cyan py-2 rounded-xl text-xs mt-3', 'SHARE LINK'); share.type = 'button';
  share.addEventListener('click', shareCode);
  row.appendChild(copy); row.appendChild(share);
  v.appendChild(row);
  v.appendChild(btn('CANCEL', 'c-white', () => { cancelHost(); show('friend'); }));
});
view('join', (v) => {
  v.appendChild(title('ENTER CODE', 'orange'));
  ui.codeInput = el('input', 'mp-code-input');
  ui.codeInput.type = 'text'; ui.codeInput.maxLength = 8; ui.codeInput.autocomplete = 'off'; ui.codeInput.spellcheck = false;
  ui.codeInput.setAttribute('autocapitalize', 'characters'); ui.codeInput.placeholder = 'ABC 123';
  ui.codeInput.addEventListener('input', () => { ui.codeInput.value = normalizeCode(ui.codeInput.value); });
  ui.codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFriend(ui.codeInput.value); });
  v.appendChild(ui.codeInput);
  ui.joinMsg = el('p', 'text-[11px] mt-2 mp-err', '');
  v.appendChild(ui.joinMsg);
  v.appendChild(btn('JOIN', 'retro-key-active', () => joinFriend(ui.codeInput.value)));
  v.appendChild(btn('BACK', 'c-white', () => show('friend')));
});
view('search', (v) => {
  v.appendChild(title('GLOBAL', 'cyan'));
  ui.searchTime = el('div', 'mp-timer', '00:00');
  v.appendChild(ui.searchTime);
  ui.searchMsg = note('LOOKING FOR A PLAYER NEAR YOUR LEVEL...');
  v.appendChild(ui.searchMsg);
  ui.ghostBtn = btn('PLAY VS GHOST (UNRATED)', 'c-orange', () => startGhostFromSearch());
  ui.ghostBtn.classList.add('hidden');
  v.appendChild(ui.ghostBtn);
  v.appendChild(btn('CANCEL', 'c-white', () => { cancelSearch(); show('menu'); }));
});
view('connecting', (v) => {
  v.appendChild(title('CONNECTING', 'cyan'));
  v.appendChild(el('div', 'mp-spin'));
  ui.connMsg = note('');
  v.appendChild(ui.connMsg);
  v.appendChild(btn('CANCEL', 'c-white', () => abortAll()));
});
view('error', (v) => {
  v.appendChild(title('OOPS', 'pink'));
  ui.errMsg = note('');
  v.appendChild(ui.errMsg);
  v.appendChild(btn('BACK', 'retro-key-active', () => { show('menu'); refreshStatLine(); }));
  v.appendChild(btn('CLOSE', 'c-white', hideModal));
});
function showConnecting(msg) { ui.connMsg.textContent = msg || ''; show('connecting'); }
function showError(msg) { ui.errMsg.textContent = msg; show('error'); }
function refreshStatLine() {
  ui.statLine.textContent = 'RATING ' + stats.rating + '  ·  ' + stats.wins + 'W ' + stats.losses + 'L' + (stats.streak > 1 ? '  ·  ' + stats.streak + ' STREAK' : '');
}
modal.addEventListener('click', (e) => { if (e.target === modal && (Z.view === 'menu' || Z.view === 'friend' || Z.view === 'error')) hideModal(); });

function copyText(t, okMsg) {
  if (!t) return;
  const done = () => toast(okMsg);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done).catch(() => legacyCopy(t, done));
  else legacyCopy(t, done);
}
function legacyCopy(t, done) {
  const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
  ta.remove();
}
function shareCode() {
  const c = Z.host && Z.host.code;
  if (!c) return;
  const url = location.origin + '/?join=' + c;
  const text = 'Duel me in INchase! Code ' + prettyCode(c) + ' ' + url;
  if (navigator.share) navigator.share({ title: 'INchase duel', text, url }).catch(() => {});
  else copyText(text, 'INVITE COPIED');
}

async function openMenu() {
  if (!bridge.isLoggedIn()) { toast('LOGIN TO PLAY MULTIPLAYER'); bridge.openLogin(); return; }
  if (!bridge.canStart()) { toast('FINISH YOUR RUN FIRST'); return; }
  if (!window.RTCPeerConnection) { toast('THIS BROWSER CAN NOT DO MULTIPLAYER'); return; }
  bridge.initAudio();
  ensureIce();
  refreshStatLine();
  ui.notifyChk.checked = Z.notify;
  show('menu');
  await syncProfileAndClock();
  refreshStatLine();
}

/* ---------------------------------------------------------------------------
 * 4. Server config (shard counts)
 * ------------------------------------------------------------------------ */
let cfgCache = { t: 0, mm: 1, sub: 1 };
async function getCfg() {
  if (Date.now() - cfgCache.t < 10 * 60 * 1000) return cfgCache;
  try {
    const s = await getDoc(doc(db, 'mp_config', 'main'));
    const d = s.exists() ? s.data() : {};
    cfgCache = { t: Date.now(), mm: Math.round(num(d.mmShards, 1, 64, 1)), sub: Math.round(num(d.subShards, 1, 4096, 1)) };
  } catch (e) { cfgCache.t = Date.now(); }
  return cfgCache;
}
const expireIn = (ms) => Timestamp.fromMillis(nowSrv() + ms);

/* ---------------------------------------------------------------------------
 * 5. FRIEND CODE
 * ------------------------------------------------------------------------ */
function cancelHost() {
  const H = Z.host;
  if (!H) return;
  Z.host = null;
  H.cancelled = true;
  clearInterval(H.timer);
  if (H.unsub) { try { H.unsub(); } catch (e) { /* ignore */ } }
  if (H.code) deleteDoc(doc(db, 'mp_codes', H.code)).catch(() => {});
  if (Z.match && Z.match.hostRef === H) { /* the peer lives on in the match */ } else if (H.peer) H.peer.close();
}

async function hostFriend() {
  const id = identity();
  if (!id) { toast('LOGIN TO PLAY MULTIPLAYER'); return; }
  cancelHost();
  await iceReady();
  ui.hostCode.textContent = '......';
  ui.hostMsg.textContent = 'CREATING A SECURE CODE...';
  show('host');
  const H = Z.host = { cancelled: false, peer: null, code: '', unsub: null, timer: 0, gotAnswer: false };
  try {
    for (let i = 0; i < 6 && !H.code; i++) {
      const c = makeCode(cryptoRand);
      try {
        await setDoc(doc(db, 'mp_codes', c), { host: id.uid, name: id.name, state: 'open', ts: serverTimestamp(), expireAt: expireIn(3600e3) });
        H.code = c;
      } catch (e) { if (i === 5 || H.cancelled) throw e; }   // a taken code is refused by the rules: try another
    }
    if (H.cancelled) return;
    ui.hostCode.textContent = prettyCode(H.code);
    const M = newMatch('friend', 'host', null);
    M.hostRef = H;
    makePeer(M, FRIEND_POLICY);
    H.peer = M.peer;
    const offer = await M.peer.makeOffer();
    if (H.cancelled) return;
    const ref = doc(db, 'mp_codes', H.code);
    await updateDoc(ref, { offer });
    const t0 = Date.now();
    H.timer = setInterval(() => {
      const left = MP.CODE_TTL_MS - (Date.now() - t0);
      if (left <= 0) { cancelHost(); if (Z.match) dropMatch(Z.match); showError('THE CODE EXPIRED. MAKE A NEW ONE.'); return; }
      ui.hostMsg.textContent = 'WAITING FOR YOUR FRIEND...  ' + fmtClock(left / 1000);
    }, 500);
    H.unsub = onSnapshot(ref, (snap) => {
      const d = snap.data();
      if (!d || !d.answer || !d.guest || H.gotAnswer || H.cancelled) return;
      H.gotAnswer = true;
      clearInterval(H.timer);
      M.expectUid = String(d.guest);
      M.opp = { uid: M.expectUid, name: cleanName(d.guestName) };
      showConnecting('FRIEND FOUND. CONNECTING...');
      M.peer.setAnswer(d.answer).catch((e) => failMatch(M, 'COULD NOT CONNECT'));
      deleteDoc(ref).catch(() => {});
    }, (e) => { log('host listener', e); });
  } catch (e) {
    log('host failed', e);
    if (!H.cancelled) { cancelHost(); if (Z.match) dropMatch(Z.match); showError('COULD NOT CREATE A CODE. CHECK YOUR CONNECTION.'); }
  }
}
function cryptoRand() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 4294967296; }

async function joinFriend(raw) {
  const id = identity();
  if (!id) { toast('LOGIN TO PLAY MULTIPLAYER'); bridge.openLogin(); return; }
  const code = normalizeCode(raw);
  if (!isValidCode(code)) { ui.joinMsg.textContent = 'ENTER THE 6 CHARACTER CODE'; show('join'); return; }
  const now = Date.now();
  Z.joinFails = Z.joinFails.filter((t) => now - t < 30000);
  if (Z.joinFails.length >= 3) { ui.joinMsg.textContent = 'TOO MANY WRONG CODES. WAIT A MOMENT.'; show('join'); return; }
  showConnecting('FINDING YOUR FRIEND...');
  await iceReady();
  let M = null;
  const bad = (msg) => { Z.joinFails.push(Date.now()); if (M) dropMatch(M); ui.joinMsg.textContent = msg; show('join'); };
  try {
    const ref = doc(db, 'mp_codes', code);
    const first = await getDoc(ref);
    if (!first.exists()) return bad('CODE NOT FOUND OR EXPIRED');
    let d = first.data();
    if (d.host === id.uid) return bad('THAT IS YOUR OWN CODE');
    if (d.state !== 'open' || age(d) > MP.CODE_TTL_MS) return bad('CODE NOT FOUND OR EXPIRED');
    if (!d.offer) d = await waitForField(ref, 'offer', 9000);
    if (!d || !d.offer) return bad('YOUR FRIEND IS NOT READY. TRY AGAIN.');
    M = newMatch('friend', 'guest', String(d.host));
    M.opp = { uid: String(d.host), name: cleanName(d.name) };
    makePeer(M, FRIEND_POLICY);
    const answer = await M.peer.makeAnswer(d.offer);
    if (Z.match !== M) return;
    try { await updateDoc(ref, { guest: id.uid, guestName: id.name, answer, state: 'joined' }); }
    catch (e) { return bad('THAT CODE WAS ALREADY USED'); }
    showConnecting('CONNECTING TO ' + M.opp.name + '...');
  } catch (e) {
    log('join failed', e);
    if (M) { if (Z.match === M) failMatch(M, 'COULD NOT CONNECT'); } else showError('COULD NOT REACH THE SERVER.');
  }
}
function waitForField(ref, field, ms) {
  return new Promise((resolve) => {
    let un = null;
    const t = setTimeout(() => { if (un) un(); resolve(null); }, ms);
    un = onSnapshot(ref, (s) => { const d = s.data(); if (d && d[field]) { clearTimeout(t); un(); resolve(d); } }, () => { clearTimeout(t); resolve(null); });
  });
}

/* ---------------------------------------------------------------------------
 * 6. GLOBAL MATCHMAKING: one waiting ticket per (skill band, shard), claimed in a transaction
 *
 *    Searcher: (1) read up to a few slots (own band, then wider as time passes) and claim a fresh waiting ticket;
 *              (2) none: put my own ticket (with my WebRTC offer) in my home slot and wait on MY OWN document.
 *    Cost: O(1) reads/writes per player, no queue scan. A waiter only moves to a slot with a SMALLER id, so two
 *    waiters can never claim each other at the same time.
 * ------------------------------------------------------------------------ */
const fresh = (d) => d && !d.claimedBy && d.offer && age(d) < MP.SLOT_STALE_MS;

async function startGlobal(auto) {
  const id = identity();
  if (!id) return;
  if (!auto) Z.autoRetry = 0;
  cancelSearch();
  await Promise.all([syncProfileAndClock(), iceReady()]);
  const cfg = await getCfg();
  const S = Z.search = {
    id: ++Z.matchSeq, t0: Date.now(), cancelled: false, me: id, band: myBand(), cfg,
    slot: '', waiterMatch: null, unsub: null, refresh: 0, tick: 0, loop: 0, handled: false,
    usedShards: new Set(), wavesDone: 0, inviteRefs: [], tries: 0
  };
  ui.searchTime.textContent = '00:00';
  ui.searchMsg.textContent = 'LOOKING FOR A PLAYER NEAR YOUR LEVEL...';
  ui.ghostBtn.classList.add('hidden');
  show('search');
  S.tick = setInterval(() => {
    const el2 = Date.now() - S.t0;
    ui.searchTime.textContent = fmtClock(el2 / 1000);
    ui.searchMsg.textContent = el2 > MP.WIDEN_2_MS ? 'SEARCHING ALL LEVELS...' : el2 > MP.WIDEN_1_MS ? 'WIDENING THE SEARCH...' : 'LOOKING FOR A PLAYER NEAR YOUR LEVEL...';
    if (el2 > MP.GHOST_OFFER_MS) ui.ghostBtn.classList.remove('hidden');
    sendInviteWaves(S, el2);
  }, 250);
  searchLoop(S);
}

async function searchLoop(S) {
  while (!S.cancelled && !S.handled) {
    try {
      const elapsed = Date.now() - S.t0;
      const hit = await tryClaimAny(S, elapsed);
      if (S.cancelled || S.handled) return;
      if (hit) { await connectAsGuest(S, hit); return; }
      if (!S.slot) await becomeWaiter(S);
    } catch (e) { log('search step failed', e); }
    const wait = Date.now() - S.t0 > MP.WIDEN_1_MS ? MP.SEARCH_PROBE_MS + 1000 : MP.SEARCH_PROBE_MS;
    await sleep(wait);
  }
}

function candidateSlots(S, elapsed) {
  const shards = shardsToProbe(S.me.uid, S.cfg.mm, elapsed > MP.WIDEN_1_MS ? 3 : 2);
  const out = [];
  bandsToScan(S.band, elapsed).forEach((b) => shards.forEach((sh) => out.push(slotId(b, sh))));
  // a waiter only moves DOWN: it never claims a slot with a bigger id than its own
  return S.slot ? out.filter((x) => x < S.slot) : out;
}

async function tryClaimAny(S, elapsed) {
  for (const sid of candidateSlots(S, elapsed)) {
    if (S.cancelled || S.handled) return null;
    const hit = await claimSlot(S.me, sid, null, S);
    if (hit) return hit;
  }
  return null;
}

// Claim one slot: read, build my answer, then claim in a transaction (fails if somebody else got there first)
async function claimSlot(me, sid, expectUid, S) {
  const ref = doc(db, 'mp_slots', sid);
  let snap;
  try { snap = await getDoc(ref); } catch (e) { return null; }
  if (!snap.exists()) return null;
  const d = snap.data();
  if (!fresh(d) || d.uid === me.uid || (expectUid && d.uid !== expectUid)) return null;
  const M = newMatch('global', 'guest', String(d.uid));
  M.opp = { uid: String(d.uid), name: cleanName(d.name), band: num(d.band, 0, 5, 0) };
  makePeer(M, GLOBAL_POLICY);
  let answer;
  try { answer = await M.peer.makeAnswer(d.offer); } catch (e) { dropMatch(M); return null; }
  if (Z.match !== M || (S && (S.cancelled || S.handled))) { dropMatch(M); return null; }
  let ok = false;
  try {
    ok = await runTransaction(db, async (tx) => {
      const s2 = await tx.get(ref);
      if (!s2.exists()) return false;
      const x = s2.data();
      if (x.claimedBy || x.uid !== d.uid || x.offer !== d.offer || !(age(x) < MP.SLOT_STALE_MS)) return false;
      tx.update(ref, { claimedBy: me.uid, claimerName: me.name, answer });
      return true;
    });
  } catch (e) { ok = false; }
  if (!ok) { dropMatch(M); return null; }
  return M;
}

async function connectAsGuest(S, M) {
  S.handled = true;
  stopSearchTimers(S);
  removeInvites(S);
  if (S.slot) { deleteDoc(doc(db, 'mp_slots', S.slot)).catch(() => {}); if (S.waiterMatch) dropMatch(S.waiterMatch); S.slot = ''; }
  showConnecting('OPPONENT FOUND. CONNECTING...');
}

async function becomeWaiter(S) {
  const me = S.me;
  const home = slotId(S.band, homeShard(me.uid, S.cfg.mm));
  const M = newMatch('global', 'host', null);
  makePeer(M, GLOBAL_POLICY);
  let offer;
  try { offer = await M.peer.makeOffer(); } catch (e) { dropMatch(M); return; }
  if (S.cancelled || S.handled || Z.match !== M) { dropMatch(M); return; }
  const ref = doc(db, 'mp_slots', home);
  let state = 'occupied';
  try {
    state = await runTransaction(db, async (tx) => {
      const s2 = await tx.get(ref);
      if (s2.exists()) { const x = s2.data(); if (fresh(x) && x.uid !== me.uid) return 'occupied'; }
      tx.set(ref, { uid: me.uid, name: me.name, band: S.band, offer, ts: serverTimestamp(), expireAt: expireIn(3600e3) });
      return 'ok';
    });
  } catch (e) { log('waiter put failed', e); state = 'error'; }
  if (state !== 'ok') { dropMatch(M); return; }     // occupied: the next loop round claims that ticket
  S.slot = home;
  S.waiterMatch = M;
  S.unsub = onSnapshot(ref, (snap) => {
    const d = snap.data();
    if (!d || d.uid !== me.uid || !d.claimedBy || !d.answer || S.handled || S.cancelled) return;
    S.handled = true;
    stopSearchTimers(S);
    removeInvites(S);
    M.expectUid = String(d.claimedBy);
    M.opp = { uid: M.expectUid, name: cleanName(d.claimerName) };
    showConnecting('OPPONENT FOUND. CONNECTING...');
    M.peer.setAnswer(d.answer).catch(() => failMatch(M, 'COULD NOT CONNECT'));
    deleteDoc(ref).catch(() => {});
    S.waiterMatch = M;
    S.slot = '';
  }, (e) => log('slot listener', e));
  S.refresh = setInterval(() => { updateDoc(ref, { ts: serverTimestamp() }).catch(() => {}); }, MP.SLOT_REFRESH_MS);
}

function stopSearchTimers(S) {
  clearInterval(S.tick); clearInterval(S.refresh);
  if (S.unsub) { try { S.unsub(); } catch (e) { /* ignore */ } S.unsub = null; }
}
function cancelSearch() {
  const S = Z.search;
  if (!S) return;
  S.cancelled = true;
  stopSearchTimers(S);
  removeInvites(S);
  if (S.slot) deleteDoc(doc(db, 'mp_slots', S.slot)).catch(() => {});
  if (S.waiterMatch && !S.handled) dropMatch(S.waiterMatch);
  if (Z.match && Z.match.kind === 'global' && Z.match.phase === 'connect' && !S.handled) dropMatch(Z.match);
  Z.search = null;
  syncInbox();
}

// "X wants to play globally": a few subscribers only, in growing waves; cost is bounded and independent of the player count
function sendInviteWaves(S, elapsed) {
  if (S.cancelled || S.handled || !S.slot) return;
  const wave = MP.INVITE_WAVES[S.wavesDone];
  if (!wave || elapsed < wave[0]) return;
  S.wavesDone++;
  pickShards(S.cfg.sub, wave[1], S.usedShards).forEach((sh) => {
    S.usedShards.add(sh);
    const ref = doc(db, 'mp_invites', String(sh), 'items', S.me.uid);
    S.inviteRefs.push(ref);
    setDoc(ref, { uid: S.me.uid, name: S.me.name, band: S.band, slot: S.slot, ts: serverTimestamp(), expireAt: expireIn(3600e3) }).catch((e) => log('invite refused', e));
  });
}
function removeInvites(S) { S.inviteRefs.splice(0).forEach((r) => deleteDoc(r).catch(() => {})); }

/* ---------------------------------------------------------------------------
 * 7. Ghost rival (nobody found, or the player chose it)
 * ------------------------------------------------------------------------ */
async function loadGhost(band) {
  const tries = [];
  for (let i = 0; i < 3; i++) tries.push(Math.floor(cryptoRand() * MP.GHOST_SLOTS));
  for (const n of [...new Set(tries)]) {
    try {
      const s = await getDoc(doc(db, 'mp_ghosts', 'b' + band + '_' + n));
      if (s.exists()) { const g = decodeGhost(s.data()); if (g) return g; }
    } catch (e) { /* try the next one */ }
  }
  return botGhost((cryptoRand() * 4294967296) >>> 0, band);
}
async function startGhostFromSearch() {
  const band = Z.search ? Z.search.band : myBand();
  cancelSearch();
  showConnecting('FINDING A GHOST...');
  startGhostMatch(await loadGhost(band));
}

/* ---------------------------------------------------------------------------
 * 8. "Wants to play globally" inbox (opt-in, listens to ONE shard, only while idle and visible)
 * ------------------------------------------------------------------------ */
const inbox = { unsub: null, shard: -1, declines: 0, banner: null, current: null, timer: 0 };
const SNOOZE_KEY = 'inchase_mp_snooze_until';
const blockKey = 'inchase_mp_blocked';
const blocked = () => { try { return JSON.parse(lsGet(blockKey) || '[]'); } catch (e) { return []; } };

async function syncInbox() {
  const want = Z.notify && !document.hidden && !Z.match && !Z.search && !!identity() && Date.now() > Number(lsGet(SNOOZE_KEY) || 0);
  $('mpDot') && $('mpDot').classList.toggle('hidden', !Z.notify);
  if (!want) { stopInbox(); return; }
  const cfg = await getCfg();
  const id = identity();
  if (!id) return;
  const shard = homeShard(id.uid, cfg.sub);
  if (inbox.unsub && inbox.shard === shard) return;
  stopInbox();
  await syncProfileAndClock();
  inbox.shard = shard;
  const q = query(collection(db, 'mp_invites', String(shard), 'items'), where('ts', '>', Timestamp.fromMillis(nowSrv() - MP.INVITE_TTL_MS)), limit(20));
  inbox.unsub = onSnapshot(q, (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type === 'removed') return;
      const d = ch.doc.data();
      if (!d || d.uid === id.uid || age(d) > MP.INVITE_TTL_MS || blocked().includes(d.uid)) return;
      offerInvite({ uid: String(d.uid), name: cleanName(d.name), slot: String(d.slot || ''), ts: tsMs(d.ts) });
    });
  }, (e) => log('inbox listener', e));
}
function stopInbox() { if (inbox.unsub) { try { inbox.unsub(); } catch (e) { /* ignore */ } } inbox.unsub = null; inbox.shard = -1; hideBanner(); }

function offerInvite(inv) {
  inbox.current = inv;
  sfx.invite();
  renderBanner();
}
function renderBanner() {
  const inv = inbox.current;
  if (!inv) return;
  if (!inbox.banner) {
    const b = el('div', 'mp-banner hidden');
    b.setAttribute('role', 'alert');
    inbox.bText = el('span', 'mp-banner-text');
    const play = el('button', 'retro-key c-lime px-3 py-1.5 rounded-lg text-xs', 'PLAY'); play.type = 'button';
    const no = el('button', 'retro-key c-white px-3 py-1.5 rounded-lg text-xs', 'NOT INTERESTED'); no.type = 'button';
    play.addEventListener('click', () => { const i = inbox.current; hideBanner(); if (i) acceptInvite(i); });
    no.addEventListener('click', () => {
      const i = inbox.current;
      hideBanner();
      inbox.declines++;
      if (inbox.declines >= 3) { inbox.declines = 0; lsSet(SNOOZE_KEY, String(Date.now() + 30 * 60 * 1000)); toast('NOTIFICATIONS PAUSED FOR 30 MINUTES'); stopInbox(); }
      if (i) { const bl = blocked(); bl.push(i.uid); lsSet(blockKey, JSON.stringify(bl.slice(-30))); }
    });
    b.appendChild(inbox.bText); b.appendChild(play); b.appendChild(no);
    document.body.appendChild(b);
    inbox.banner = b;
  }
  inbox.bText.textContent = '#' + inv.name + ' WANTS TO PLAY GLOBALLY';
  clearInterval(inbox.timer);
  inbox.timer = setInterval(() => {
    const cur = inbox.current;
    if (!cur) { clearInterval(inbox.timer); return; }
    if (nowSrv() - cur.ts > MP.INVITE_TTL_MS) { hideBanner(); return; }
    // only while idle: never over a live run, a match or another popup
    const idle = bridge.canStart() && !Z.match && !Z.search && !document.querySelector('.auth-modal:not(.hidden)');
    inbox.banner.classList.toggle('hidden', !idle);
  }, 500);
}
function hideBanner() { inbox.current = null; clearInterval(inbox.timer); if (inbox.banner) inbox.banner.classList.add('hidden'); }

async function acceptInvite(inv) {
  const id = identity();
  if (!id || !bridge.canStart()) return;
  bridge.initAudio();
  await syncProfileAndClock();
  showConnecting('JOINING #' + inv.name + '...');
  await iceReady();
  const M = await claimSlot(id, inv.slot, inv.uid, null);
  if (!M) { showError('TOO LATE. THEY ALREADY FOUND A MATCH.'); return; }
  showConnecting('CONNECTING TO #' + inv.name + '...');
}

/* ---------------------------------------------------------------------------
 * 9. MATCH: connect -> hello -> clock sync -> start -> VS -> countdown -> run -> result -> rematch
 * ------------------------------------------------------------------------ */
function resetRound(M) {
  if (M.orb) { M.orb.dispose(); M.orb = null; }
  M.rivalDeadMsg = false; M.pendSince = 0;
  M.pendingClaims = [];      // host: guest claims that arrived before this side's OrbReferee exists (flushed in beginEngine)
  M.rival = { interp: new Interp(), score: 0, dead: false, deadScore: 0, deadAt: 0, fin: null, lastSeen: 0, seen: false, gone: false, shields: 2, dash: false, scoreAt: 0, name: (M.opp && M.opp.name) || '?' };
  M.me = { dead: false, deadScore: 0, deadAt: 0, scoreAt: 0, lastScore: 0, fin: null, finAt: 0, timeUp: false };
  M.rec = { pos: [], scores: [] };
  M.seq = 0; M.gseq = 0; M.hudN = 0; M.lastCount = 99; M.goPlayed = false; M.result = null; M.delta = 0; M.lastPos = null;
}
function newMatch(kind, role, expectUid) {
  const M = {
    id: ++Z.matchSeq, kind, role, expectUid, peer: null, phase: 'connect', opp: { name: '?', uid: '', photo: '', rating: 0, band: 0 },
    ghost: null, series: { me: 0, opp: 0 }, rematch: { me: false, opp: false }, skew: 0, offset: 0, route: '',
    gotHello: false, timers: [], tickId: 0, helloTimer: 0, peerClosed: false, seed: 0, startPerf: 0,
    pendingSeed: 0, startAcked: false,
    rtt: 0, rttId: 0, rttPing: null, rttN: 0, seq2: 0     // HOST only: round trip in ms, kept fresh during the match (guest never reads it)
  };
  resetRound(M);
  Z.match = M;
  return M;
}
function makePeer(M, policy) {
  M.peer = new Peer({
    iceServers: ICE, policy,
    onCtl: (m) => onCtl(M, m), onPos: (s) => onPos(M, s), onOpen: () => onOpen(M), onClose: (w) => onClose(M, w)
  });
  return M.peer;
}
function dropMatch(M) {
  if (!M) return;
  M.timers.forEach(clearTimeout); M.timers = [];
  clearInterval(M.tickId); clearInterval(M.rttId); clearTimeout(M.helloTimer);
  if (M.orb) { M.orb.dispose(); M.orb = null; }
  if (M.peer) { try { M.peer.close(); } catch (e) { /* ignore */ } }
  if (Z.match === M) Z.match = null;
}
function failMatch(M, msg) {
  if (!M || Z.match !== M) return;
  dropMatch(M);
  if (M.kind === 'global' && Z.autoRetry < 2 && !Z.search) {
    Z.autoRetry++;
    toast('OPPONENT DROPPED. SEARCHING AGAIN...');
    startGlobal(true);
    return;
  }
  showError(msg || 'COULD NOT CONNECT');
}
function abortAll() {
  cancelHost(); cancelSearch();
  if (Z.match) { const M = Z.match; if (M.peer) M.peer.send({ k: 'bye' }); dropMatch(M); }
  hideModal(); hideVS(true); hideResult(); hideHud();
  if (bridge.isActive()) bridge.leave();
  syncInbox();
}
Z.autoRetry = 0;

function onOpen(M) {
  if (Z.match !== M) return;
  M.phase = 'hello';
  showConnecting('CONNECTED. GETTING READY...');
  M.peer.route().then((r) => { M.route = r; log('route', r); });
  const id = identity();
  if (!id) { failMatch(M, 'LOGIN AGAIN'); return; }
  warmPhoto(id.photo);
  M.peer.send({ k: 'hello', v: MP.VERSION, uid: id.uid, name: id.name, band: myBand(), rating: stats.rating });
  M.helloTimer = setTimeout(() => { if (Z.match === M && !M.gotHello) failMatch(M, 'OPPONENT DID NOT RESPOND'); }, 8000);
}
function onClose(M, why) {
  if (Z.match !== M) return;
  log('peer closed', why);
  if (M.phase === 'connect' || M.phase === 'hello') { failMatch(M, why === 'timeout' ? 'COULD NOT CONNECT. TRY AGAIN.' : 'CONNECTION LOST'); return; }
  M.peerClosed = true;
  if (M.phase === 'run') markGone(M);
  if (M.phase === 'result') updateResultUI(M);
  if (M.phase === 'vs') { toast('OPPONENT LEFT'); leaveMatch(M, true); }
}
function onCtl(M, m) {
  if (Z.match !== M) return;
  switch (m.k) {
    case 'hello': {
      const uid = String(m.uid || '').slice(0, 128);
      const mine = identity();
      if (!uid || (mine && uid === mine.uid)) return;
      if (M.expectUid && uid !== M.expectUid) { failMatch(M, 'WRONG OPPONENT'); return; }
      if (Math.round(num(m.v, 0, 99, 0)) !== MP.VERSION) { failMatch(M, 'ONE OF YOU HAS AN OLD VERSION. REFRESH THE GAME.'); return; }
      M.opp = { uid, name: cleanName(m.name), band: Math.round(num(m.band, 0, 5, 0)), rating: Math.round(num(m.rating, 0, 4000, 1000)), photo: '' };
      M.rival.name = M.opp.name;
      M.gotHello = true;
      clearTimeout(M.helloTimer);
      M.oppInfo = fetchOpponent(uid).then((o) => { if (Z.match === M) { M.opp.photo = o.photo; if (o.rating) M.opp.rating = o.rating; warmPhoto(o.photo); } });
      if (M.role === 'guest') runSync(M);
      break;
    }
    case 'ping': M.peer.send({ k: 'pong', id: m.id, th: performance.now() }); break;
    case 'pong':
      if (M.pongs && M.pongs.has(m.id)) { M.pongs.get(m.id)(num(m.th, -1e12, 1e12, null)); }
      else if (M.role === 'host' && M.rttPing && m.id === M.rttPing.id) {      // in-match RTT sample (see startRttKeepalive)
        const s = performance.now() - M.rttPing.t0;
        M.rttPing = null;
        if (s >= 0 && s <= 5000) { M.rtt = M.rttN++ ? M.rtt * 0.6 + s * 0.4 : Math.max(M.rtt, s); }
      }
      break;
    case 'sync':
      if (M.role !== 'host' || !M.gotHello) return;
      M.skew = num(m.offset, -1e10, 1e10, 0);        // guest clock + offset = host clock
      M.rtt = num(m.rtt, 0, 5000, 200);              // round trip in ms: the host waits about half of it (+ a margin) for an earlier orb claim
      hostStart(M);
      break;
    case 'start': {
      if (M.role !== 'guest' || !M.synced) return;
      const seed = (Number(m.seed) >>> 0);
      let startPerf = Number(m.t0) - M.offset;       // host clock -> my clock
      const now = performance.now();
      if (!Number.isFinite(startPerf) || startPerf - now > 20000) startPerf = now + 7900;
      // Floor = the full VS intro + the 3-2-1 countdown. A shorter lead makes beginRound() cut the VS screen
      // short (beginEngine/hideVS fire at lead-3500 / lead-3000). The clamp is safe: startAck tells the host.
      const minLead = (MP.VS_SEC + MP.COUNTDOWN_SEC) * 1000;
      if (startPerf - now < minLead) startPerf = now + minLead;
      // Tell the host exactly which startPerf I'm using (translated back into ITS clock), even when
      // the clamp above fired, so both devices run the shared drone field from the same time origin.
      M.peer.send({ k: 'startAck', t: startPerf + M.offset });
      const sr = m.sr || {};
      M.series = { me: Math.round(num(sr.opp, 0, 999, 0)), opp: Math.round(num(sr.me, 0, 999, 0)) };
      M.mid = String(m.mid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      beginRound(M, seed, startPerf);
      break;
    }
    case 'startAck': {
      if (M.role !== 'host' || M.startAcked) return;
      const t = Number(m.t);
      const now = performance.now();
      if (!Number.isFinite(t) || Math.abs(t - now) > 30000) return;   // bogus value: let the fallback timer start us instead
      M.startAcked = true;
      beginRound(M, M.pendingSeed >>> 0, t);
      break;
    }
    case 'claim':                                  // guest touched the orb (host settles it)
      if (M.role !== 'host') break;
      if (M.orb) M.orb.guestClaim(m);
      else if (M.phase === 'vs' && M.pendingClaims.length < 32) M.pendingClaims.push(m);   // guest engine started first: keep it, don't drop it
      break;
    case 'orb': if (M.orb && M.role === 'guest') M.orb.hostVerdict(m); break;     // host: who got orb n, and when
    case 'dead':
      M.rivalDeadMsg = true;                         // ctl is ordered: every claim the rival made before dying has already arrived
      if (M.orb) M.orb.pump();
      M.rival.dead = true; M.rival.deadScore = num(m.score, 0, 1e7, M.rival.score); M.rival.score = M.rival.deadScore; M.rival.deadAt = num(m.at, 0, 100, 0);
      evaluate(M);
      break;
    case 'fin':
      M.rival.fin = { score: num(m.score, 0, 1e7, 0), at: num(m.at, 0, 100, 0), wave: num(m.wave, 0, 999, 0), ko: !!m.ko };
      evaluate(M);
      break;
    case 'rematch': M.rematch.opp = true; updateResultUI(M); tryRematch(M); break;
    case 'bye': onClose(M, 'bye'); break;
    default: break;
  }
}
function onPos(M, s) {
  if (Z.match !== M) return;
  const d = decodeSnap(s);
  if (!d) return;
  const R = M.rival;
  if (!R.interp.push({ seq: d.seq, t: d.t + M.skew, x: d.x, y: d.y, dash: d.dash })) return;
  R.lastSeen = performance.now(); R.seen = true;
  if (d.score !== R.score) { R.score = d.score; R.scoreAt = Math.max(0, (performance.now() - M.startPerf) / 1000); }
  R.shields = d.shields; R.dash = d.dash; R.gd = !!d.gd;
  if (d.dead && !R.dead) { R.dead = true; R.deadScore = d.score; R.deadAt = R.scoreAt; }   // backup for a late 'dead' message
}

async function runSync(M) {
  const cs = new ClockSync();
  M.pongs = new Map();
  for (let i = 0; i < 8; i++) {
    if (Z.match !== M) return;
    const t0 = performance.now();
    const p = new Promise((res) => M.pongs.set(i, res));
    M.peer.send({ k: 'ping', id: i });
    const th = await Promise.race([p, sleep(900).then(() => null)]);
    if (th != null) cs.add(t0, th, performance.now());
    await sleep(40);
  }
  if (Z.match !== M) return;
  if (!cs.best) { failMatch(M, 'COULD NOT SYNC CLOCKS'); return; }
  M.offset = cs.offset;           // host clock - my clock
  M.skew = -cs.offset;            // host timestamps -> my clock
  M.synced = true;
  M.peer.send({ k: 'sync', offset: cs.offset, rtt: cs.rtt });
}
function hostStart(M) {
  const seed = (cryptoRand() * 4294967296) >>> 0;
  const t0 = performance.now() + (MP.VS_SEC + 0.3 + MP.COUNTDOWN_SEC) * 1000;
  // one match id per round: both players report the result under it, the score Worker checks the two reports agree
  M.mid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  M.pendingSeed = seed;
  M.startAcked = false;
  M.peer.send({ k: 'start', seed, t0, sr: M.series, mid: M.mid });
  // The guest may have had to clamp its own startPerf if clock sync came out noisy; it echoes back
  // whichever value it actually used (translated into MY clock) so we never run the same seeded
  // world from two different time origins. Fall back to our own t0 if the ack never arrives.
  M.timers.push(setTimeout(() => {
    if (Z.match !== M || M.startAcked) return;
    M.startAcked = true;
    beginRound(M, seed, t0);
  }, 1500));
}
function startGhostMatch(g) {
  const M = newMatch('ghost', 'host', null);
  M.ghost = g;
  M.opp = { uid: 'ghost', name: g.name, band: myBand(), rating: g.bot ? 900 + myBand() * 100 : stats.rating, photo: '' };
  M.rival.name = g.name;
  beginRound(M, g.seed, performance.now() + (MP.VS_SEC + 0.3 + MP.COUNTDOWN_SEC) * 1000);
}

function beginRound(M, seed, startPerf) {
  if (Z.match !== M) return;
  M.timers.forEach(clearTimeout); M.timers = [];
  clearInterval(M.tickId); clearInterval(M.rttId);
  const keepName = M.rival.name;
  resetRound(M);
  M.rival.name = keepName;
  M.seed = seed >>> 0; M.startPerf = startPerf; M.phase = 'vs';
  bridge.initAudio();
  hideModal(); hideResult();
  showVS(M);
  const lead = startPerf - performance.now();
  M.timers.push(setTimeout(() => beginEngine(M), Math.max(0, lead - 3500)));
  M.timers.push(setTimeout(() => hideVS(), Math.max(0, lead - 3000)));
}
function beginEngine(M) {
  if (Z.match !== M || M.phase !== 'vs') return;
  if (M.orb) M.orb.dispose();
  M.orb = new OrbReferee({
    role: M.role === 'host' ? 'host' : 'guest', seed: M.seed,
    send: (m) => { if (M.peer) M.peer.send(m); },
    onVerdict: (n, mine, t) => onOrbVerdict(M, n, mine, t),
    clock: () => (performance.now() - M.startPerf) / 1000,
    rtt: M.role === 'host' ? () => M.rtt || 200 : undefined,   // only the host's pump() reads it; the guest never measures an RTT
    solo: () => !!M.ghost || !M.peer || M.peerClosed || M.rival.gone,   // nobody to wait for: ghost / practice race or the rival left
    rivalDead: () => !!M.rivalDeadMsg
  });
  bridge.begin({
    seed: M.seed, startPerf: M.startPerf, selfColor: '#38BDF8',
    draw: (c, w, h, st) => drawMP(M, c, w, h, st),
    onEnd: (ev) => onEngineEnd(M, ev),
    onClaim: (cl) => { if (Z.match === M && M.orb) M.orb.localClaim(cl.n, cl.c); },
    host: M.role === 'host'      // the host's orb is hunted by the even-numbered drones, the guest's by the odd ones
  });
  M.phase = 'run';
  if (M.pendingClaims.length) {                    // host: claims that beat our engine start (guestClaim validates every field)
    const q = M.pendingClaims; M.pendingClaims = [];
    q.forEach((m) => M.orb.guestClaim(m));
  }
  showHud(M);
  M.tickId = setInterval(() => tick(M), 1000 / MP.SNAP_HZ);
  startRttKeepalive(M);
}
// HOST: re-measure the round trip during the match so the orb tie-break wait (orbWaitMs) follows the real link.
// Reuses the existing ping/pong messages (the guest already answers 'ping'). skew is NOT touched: clocks do not drift
// in 90 s and changing it mid-match would make the rival jump on screen.
const RTT_REFRESH_MS = 15000;
function startRttKeepalive(M) {
  clearInterval(M.rttId);
  if (M.role !== 'host' || M.ghost || !M.peer) return;
  M.rttId = setInterval(() => {
    if (Z.match !== M || M.phase !== 'run' || !M.peer || M.peerClosed) { clearInterval(M.rttId); return; }
    const id = 'r' + (++M.seq2);
    M.rttPing = { id, t0: performance.now() };
    M.peer.send({ k: 'ping', id });
  }, RTT_REFRESH_MS);
}

function tick(M) {
  if (Z.match !== M || (M.phase !== 'run' && M.phase !== 'result')) return;
  const st = bridge.getState();
  const clock = st.clockT;
  const dead = M.me.dead;
  if (!dead) M.lastPos = [st.x, st.y];
  const pos = M.lastPos || [MP.ARENA_W / 2, MP.ARENA_H / 2];
  const score = dead ? M.me.deadScore : st.score;
  if (!dead && st.score !== M.me.lastScore) { M.me.lastScore = st.score; M.me.scoreAt = Math.max(0, clock); }
  if (clock >= 0 && !M.me.fin) {
    for (let gi = Math.floor(clock * MP.GHOST_HZ); M.rec.pos.length <= gi && M.rec.pos.length <= MP.MATCH_SEC * MP.GHOST_HZ;) M.rec.pos.push(pos);
    for (let si = Math.floor(clock); M.rec.scores.length <= si && M.rec.scores.length <= MP.MATCH_SEC;) M.rec.scores.push(score);
  }
  if (M.peer) M.peer.sendPos(encodeSnap({ seq: ++M.seq, t: performance.now(), x: pos[0], y: pos[1], score, dead, dash: st.dash, shields: dead ? 0 : st.shields, surge: st.surge, gd: !dead && !!st.gd, wave: st.wave }));
  if (M.ghost && clock >= 0) feedGhost(M, clock);
  if ((++M.hudN) % 3 === 0) updateHud(M, clock);
  evaluate(M);
}
function feedGhost(M, clock) {
  const R = M.rival;
  const g = ghostAt(M.ghost, Math.min(MP.MATCH_SEC, clock));
  R.interp.push({ seq: ++M.gseq, t: performance.now(), x: g.x, y: g.y });
  R.seen = true; R.lastSeen = performance.now();
  if (g.score !== R.score) { R.score = g.score; R.scoreAt = clock; }
  if (g.dead && !R.dead) { R.dead = true; R.deadScore = g.score; R.deadAt = M.ghost.deadAt; }
}

/* contested orb: the host's decision for orb n reached this side (the host's own referee calls this too) */
function onOrbVerdict(M, n, mine, t) {
  if (Z.match !== M) return;
  bridge.orbVerdict(n, mine, t);
  if (M.me.dead && M.peer) {   // a verdict can change my score after I died: tell the rival the corrected score
    const st = bridge.getState();
    if (st.score !== M.me.deadScore) { M.me.deadScore = st.score; M.peer.send({ k: 'dead', score: st.score, at: M.me.deadAt, wave: st.wave }); }
  }
  evaluate(M);
}
/* the result must not be taken from a score that still has an unconfirmed orb claim in it (it could be taken back a moment later) */
function holdForClaims(M) {
  const p = bridge.orbPending();
  if (!p) { M.pendSince = 0; return false; }
  if (M.ghost || !M.peer || M.peerClosed || M.rival.gone) { bridge.orbCommit(); M.pendSince = 0; return false; }
  const now = performance.now();
  if (!M.pendSince) M.pendSince = now;
  if (now - M.pendSince > MP.ORB_HOLD_MS) { bridge.orbCommit(); M.pendSince = 0; return false; }   // the verdict never came: the claim stands
  return true;
}
function onEngineEnd(M, ev) {
  if (Z.match !== M) return;
  if (ev.type === 'dead') {
    M.me.dead = true; M.me.deadScore = ev.score; M.me.deadAt = ev.at;
    if (M.peer) M.peer.send({ k: 'dead', score: ev.score, at: ev.at, wave: ev.wave });
    showSpec(M);
  } else M.me.timeUp = true;
  evaluate(M);
}
function markGone(M) {
  const R = M.rival;
  if (R.gone) return;
  R.gone = true;
  if (M.orb) M.orb.pump();                                  // host: settle what is waiting, nobody else can claim now
  if (bridge.orbPending() > 0) bridge.orbCommit();           // guest: no verdict will ever come, the claims stand
  if (!R.dead) { R.dead = true; R.deadScore = R.score; R.deadAt = Math.max(0, (performance.now() - M.startPerf) / 1000); }
}
// true  = the match ends the moment either player dies; the scores at that moment decide it.
// false = old rule: the survivor keeps playing until it passes the dead player's score or the clock runs out.
const END_ON_DEATH = true;
function evaluate(M) {
  if (Z.match !== M || M.phase !== 'run') return;
  const R = M.rival;
  const st = bridge.getState();
  const now = performance.now();
  if (M.peer && R.seen && !R.gone && now - R.lastSeen > MP.GONE_MS) markGone(M);
  if (!M.me.fin) {
    const mine = M.me.dead ? M.me.deadScore : st.score;
    let why = '';
    if (R.fin && R.fin.ko) why = 'rival-ko';
    else if (R.dead && M.me.dead) why = 'both';
    else if (R.dead && !M.me.dead && mine > R.deadScore) why = 'ko';
    else if (END_ON_DEATH && (M.me.dead || (R.dead && !R.gone))) why = 'death';   // a rival that merely disconnected (gone) does not end it: the old rule still applies
    else if (M.me.timeUp) why = 'time';
    else if (M.me.dead && (st.clockT >= MP.MATCH_SEC || R.fin)) why = 'time';
    if (why && !holdForClaims(M)) finishMe(M, why);
  }
  if (M.me.fin && !M.result && (R.fin || M.ghost || R.gone || now - M.me.finAt > MP.FIN_WAIT_MS)) computeResult(M);
}
function finishMe(M, reason) {
  if (M.me.fin) return;
  const st = bridge.getState();
  const score = M.me.dead ? M.me.deadScore : st.score;
  M.me.fin = { score, at: M.me.scoreAt, wave: st.wave, ko: reason === 'ko' };
  M.me.finAt = performance.now();
  M.me.reason = reason;
  if (M.peer) M.peer.send({ k: 'fin', score, at: M.me.scoreAt, wave: st.wave, ko: reason === 'ko' });
  bridge.finish();
  hideSpec();
  evaluate(M);
}

const H2H_KEY = 'inchase_mp_h2h';
function h2h(uid, outcome) {
  let all = {};
  try { all = JSON.parse(lsGet(H2H_KEY) || '{}') || {}; } catch (e) { all = {}; }
  const r = all[uid] || { w: 0, l: 0, d: 0 };
  if (outcome) { if (outcome === 'win') r.w++; else if (outcome === 'lose') r.l++; else r.d++; all[uid] = r; const keys = Object.keys(all); if (keys.length > 60) delete all[keys[0]]; lsSet(H2H_KEY, JSON.stringify(all)); }
  return r;
}
async function reportMp(M, mine, theirs) {
  if (!SCORE_WORKER_URL) return;
  const mid = M.mid;
  const body = { mid, opp: M.opp.uid, score: mine.score, oppScore: theirs.score, at: mine.at, da: M.me.dead ? M.me.deadAt : -1, kind: M.kind };
  for (let i = 0; i < 12 && Z.match === M && M.mid === mid; i++) {   // the other player's report arrives within a few seconds
    let r = {};
    try {
      const t = await auth.currentUser.getIdToken();
      const res = await fetch(SCORE_WORKER_URL.replace(/\/$/, '') + '/mp/report', { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      r = await res.json().catch(() => ({}));
    } catch (e) { log('rating report failed', e); }
    if (Z.match !== M || M.mid !== mid) return;
    if (r.state === 'settled') {
      if (r.stats) stats = Object.assign({}, DEFAULT_STATS, pickStats(r.stats));
      M.result.rated = !!r.rated; M.result.delta = Number(r.delta) || 0; M.result.streak = stats.streak;
      try { window.dispatchEvent(new CustomEvent('inchase:mprating', { detail: { rating: stats.rating, wins: stats.wins, losses: stats.losses, draws: stats.draws } })); } catch (e) { /* ignore */ }
      if (M.phase === 'result') showResult(M);          // redraw the card with the confirmed rating
      return;
    }
    if (r.state === 'disputed' || r.state === 'unrated') return;   // the reports disagree / not rated: no rating change
    await sleep(1500);
  }
}
function computeResult(M) {
  M.phase = 'result';
  clearInterval(M.tickId);
  bridge.finish();
  const R = M.rival;
  const mine = M.me.fin;
  const theirs = R.fin || { score: R.dead ? R.deadScore : R.score, at: R.scoreAt };
  const w = decideWinner(mine, theirs);
  const outcome = w > 0 ? 'win' : w < 0 ? 'lose' : 'draw';
  if (outcome === 'win') M.series.me++; else if (outcome === 'lose') M.series.opp++;
  const ko = mine.ko ? 'me' : (R.fin && R.fin.ko ? 'them' : '');
  M.result = { outcome, mine, theirs, ko, left: R.gone && !R.fin, rated: false, delta: 0 };
  // RATING IS DECIDED BY THE SCORE SERVER. Real GLOBAL matches only (friend duels and ghost / practice races are unrated).
  // Both players report the match under the same id; the Worker rates it only when the two reports agree, and does the Elo.
  if (M.kind === 'global' && identity()) {
    if (M.mid && M.opp.uid) reportMp(M, mine, theirs);
    if (mine.score > 0 && cryptoRand() < 0.4) uploadGhost(M, identity());
  }
  if (M.kind === 'friend' && M.opp.uid) M.result.h2h = h2h(M.opp.uid, outcome);
  if (outcome === 'win') (ko === 'me' ? sfx.ko : sfx.win)(); else if (outcome === 'lose') sfx.lose(); else sfx.pop();
  buzz(outcome, ko);
  hideHud();
  showResult(M);
  tryRematch(M);
}
// Haptics: navigator.vibrate exists on Android Chrome / Firefox (iPhones and desktops have no such API, so nothing happens there)
function buzz(outcome, ko) {
  try {
    if (!navigator.vibrate || document.hidden) return;
    navigator.vibrate(outcome === 'win' ? (ko === 'me' ? [70, 40, 70, 40, 240] : [60, 50, 60, 50, 170]) : outcome === 'lose' ? [320] : [90, 70, 90]);
  } catch (e) { /* ignore */ }
}
const pick = (s) => ({ rating: s.rating, wins: s.wins, losses: s.losses, draws: s.draws, streak: s.streak, bestStreak: s.bestStreak, games: s.games, bestScore: s.bestScore });
function uploadGhost(M, id) {
  try {
    const band = myBand();
    const enc = encodeGhost(M.rec.pos, M.rec.scores);
    if (enc.pos.length > 4100 || enc.sc.length > 600) return;
    const n = Math.floor(cryptoRand() * MP.GHOST_SLOTS);
    setDoc(doc(db, 'mp_ghosts', 'b' + band + '_' + n), {
      band, seed: M.seed, score: M.me.fin.score, deadAt: M.me.dead ? Math.max(1, Math.round(M.me.deadAt)) : 0,
      name: id.name, pos: enc.pos, sc: enc.sc, ts: serverTimestamp(), expireAt: expireIn(14 * 86400e3)
    }).catch((e) => log('ghost save refused', e));
  } catch (e) { log('ghost encode failed', e); }
}

/* rematch */
async function requestRematch(M) {
  if (Z.match !== M || M.rematch.me) return;
  if (M.ghost) { hideResult(); const band = myBand(); dropMatch(M); startGhostMatch(await loadGhost(band)); return; }
  if (M.peerClosed) return;
  M.rematch.me = true;
  M.peer.send({ k: 'rematch' });
  updateResultUI(M); updateSpecBtn(M);
  tryRematch(M);
}
function tryRematch(M) {
  if (Z.match !== M || M.phase !== 'result' || M.role !== 'host') return;
  if (M.rematch.me && M.rematch.opp && !M.peerClosed) { M.rematch.me = M.rematch.opp = false; hostStart(M); }
}
function leaveMatch(M, silent) {
  if (M && M.peer && !silent) M.peer.send({ k: 'bye' });
  dropMatch(M);
  hideVS(true); hideResult(); hideHud(); hideSpec();
  bridge.leave();
  syncInbox();
}

/* ---------------------------------------------------------------------------
 * 10. In-arena drawing: rival orb, countdown, final surge frame
 * ------------------------------------------------------------------------ */
/* rival tail: a tapered ribbon + stretched afterimages while dashing, built from the positions the rival is DRAWN at,
   so it lines up with the orb on every screen (the same look as your own tail) */
const TAIL_COL = '#A78BFA', TAIL_HOT = '#EDE9FE', TAIL_GOLD = '#F59E0B';
function trailStep(R, p, dashing, now) {
  const T = R.trail || (R.trail = []);
  const A = R.after || (R.after = []);
  if (!p || R.dead) { T.length = 0; A.length = 0; return; }
  const last = T.length ? T[T.length - 1] : null;
  if (!last || Math.abs(p.x - last.x) + Math.abs(p.y - last.y) > 0.25) {
    if (last) { const dx = p.x - last.x, dy = p.y - last.y; if (dx * dx + dy * dy > 0.5) R.ang = Math.atan2(dy, dx); }
    T.push({ x: p.x, y: p.y, t: now, d: dashing });
    if (T.length > 72) T.shift();
  }
  while (T.length > 1 && now - T[0].t > 360) T.shift();
  if (dashing && now - (R.afterT || 0) > 36) { R.afterT = now; A.push({ x: p.x, y: p.y, a: R.ang || 0, t: now }); }
  while (A.length && now - A[0].t > 280) A.shift();
}
function drawTail(ctx, R, dashing, now) {
  const T = R.trail, A = R.after;
  if (!T || !A) return;
  const col = R.gd ? TAIL_GOLD : TAIL_COL;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.fillStyle = col;
  for (let i = 0; i < A.length; i++) {            // afterimages: stretched ghosts of the core along the dash
    const t = 1 - (now - A[i].t) / 280;
    if (t <= 0) continue;
    ctx.save();
    ctx.translate(A[i].x, A[i].y); ctx.rotate(A[i].a); ctx.globalAlpha = t * 0.45;
    ctx.beginPath(); ctx.ellipse(0, 0, 11 * (1 + 1.5 * t), 11 * (0.5 + 0.45 * t), 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  if (dashing) { ctx.shadowColor = col; ctx.shadowBlur = 14; }
  const n = T.length;
  for (let k = n - 1; k > 0; k--) {               // ribbon, newest to oldest ("hot" = drawn while dashing)
    const a = T[k], b = T[k - 1];
    const hot = a.d;
    const t = 1 - (now - a.t) / (hot ? 360 : 230);
    if (t <= 0) continue;
    if (a.t - b.t > 160) continue;                // a gap in the data (lost packets, standing still): never streak across it
    ctx.globalAlpha = t * (hot ? 0.85 : 0.4);
    ctx.strokeStyle = hot && n - 1 - k < 6 ? TAIL_HOT : col;
    ctx.lineWidth = Math.max(1, 22 * t * (hot ? 1 : 0.6));
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(a.x, a.y); ctx.stroke();
  }
  ctx.restore();
}

/* 3-2-1-GO: the arena is blurred while it counts down; the digits are real page text on top, so they stay sharp */
let cdEl = null, cdText = '', blurOn = false;
function setBlur(on) {
  if (on === blurOn) return;
  blurOn = on;
  const c = $('gameCanvas');
  if (c) c.classList.toggle('mp-blur', on);
}
function showCount(M, text, go) {
  if (cdEl && cdText === text) return;
  if (cdEl) cdEl.remove();
  cdText = text;
  cdEl = el('div', 'mp-count' + (go ? ' go' : ''));
  cdEl.appendChild(el('b', '', text));
  if (!go) {
    const h = el('div', 'mp-count-hint');
    h.appendChild(el('span', 'me', 'YOU ARE CYAN'));
    h.appendChild(document.createTextNode('  \u00B7  '));
    h.appendChild(el('span', 'opp', ((M.opp && M.opp.name) || 'RIVAL').slice(0, 14).toUpperCase() + ' IS VIOLET'));
    cdEl.appendChild(h);
  }
  frame().appendChild(cdEl);
}
function hideCount() {
  if (cdEl) { cdEl.remove(); cdEl = null; }
  cdText = '';
  setBlur(false);
}

function drawMP(M, ctx, W, H, state) {
  if (Z.match !== M) return;
  const clock = (performance.now() - M.startPerf) / 1000;
  const R = M.rival;
  let dashNow = false;
  // rival orb: always a round orb with a white rim and a name tag (hazards are sharp shapes, so they can not be confused)
  let p;
  if (M.ghost) {
    // ghost: driven by the shared match clock every frame (no network buffer), so it moves in lock-step with the player
    const g = ghostAt(M.ghost, Math.max(0, Math.min(MP.MATCH_SEC, clock)));
    p = { x: g.x, y: g.y };
    const g0 = ghostAt(M.ghost, Math.max(0, Math.min(MP.MATCH_SEC, clock - 0.12)));      // a ghost has no dash flag: a burst of speed is a dash
    dashNow = clock >= 0.12 && Math.hypot(g.x - g0.x, g.y - g0.y) / 0.12 > 520;
    if (clock >= 0) {
      R.seen = true; R.lastSeen = performance.now();
      if (g.score !== R.score) { R.score = g.score; R.scoreAt = clock; }
      if (g.dead && !R.dead) { R.dead = true; R.deadScore = g.score; R.deadAt = M.ghost.deadAt; }
    }
  } else {
    p = R.interp.at(performance.now() - MP.INTERP_MS);
    dashNow = !!(p && p.s && p.s.dash);        // the flag of the sample being drawn (the orb is ~110 ms behind the newest packet)
  }
  if (R.dead) dashNow = false;
  bridge.setRival(p ? p.x : 0, p ? p.y : 0, !!(p && !M.ghost && !R.dead && !R.gone && clock >= 0));   // the engine makes the rival solid and hunts it
  const nowMs = performance.now();
  trailStep(R, p, dashNow, nowMs);
  if (p && !R.dead) drawTail(ctx, R, dashNow, nowMs);
  if (p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    if (R.dead) {
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = '#C4B5FD'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-9, -9); ctx.lineTo(9, 9); ctx.moveTo(9, -9); ctx.lineTo(-9, 9); ctx.stroke();
    } else {
      ctx.shadowColor = R.gd ? '#F59E0B' : '#A78BFA'; ctx.shadowBlur = R.gd ? 24 : 16;   // Ghost Drive: gold glow (same gold as your own Ghost Drive)
      for (let i = 1; i <= R.shields; i++) {
        ctx.strokeStyle = i === 2 ? 'rgba(167,139,250,0.75)' : 'rgba(196,181,253,0.9)';
        ctx.lineWidth = 2; ctx.setLineDash(i === 2 ? [6, 4] : []);
        ctx.beginPath(); ctx.arc(0, 0, 11 + 3 * i, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.setLineDash([]);
      if (R.gd) {   // rival is in Ghost Drive: dashed gold ring just outside the orb/shields, like yours, but pulsing so it reads from afar
        const pulse = 0.65 + 0.35 * Math.sin(performance.now() / 110);
        ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 2.5; ctx.globalAlpha = pulse; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.arc(0, 0, 11 + 3 * R.shields + 6, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.save();
      if (dashNow) { ctx.rotate(R.ang || 0); ctx.scale(1.7, 0.75); ctx.shadowBlur = 18; }
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = R.gd ? '#C4B5FD' : '#A78BFA';
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#EDE9FE';
      ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    ctx.save();
    ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.fillStyle = R.gd ? '#FCD34D' : '#DDD6FE';
    const label = (M.ghost ? 'GHOST ' : '') + (R.name || '').slice(0, 14);
    const ty = Math.max(14, p.y - 24);
    ctx.strokeText(label, p.x, ty); ctx.fillText(label, p.x, ty);
    ctx.restore();
  }
  if (state !== 'playing' && state !== 'gameover') return;
  // Final Surge frame
  if (clock >= MP.SURGE_AT && clock < MP.MATCH_SEC && !M.me.fin) {
    const a = 0.35 + 0.25 * Math.sin(performance.now() / 140);
    ctx.save();
    ctx.strokeStyle = 'rgba(251,191,36,' + a.toFixed(2) + ')'; ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    if (clock < MP.SURGE_AT + 2) {
      ctx.textAlign = 'center'; ctx.font = 'bold 30px sans-serif'; ctx.lineWidth = 6; ctx.strokeStyle = '#0A0A0A'; ctx.fillStyle = '#FBBF24';
      ctx.strokeText('FINAL SURGE  x2', W / 2, H * 0.22); ctx.fillText('FINAL SURGE  x2', W / 2, H * 0.22);
    }
    ctx.restore();
  }
  // 3-2-1-GO: blur the arena (grid, drones, orbs) while it counts down, then sharpen it on GO
  setBlur(clock < 0);
  if (clock < 0.8) {
    if (clock < 0) {
      const n = Math.ceil(-clock);
      if (n <= MP.COUNTDOWN_SEC) {             // (the half second before "3" is still behind the VS screen: no digit, no beep)
        if (n !== M.lastCount) { M.lastCount = n; sfx.beep(); }
        showCount(M, String(n), false);
      }
    } else {
      if (!M.goPlayed) { M.goPlayed = true; sfx.go(); }
      showCount(M, 'GO!', true);
    }
  } else hideCount();
}

/* ---------------------------------------------------------------------------
 * 11. HUD (live scores), spectate bar, result card, VS intro
 * ------------------------------------------------------------------------ */
const frame = () => $('monitorFrame');
let hud = null, spec = null, resultEl = null, vsEl = null;
const fmt = (n) => Math.max(0, Math.round(n)).toLocaleString();

function showHud(M) {
  hideHud();
  hud = el('div', 'mp-hud');
  hud.innerHTML = '';
  const l = el('div', 'mp-hud-side'); l.appendChild(el('span', 'mp-hud-lbl', 'YOU')); hud.meScore = el('b', '', '0'); l.appendChild(hud.meScore);
  const m = el('div', 'mp-hud-mid');
  hud.time = el('span', 'mp-hud-time', '90');
  const bar = el('div', 'mp-bar'); hud.barMe = el('i', 'me'); hud.barOpp = el('i', 'opp'); bar.appendChild(hud.barMe); bar.appendChild(hud.barOpp);
  m.appendChild(hud.time); m.appendChild(bar);
  const r = el('div', 'mp-hud-side opp'); hud.oppName = el('span', 'mp-hud-lbl', (M.opp.name || '').slice(0, 12).toUpperCase()); hud.oppScore = el('b', '', '0'); r.appendChild(hud.oppName); r.appendChild(hud.oppScore);
  hud.appendChild(l); hud.appendChild(m); hud.appendChild(r);
  frame().appendChild(hud);
}
function hideHud() { if (hud) { hud.remove(); hud = null; } hideSpec(); hideCount(); }
function updateHud(M, clock) {
  if (!hud) return;
  const st = bridge.getState();
  const me = M.me.dead ? M.me.deadScore : st.score;
  const op = M.rival.dead ? M.rival.deadScore : M.rival.score;
  hud.meScore.textContent = fmt(me);
  hud.oppScore.textContent = fmt(op);
  hud.time.textContent = String(Math.max(0, Math.min(MP.MATCH_SEC, Math.ceil(MP.MATCH_SEC - clock))));
  hud.classList.toggle('surge', clock >= MP.SURGE_AT);
  const tot = me + op;
  const ratio = tot > 0 ? me / tot : 0.5;
  hud.barMe.style.flexGrow = String(Math.max(0.04, ratio));
  hud.barOpp.style.flexGrow = String(Math.max(0.04, 1 - ratio));
  hud.classList.toggle('lead', me > op);
  if (spec && M.me.dead) {
    spec.text.textContent = M.rival.dead
      ? 'YOU ARE OUT'
      : 'YOU ARE OUT. ' + (M.opp.name || 'RIVAL').toUpperCase() + ' NEEDS ' + fmt(Math.max(1, M.me.deadScore - M.rival.score + 1)) + ' TO WIN';
  }
}
function showSpec(M) {
  hideSpec();
  spec = el('div', 'mp-spec');
  spec.text = el('span', '', 'YOU ARE OUT');
  spec.btn = el('button', 'retro-key c-lime px-3 py-1.5 rounded-lg text-xs', 'REMATCH'); spec.btn.type = 'button';
  spec.btn.addEventListener('click', () => requestRematch(M));
  spec.appendChild(spec.text);
  if (!M.ghost) spec.appendChild(spec.btn);
  frame().appendChild(spec);
  updateSpecBtn(M);
}
function updateSpecBtn(M) { if (spec && spec.btn) { spec.btn.textContent = M.rematch.me ? 'REMATCH QUEUED' : 'REMATCH'; spec.btn.disabled = M.rematch.me; } }
function hideSpec() { if (spec) { spec.remove(); spec = null; } }

function showResult(M) {
  hideResult(); hideSpec();
  const r = M.result;
  resultEl = el('div', 'mp-result');
  const box = el('div', 'retro-chassis rounded-2xl p-5 text-center mp-result-card');
  const col = r.outcome === 'win' ? 'lime' : r.outcome === 'lose' ? 'pink' : 'orange';
  const head = el('h2', 'text-3xl t-ink', r.ko === 'me' ? 'K.O.!' : r.outcome === 'win' ? 'VICTORY' : r.outcome === 'lose' ? 'DEFEAT' : 'DRAW');
  head.style.textShadow = '3px 3px 0 var(--' + col + ')';
  box.appendChild(head);
  const why = r.ko === 'me' ? 'YOU PASSED THEIR SCORE' : r.ko === 'them' ? 'THEY PASSED YOUR SCORE' : r.left ? 'OPPONENT LEFT' : M.me.reason === 'both' ? 'BOTH OUT' : 'TIME UP';
  box.appendChild(el('div', 'text-[10px] tracking-widest opacity-70 mb-3', why));
  const grid = el('div', 'grid grid-cols-2 gap-3');
  const cell = (label, v, cls) => { const c = el('div', 'mp-cell ' + cls + ' rounded-xl p-2.5'); c.appendChild(el('div', 'text-[10px] tracking-widest', label)); c.appendChild(el('div', 'text-2xl tabular-nums mt-1', fmt(v))); return c; };
  grid.appendChild(cell('YOU', r.mine.score, 'me' + (r.outcome === 'win' ? ' won' : '')));
  grid.appendChild(cell((M.opp.name || 'RIVAL').slice(0, 12).toUpperCase(), r.theirs.score, 'opp' + (r.outcome === 'lose' ? ' won' : '')));
  box.appendChild(grid);
  const pills = el('div', 'mt-3 flex flex-wrap justify-center gap-2');
  if (r.rated) pills.appendChild(el('span', 'nb-pill c-cyan text-xs', 'RATING ' + stats.rating + ' (' + (r.delta >= 0 ? '+' : '') + r.delta + ')'));
  else if (M.kind === 'friend') pills.appendChild(el('span', 'nb-pill c-white text-xs', 'FRIENDLY: UNRATED'));
  else if (M.kind === 'ghost') pills.appendChild(el('span', 'nb-pill c-white text-xs', (M.ghost && M.ghost.bot ? 'PRACTICE' : 'GHOST RUN') + ': UNRATED'));
  if (r.streak > 1) pills.appendChild(el('span', 'nb-pill c-orange text-xs', r.streak + ' WIN STREAK'));
  if (r.h2h) pills.appendChild(el('span', 'nb-pill c-white text-xs', 'ALL TIME ' + r.h2h.w + '-' + r.h2h.l));
  box.appendChild(pills);
  resultEl.rbtn = btn('REMATCH', 'retro-key-active', () => requestRematch(M));
  box.appendChild(resultEl.rbtn);
  if (M.kind !== 'friend') box.appendChild(btn('NEW OPPONENT', 'c-orange', () => { leaveMatch(M); openMenu().then(() => startGlobal()); }));
  box.appendChild(btn('LEAVE', 'c-white', () => leaveMatch(M)));
  resultEl.appendChild(box);
  frame().appendChild(resultEl);
  updateResultUI(M);
}
function updateResultUI(M) {
  if (!resultEl || !resultEl.rbtn) return;
  const b = resultEl.rbtn;
  if (M.peerClosed && !M.ghost) { b.textContent = 'OPPONENT LEFT'; b.disabled = true; return; }
  b.disabled = M.rematch.me;
  b.textContent = M.rematch.me ? 'WAITING FOR ' + (M.opp.name || 'RIVAL').toUpperCase() + '...' : M.rematch.opp ? 'ACCEPT REMATCH' : 'REMATCH';
}
function hideResult() { if (resultEl) { resultEl.remove(); resultEl = null; } }

function showVS(M) {
  hideVS(true);
  const id = identity() || { name: 'YOU', photo: '' };
  const kind = M.kind;
  vsEl = el('div', 'mp-vs mp-vs-' + kind);
  const smoke = el('div', 'mp-smoke');
  for (let i = 0; i < 5; i++) smoke.appendChild(el('i'));
  vsEl.appendChild(smoke);
  vsEl.appendChild(el('div', 'mp-vs-tag', kind === 'friend' ? 'FRIENDLY DUEL' : kind === 'ghost' ? (M.ghost && M.ghost.bot ? 'PRACTICE MATCH' : 'GHOST RUN') : 'GLOBAL MATCH'));
  const side = (who, cls, rating, tag) => {
    const s = el('div', 'mp-vs-side ' + cls);
    const av = avatar(116, who, true);
    av.classList.add('mp-vs-av');
    s.avEl = av;
    s.appendChild(av);
    const n = el('div', 'mp-vs-name', who.name.toUpperCase()); s.appendChild(n);
    if (rating) s.appendChild(el('div', 'mp-vs-rating', tag + ' ' + rating));
    return s;
  };
  const showR = kind !== 'friend';
  vsEl.appendChild(side({ name: id.name, photo: id.photo }, 'left', showR ? stats.rating : 0, 'RATING'));
  const mark = el('div', 'mp-vs-mark');
  mark.appendChild(el('span', '', 'V')); mark.appendChild(el('em', '', '/')); mark.appendChild(el('span', '', 'S'));
  vsEl.appendChild(mark);
  const rightSide = side({ name: M.opp.name || 'RIVAL', photo: M.opp.photo }, 'right', showR && M.opp.rating ? M.opp.rating : 0, M.ghost ? 'BEST' : 'RATING');
  vsEl.appendChild(rightSide);
  // the rival's photo is fetched while the clocks sync; if it lands after this screen opened, swap it in place (never stay on the letter)
  if (!M.opp.photo && M.oppInfo) {
    const thisVs = vsEl;
    M.oppInfo.then(() => { if (vsEl === thisVs && Z.match === M && M.opp.photo) fillAvatar(rightSide.avEl, { name: M.opp.name, photo: M.opp.photo }, true); });
  }
  vsEl.appendChild(el('div', 'mp-vs-sub', '90 SECONDS  ·  BEST SCORE WINS'));
  document.body.appendChild(vsEl);
  const at = (ms, fn) => M.timers.push(setTimeout(fn, ms));
  sfx.whoosh(true);
  at(280, () => sfx.whoosh(false));
  at(900, sfx.pop);
  at(1650, sfx.boom);
  at(2700, sfx.sting);
}
function hideVS(now) {
  if (!vsEl) return;
  const v = vsEl;
  vsEl = null;
  if (now) { v.remove(); return; }
  v.classList.add('out');
  setTimeout(() => v.remove(), 450);
}

/* ---------------------------------------------------------------------------
 * 12. Wiring
 * ------------------------------------------------------------------------ */
$('mpBtn').addEventListener('click', () => { Z.autoRetry = 0; openMenu(); });
document.addEventListener('visibilitychange', syncInbox);
onAuthStateChanged(auth, () => { syncInbox(); maybeAutoJoin(); });
window.addEventListener('pagehide', () => {
  try {
    if (Z.match && Z.match.peer) Z.match.peer.send({ k: 'bye' });
    if (Z.host && Z.host.code) deleteDoc(doc(db, 'mp_codes', Z.host.code)).catch(() => {});
    if (Z.search && Z.search.slot) deleteDoc(doc(db, 'mp_slots', Z.search.slot)).catch(() => {});
  } catch (e) { /* ignore */ }
});

// share link: https://inchase.web.app/?join=ABC123
let pendingJoin = '';
try { const q = new URLSearchParams(location.search).get('join'); if (q) pendingJoin = normalizeCode(q); } catch (e) { /* ignore */ }
function maybeAutoJoin() {
  if (!pendingJoin || !identity() || !bridge.canStart()) return;
  const code = pendingJoin;
  pendingJoin = '';
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  setTimeout(async () => {
    if (!bridge.canStart()) return;
    bridge.initAudio();
    await syncProfileAndClock();
    ui.codeInput.value = code;
    ui.joinMsg.textContent = '';
    joinFriend(code);
  }, 600);
}
syncInbox();
log('multiplayer ready');