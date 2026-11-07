/* =============================================================================
 * INchase multiplayer: mp-core.js  (pure logic, no DOM, no Firebase, no imports)
 *
 * Everything here is deterministic and unit-testable in Node. multiplayer.js
 * (Firebase + UI + match flow) and mp-net.js (WebRTC) build on it.
 * ========================================================================== */

export const MP = Object.freeze({
  VERSION: 1,
  ARENA_W: 800,               // fixed logical arena: a phone and a laptop play the SAME field
  ARENA_H: 450,
  MATCH_SEC: 90,              // match length (same as Blitz)
  SURGE_AT: 75,               // last 15 s: every score gain is doubled ("Final Surge")
  COUNTDOWN_SEC: 3,           // 3-2-1-GO inside the arena
  VS_SEC: 4.6,                // VS intro animation length (the countdown starts right after it)
  EARLY_DEATH_SEC: 15,        // a loss by dying before this gives no rating loss
  SNAP_HZ: 12,                // position snapshots per second
  INTERP_MS: 110,             // render the rival this far in the past so motion is smooth
  GONE_MS: 6000,              // no snapshot for this long = rival disconnected
  FIN_WAIT_MS: 3000,          // wait this long for the rival's final message before using the last known score
  REMATCH_WAIT_MS: 15000,

  CODE_LEN: 6,
  CODE_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',   // no I, O, 0, 1
  CODE_TTL_MS: 5 * 60 * 1000,

  SLOT_STALE_MS: 14000,       // a waiting ticket older than this is dead
  SLOT_REFRESH_MS: 8000,
  SEARCH_PROBE_MS: 3000,      // while waiting, look at other slots this often
  WIDEN_1_MS: 8000,           // after 8 s also accept the neighbouring skill bands
  WIDEN_2_MS: 15000,          // after 15 s accept any band
  GHOST_OFFER_MS: 12000,      // nobody found after 12 s: offer a ghost rival
  BANDS: 6,

  INVITE_WAVES: [[5000, 1], [12000, 2], [22000, 4]],   // [ms into the search, number of subscriber shards to tell]
  INVITE_TTL_MS: 25000,
  SUB_SHARD_TARGET: 12,       // aimed number of subscribers per shard (the server config sets the shard count)

  GHOST_SLOTS: 8,
  GHOST_HZ: 8
});

/* ---------------------------------------------------------------- hashing / rng */
export function hash32(a, b = 0, c = 0) {
  let h = (2166136261 ^ a) >>> 0;
  h = Math.imul(h ^ b, 16777619);
  h = Math.imul(h ^ c, 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}
export function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// uid string -> stable 32-bit number
export function strHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h ^ (h >>> 15)) >>> 0;
}

/* ---------------------------------------------------------------- friend codes */
export function makeCode(rand = Math.random) {
  let c = '';
  for (let i = 0; i < MP.CODE_LEN; i++) c += MP.CODE_ALPHABET[(rand() * MP.CODE_ALPHABET.length) | 0];
  return c;
}
export function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, MP.CODE_LEN);
}
export function isValidCode(s) {
  if (typeof s !== 'string' || s.length !== MP.CODE_LEN) return false;
  for (let i = 0; i < s.length; i++) if (MP.CODE_ALPHABET.indexOf(s[i]) < 0) return false;
  return true;
}
export function prettyCode(c) { return c.slice(0, 3) + ' ' + c.slice(3); }

/* ---------------------------------------------------------------- skill bands / rating */
// 0..5 from the player's best score (log scale: 0, 100, 300, 700, 1500, 3100+)
export function bandOf(best) {
  const b = Math.max(0, Number(best) || 0);
  return Math.max(0, Math.min(MP.BANDS - 1, Math.floor(Math.log2(b / 100 + 1))));
}
// matchmaking band from the multiplayer RATING (new players start at 1000 = band 1): <950, <1050, <1150, <1250, <1350, 1350+
export function ratingBand(rating) {
  const r = Number(rating);
  const v = Number.isFinite(r) ? r : 1000;
  return Math.max(0, Math.min(MP.BANDS - 1, Math.floor((v - 850) / 100)));
}
// slot ids to look at, in order, for a search that has been running `elapsedMs`
export function bandsToScan(band, elapsedMs) {
  const out = [band];
  if (elapsedMs >= MP.WIDEN_1_MS) {
    if (band - 1 >= 0) out.push(band - 1);
    if (band + 1 < MP.BANDS) out.push(band + 1);
  }
  if (elapsedMs >= MP.WIDEN_2_MS) {
    for (let b = 0; b < MP.BANDS; b++) if (!out.includes(b)) out.push(b);
  }
  return out;
}
export function slotId(band, shard) { return 'b' + band + 's' + shard; }
export function homeShard(uid, shards) { return shards <= 1 ? 0 : strHash(uid) % shards; }
export function shardOf(uid, shards) { return homeShard(uid, shards); }
// the shards a search probes: home first, then the next ones (at most `max`)
export function shardsToProbe(uid, shards, max = 3) {
  const out = [];
  const h = homeShard(uid, shards);
  for (let i = 0; i < Math.min(shards, max); i++) out.push((h + i) % shards);
  return out;
}
// pick n distinct random numbers in [0, total) that are not in `used`
export function pickShards(total, n, used, rand = Math.random) {
  const free = [];
  for (let i = 0; i < total; i++) if (!used.has(i)) free.push(i);
  const out = [];
  while (out.length < n && free.length) {
    const j = (rand() * free.length) | 0;
    out.push(free.splice(j, 1)[0]);
  }
  return out;
}

export function eloDelta(myRating, theirRating, myScore01, k = 24) {
  const exp = 1 / (1 + Math.pow(10, (theirRating - myRating) / 400));
  return Math.round(k * (myScore01 - exp));
}

/* ---------------------------------------------------------------- result */
// a, b = { score, at }  (`at` = match clock seconds when the final score was reached)
// returns 1 if a wins, -1 if b wins, 0 draw
export function decideWinner(a, b) {
  if (a.score !== b.score) return a.score > b.score ? 1 : -1;
  const aa = Number.isFinite(a.at) ? a.at : 1e9;
  const ba = Number.isFinite(b.at) ? b.at : 1e9;
  if (Math.abs(aa - ba) > 0.05) return aa < ba ? 1 : -1;
  return 0;
}

/* ---------------------------------------------------------------- position snapshots */
const QX = 65535 / MP.ARENA_W;
const QY = 65535 / MP.ARENA_H;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export function quantX(x) { return Math.round(clamp(x, 0, MP.ARENA_W) * QX); }
export function quantY(y) { return Math.round(clamp(y, 0, MP.ARENA_H) * QY); }
export function dequantX(q) { return q / QX; }
export function dequantY(q) { return q / QY; }

// flags: bit0 dead | bit1 dashing | bit2-3 shields (0..2) | bit4 final surge | bit5 Ghost Drive (gold)
export function packFlags(f) {
  return (f.dead ? 1 : 0) | (f.dash ? 2 : 0) | ((Math.max(0, Math.min(2, f.shields | 0))) << 2) | (f.surge ? 16 : 0) | (f.gd ? 32 : 0);
}
export function unpackFlags(n) {
  return { dead: !!(n & 1), dash: !!(n & 2), shields: (n >> 2) & 3, surge: !!(n & 16), gd: !!(n & 32) };
}
// "P,seq,tMs,xq,yq,score,flags,wave"  (about 30 bytes)
export function encodeSnap(s) {
  return 'P,' + (s.seq | 0) + ',' + Math.round(s.t) + ',' + quantX(s.x) + ',' + quantY(s.y) + ',' +
    (Math.max(0, s.score) | 0) + ',' + packFlags(s) + ',' + (s.wave | 0);
}
export function decodeSnap(str) {
  if (typeof str !== 'string' || str.length > 80 || str.charCodeAt(0) !== 80 /* P */) return null;
  const p = str.split(',');
  if (p.length !== 8) return null;
  const n = new Array(7);
  for (let i = 0; i < 7; i++) { n[i] = Number(p[i + 1]); if (!Number.isFinite(n[i])) return null; }
  const f = unpackFlags(n[5]);
  return { seq: n[0], t: n[1], x: dequantX(n[2]), y: dequantY(n[3]), score: n[4], dead: f.dead, dash: f.dash, shields: f.shields, surge: f.surge, gd: f.gd, wave: n[6] };
}

/* ---------------------------------------------------------------- interpolation buffer */
export class Interp {
  constructor(cap = 48) { this.buf = []; this.cap = cap; this.lastSeq = -1; }
  push(s) {                           // s.t must already be in the LOCAL clock (ms)
    if (s.seq <= this.lastSeq) return false;           // unordered channel: drop old / duplicate packets
    this.lastSeq = s.seq;
    const b = this.buf;
    b.push(s);
    if (b.length > this.cap) b.shift();
    return true;
  }
  get last() { return this.buf.length ? this.buf[this.buf.length - 1] : null; }
  // position at local time `at` (ms)
  at(at) {
    const b = this.buf;
    if (!b.length) return null;
    if (at <= b[0].t) return { x: b[0].x, y: b[0].y, s: b[0] };
    const last = b[b.length - 1];
    if (at >= last.t) {                // ahead of the data: extrapolate a little, then hold
      const prev = b.length > 1 ? b[b.length - 2] : null;
      if (!prev || last.t === prev.t) return { x: last.x, y: last.y, s: last };
      const dt = Math.min(at - last.t, 120);
      const vx = (last.x - prev.x) / (last.t - prev.t);
      const vy = (last.y - prev.y) / (last.t - prev.t);
      return { x: clamp(last.x + vx * dt, 0, MP.ARENA_W), y: clamp(last.y + vy * dt, 0, MP.ARENA_H), s: last };
    }
    let i = b.length - 2;
    while (i > 0 && b[i].t > at) i--;
    const a = b[i], c = b[i + 1];
    const k = c.t === a.t ? 1 : (at - a.t) / (c.t - a.t);
    return { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, s: k < 0.5 ? a : c };
  }
}

/* ---------------------------------------------------------------- clock sync (NTP style) */
// guest pings the host. offset = hostClock - guestClock, from the sample with the smallest round trip.
export class ClockSync {
  constructor() { this.best = null; this.n = 0; }
  add(t0, th, t1) {
    const rtt = t1 - t0;
    if (!(rtt >= 0) || rtt > 4000) return;
    this.n++;
    if (!this.best || rtt < this.best.rtt) this.best = { rtt, offset: th - (t0 + t1) / 2 };
  }
  get offset() { return this.best ? this.best.offset : 0; }
  get rtt() { return this.best ? this.best.rtt : 0; }
}

/* ---------------------------------------------------------------- ICE servers */
// cfg = { stun:[urls], metered:{urls:[], username, credential}, express:{...} }
// Entries with no credentials are skipped, so the game works (STUN only) before any TURN account exists.
export function buildIceServers(cfg) {
  const out = [];
  const stun = (cfg && cfg.stun) || [];
  if (stun.length) out.push({ urls: stun.slice() });
  ['metered', 'express'].forEach((k) => {
    const s = cfg && cfg[k];
    if (s && s.username && s.credential && s.urls && s.urls.length) {
      out.push({ urls: s.urls.slice(), username: s.username, credential: s.credential });
    }
  });
  return out;
}
export function hasTurn(servers) {
  return servers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(u)));
}

/* ---------------------------------------------------------------- ghosts */
function b64FromBytes(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function bytesFromB64(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
// positions: array of [x, y] sampled at GHOST_HZ; scores: score at the end of each second (length <= 91)
export function encodeGhost(positions, scores) {
  const pos = new Uint16Array(positions.length * 2);
  positions.forEach((p, i) => { pos[i * 2] = quantX(p[0]); pos[i * 2 + 1] = quantY(p[1]); });
  const sc = new Uint32Array(scores.length);
  scores.forEach((v, i) => { sc[i] = Math.max(0, Math.min(4294967295, v | 0)); });
  return { pos: b64FromBytes(new Uint8Array(pos.buffer)), sc: b64FromBytes(new Uint8Array(sc.buffer)) };
}
export function decodeGhost(doc) {
  try {
    if (!doc || typeof doc.pos !== 'string' || typeof doc.sc !== 'string') return null;
    if (doc.pos.length > 5000 || doc.sc.length > 700) return null;
    const pb = bytesFromB64(doc.pos), sb = bytesFromB64(doc.sc);
    if (pb.length < 8 || pb.length % 4 || sb.length % 4) return null;
    const pos16 = new Uint16Array(pb.buffer, pb.byteOffset, pb.length >> 1);
    const sc32 = new Uint32Array(sb.buffer, sb.byteOffset, sb.length >> 2);
    const pos = [];
    for (let i = 0; i < pos16.length; i += 2) pos.push([dequantX(pos16[i]), dequantY(pos16[i + 1])]);
    return {
      name: String(doc.name || 'Ghost').slice(0, 20),
      seed: Number(doc.seed) >>> 0,
      deadAt: Number(doc.deadAt) > 0 ? Number(doc.deadAt) : 0,
      pos, scores: Array.from(sc32)
    };
  } catch (e) { return null; }
}
// Built-in practice rival so Global works with an empty database (cold start).
export function botGhost(seed, band) {
  const r = mulberry32(hash32(seed, 991, band));
  const pos = [];
  const n = MP.MATCH_SEC * MP.GHOST_HZ + 1;
  const ax = 220 + r() * 120, ay = 110 + r() * 70, fx = 0.35 + r() * 0.25, fy = 0.5 + r() * 0.3, ph = r() * 6.28;
  for (let i = 0; i < n; i++) {
    const t = i / MP.GHOST_HZ;
    pos.push([MP.ARENA_W / 2 + Math.sin(t * fx + ph) * ax, MP.ARENA_H / 2 + Math.cos(t * fy) * ay]);
  }
  const rate = 14 + band * 9 + r() * 8;                       // points per second grows with the skill band
  const scores = [];
  for (let s = 0; s <= MP.MATCH_SEC; s++) scores.push(Math.round(rate * s * (s >= MP.SURGE_AT ? 1.5 : 1) * 1.0 / 5) * 5);
  const deadAt = r() < 0.55 ? Math.round(45 + r() * 40) : 0;
  return { name: 'PRACTICE BOT', seed: seed >>> 0, deadAt, pos, scores, bot: true };
}
// state of a ghost at match clock t (seconds)
export function ghostAt(g, t) {
  const i = Math.max(0, Math.min(g.pos.length - 1, t * MP.GHOST_HZ));
  const i0 = Math.floor(i), i1 = Math.min(g.pos.length - 1, i0 + 1), f = i - i0;
  const x = g.pos[i0][0] + (g.pos[i1][0] - g.pos[i0][0]) * f;
  const y = g.pos[i0][1] + (g.pos[i1][1] - g.pos[i0][1]) * f;
  const si = Math.max(0, Math.min(g.scores.length - 1, t));
  const s0 = Math.floor(si), s1 = Math.min(g.scores.length - 1, s0 + 1);
  const score = Math.round(g.scores[s0] + (g.scores[s1] - g.scores[s0]) * (si - s0));
  const dead = g.deadAt > 0 && t >= g.deadAt;
  return { x, y, score: dead ? ghostAt.deadScore(g) : score, dead };
}
ghostAt.deadScore = (g) => {
  const si = Math.max(0, Math.min(g.scores.length - 1, g.deadAt));
  return g.scores[Math.floor(si)] || 0;
};

/* ---------------------------------------------------------------- misc */
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
export function cleanName(s) { return String(s || 'Player').replace(/[^\w .#-]/g, '').slice(0, 20) || 'Player'; }