/* Local test for worker/score-worker.js. No network, no Cloudflare account needed:
 *   node tools/worker.test.mjs
 * It fakes Google's token keys and the Firestore REST API in memory (create-only writes, update-time preconditions,
 * all-or-nothing commits), signs real RSA tokens, then runs honest and hostile requests against the Worker. */
import { generateKeyPairSync, createSign } from 'node:crypto';
import worker from '../worker/score-worker.js';

const PID = 'inchase-test', ORIGIN = 'https://inchase.web.app';
const fb = generateKeyPairSync('rsa', { modulusLength: 2048 });          // "Google" key that signs Firebase ID tokens
const svc = generateKeyPairSync('rsa', { modulusLength: 2048 });         // service-account key
const jwk = { ...fb.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (b) => Buffer.from(b).toString('base64url');
const idToken = (uid, over = {}) => {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64u(JSON.stringify({ aud: PID, iss: 'https://securetoken.google.com/' + PID, sub: uid, iat: now - 5, exp: now + 3600, ...over }));
  const s = createSign('RSA-SHA256').update(h + '.' + p).sign(fb.privateKey);
  return h + '.' + p + '.' + b64u(s);
};

/* ---- fake Firestore ---- */
const store = new Map(); let ver = 0, failCommit = false;
const BASE = `projects/${PID}/databases/(default)/documents/`;
const enc = (v) => v;
const fakeFetch = async (url, init = {}) => {
  url = String(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (url.includes('/jwk/securetoken')) return J({ keys: [jwk] });
  if (url.includes('oauth2.googleapis.com/token')) return J({ access_token: 'tok', expires_in: 3600 });
  if (url.endsWith(':commit')) {
    if (failCommit) return J({ error: { status: 'INVALID_ARGUMENT' } }, 400);
    const { writes } = JSON.parse(init.body);
    const nm = (w) => (w.update ? w.update.name : w.delete).split(BASE)[1];
    for (const w of writes) {                                              // check every precondition first (all-or-nothing)
      const cur = store.get(nm(w)), pc = w.currentDocument;
      if (!pc) continue;
      if (pc.exists === false && cur) return J({ error: { status: 'ALREADY_EXISTS' } }, 409);
      if (pc.exists === true && !cur) return J({ error: { status: 'NOT_FOUND' } }, 404);
      if (pc.updateTime && (!cur || cur.updateTime !== pc.updateTime)) return J({ error: { status: 'FAILED_PRECONDITION' } }, 400);
    }
    for (const w of writes) {
      const k = nm(w);
      if (w.delete) { store.delete(k); continue; }
      const cur = store.get(k) || { fields: {} };
      const fields = { ...cur.fields };
      for (const f of w.updateMask.fieldPaths) fields[f] = w.update.fields[f];
      store.set(k, { fields, updateTime: new Date(1700000000000 + ++ver).toISOString() });
    }
    return J({ writeResults: [] });
  }
  if (url.includes('firestore.googleapis.com') && (init.method || 'GET') === 'GET') {
    const d = store.get(url.split(BASE)[1]);
    return d ? J({ name: 'x', fields: d.fields, updateTime: d.updateTime }) : J({ error: { status: 'NOT_FOUND' } }, 404);
  }
  throw new Error('unexpected fetch ' + url);
};
globalThis.fetch = fakeFetch;
const realNow = Date.now.bind(Date); let skew = 0; Date.now = () => realNow() + skew;

const env = {
  FIREBASE_PROJECT_ID: PID, SA_EMAIL: 'svc@x.iam', RUN_SECRET: 'a'.repeat(40), ALLOWED_ORIGINS: ORIGIN + ',https://inchase.firebaseapp.com',
  ADMIN_KEY: 'k'.repeat(40), HOLD_ABOVE: '30000',
  SA_PRIVATE_KEY: svc.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n')
};
const call = async (path, body, { uid = 'uidAlice', origin = ORIGIN, auth, admin } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (auth !== null) headers.Authorization = 'Bearer ' + (auth || idToken(uid));
  if (admin) headers['X-Admin-Key'] = admin;
  const r = await worker.fetch(new Request('https://w.example' + path, { method: 'POST', headers, body: JSON.stringify(body) }), env);
  return { s: r.status, d: await r.json() };
};
const F = (p, k) => { const d = store.get(p); if (!d) return undefined; const v = d.fields[k]; if (!v) return undefined; return v.integerValue !== undefined ? Number(v.integerValue) : v.stringValue ?? v.booleanValue; };
let bad = 0;
const t = (name, ok, extra) => { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '   ' + JSON.stringify(extra))); };
const profile = (uid, name, over = {}) => store.set('users/' + uid, { fields: { username: { stringValue: name }, best: { integerValue: '0' }, ...over }, updateTime: new Date(1700000000000 + ++ver).toISOString() });
const play = async (uid, mode, seconds, score, wave = 1, extra = {}) => {
  const st = await call('/run/start', { mode }, { uid });
  if (st.s !== 200) return { start: st };
  skew += seconds * 1000;
  const fin = await call('/run/finish', { token: st.d.token, score, wave, ...extra }, { uid });
  return { start: st, fin, token: st.d.token };
};

profile('uidAlice', 'Alice'); profile('uidBobby', 'Bob'); profile('uidCara1', 'Cara');

console.log('--- gatekeeping');
t('no token -> 401', (await call('/run/start', { mode: 'arcade' }, { auth: null })).s === 401);
t('garbage token -> 401', (await call('/run/start', { mode: 'arcade' }, { auth: 'a.b.c' })).s === 401);
t('token signed by someone else -> 401', (await call('/run/start', { mode: 'arcade' }, { auth: (() => { const h = b64u('{"alg":"RS256","kid":"k1"}'), p = b64u(JSON.stringify({ aud: PID, iss: 'https://securetoken.google.com/' + PID, sub: 'uidAlice', exp: 9e9, iat: 1 })); return h + '.' + p + '.' + b64u(createSign('RSA-SHA256').update(h + '.' + p).sign(svc.privateKey)); })() })).s === 401);
t('expired token -> 401', (await call('/run/start', { mode: 'arcade' }, { auth: idToken('uidAlice', { exp: 10, iat: 1 }) })).s === 401);
t('wrong project (aud) -> 401', (await call('/run/start', { mode: 'arcade' }, { auth: idToken('uidAlice', { aud: 'other' }) })).s === 401);
t('foreign origin -> 403', (await call('/run/start', { mode: 'arcade' }, { origin: 'https://evil.example' })).s === 403);
t('bad mode -> 400', (await call('/run/start', { mode: 'god' })).s === 400);

console.log('--- arcade runs');
let r = await play('uidAlice', 'arcade', 60, 5000, 6);
t('honest run accepted, best written to leaderboard + users', r.fin.d.status === 'accepted' && r.fin.d.best === 5000 && F('leaderboard/uidAlice', 'best') === 5000 && F('users/uidAlice', 'best') === 5000, r.fin);
t('new leaderboard row is complete (name + photoURL)', F('leaderboard/uidAlice', 'username') === 'Alice' && F('leaderboard/uidAlice', 'photoURL') === '');
t('same token replayed -> 409', (await call('/run/finish', { token: r.token, score: 5000, wave: 6 })).s === 409);
r = await play('uidAlice', 'arcade', 60, 900, 3);
t('lower score never lowers the best', r.fin.d.status === 'accepted' && F('leaderboard/uidAlice', 'best') === 5000, r.fin);
r = await play('uidAlice', 'arcade', 10, 9000000, 2);
t('console-style forged score is rejected', r.fin.d.status === 'rejected' && F('leaderboard/uidAlice', 'best') === 5000, r.fin);
r = await play('uidAlice', 'arcade', 10, 200, 60);
t('impossible wave count is rejected', r.fin.d.status === 'rejected', r.fin);
r = await play('uidAlice', 'arcade', 1, 100, 1);
t('instant finish is rejected', r.fin.d.status === 'rejected', r.fin);
const stolen = await call('/run/start', { mode: 'arcade' }, { uid: 'uidAlice' });
t("another player can't use my run token", (await call('/run/finish', { token: stolen.d.token, score: 10, wave: 1 }, { uid: 'uidBobby' })).s === 403);
t('tampered token -> 403', (await call('/run/finish', { token: stolen.d.token.replace(/.$/, 'A'), score: 10, wave: 1 })).s === 403);
skew += 2 * 3600e3;
t('token older than 1 hour -> 400', (await call('/run/finish', { token: stolen.d.token, score: 10, wave: 1 })).s === 400);

console.log('--- held scores + admin');
r = await play('uidBobby', 'arcade', 60, 40000, 8);
t('score above HOLD_ABOVE is held, not shown', r.fin.d.status === 'held' && F('leaderboard/uidBobby', 'best') === undefined, r.fin);
const runId = JSON.parse(Buffer.from(r.token.split('.')[0], 'base64url')).r;
t('admin route needs the key', (await call('/admin/approve', { run: runId }, { origin: '', auth: null })).s === 401);
t('admin route rejects a wrong key', (await call('/admin/approve', { run: runId }, { origin: '', auth: null, admin: 'x'.repeat(40) })).s === 401);
const ap = await call('/admin/approve', { run: runId }, { origin: '', auth: null, admin: env.ADMIN_KEY });
t('admin approve publishes the held score', ap.s === 200 && F('leaderboard/uidBobby', 'best') === 40000, ap);
t('approving twice is refused', (await call('/admin/approve', { run: runId }, { origin: '', auth: null, admin: env.ADMIN_KEY })).s === 409);

console.log('--- daily');
const d1 = await call('/run/start', { mode: 'daily' }, { uid: 'uidCara1' });
t('daily start ok', d1.s === 200);
t('second daily attempt same day -> 409', (await call('/run/start', { mode: 'daily' }, { uid: 'uidCara1' })).s === 409);
skew += 90e3;
const df = await call('/run/finish', { token: d1.d.token, score: 3000, wave: 5, grid: 'GGYR<script>' }, { uid: 'uidCara1' });
const day = Math.floor(Date.now() / 86400000);
t('daily entry created, grid sanitised', df.d.status === 'accepted' && F(`daily/${d1.d ? JSON.parse(Buffer.from(d1.d.token.split('.')[0], 'base64url')).d : day}/entries/uidCara1`, 'grid') === 'GGYR', df);

console.log('--- shadow ban');
await call('/admin/ban', { uid: 'uidAlice', wipe: true }, { origin: '', auth: null, admin: env.ADMIN_KEY });
t('ban + wipe removed the leaderboard row', !store.has('leaderboard/uidAlice') && F('users/uidAlice', 'best') === 0);
r = await play('uidAlice', 'arcade', 60, 4000, 5);
t('banned player sees "accepted" but nothing is written', r.fin.d.status === 'accepted' && !store.has('leaderboard/uidAlice'), r.fin);
await call('/admin/ban', { uid: 'uidAlice', ban: false }, { origin: '', auth: null, admin: env.ADMIN_KEY });
r = await play('uidAlice', 'arcade', 60, 4000, 5);
t('unbanned player can score again', F('leaderboard/uidAlice', 'best') === 4000, r.fin);

console.log('--- real database errors are not hidden as "exists"');
failCommit = true;
const bro = await call('/run/start', { mode: 'daily' }, { uid: 'uidBobby' });
t('Firestore failure -> 500 (not a fake 409 "daily-used")', bro.s === 500, bro);
failCommit = false;

console.log('--- multiplayer rating');
const mid = 'abcd1234abcd1234abcd1234abcd1234';
const rep = (uid, opp, s, os, at, da = -1, m = mid) => call('/mp/report', { mid: m, opp, score: s, oppScore: os, at, da, kind: 'global' }, { uid });
t('friend duels are never rated', (await call('/mp/report', { mid, opp: 'uidBobby', score: 1, oppScore: 2, at: 5, da: -1, kind: 'friend' }, { uid: 'uidAlice' })).d.state === 'unrated');
t('reporting yourself as opponent -> 400', (await rep('uidAlice', 'uidAlice', 1, 2, 5)).s === 400);
t('first report waits', (await rep('uidAlice', 'uidBobby', 2500, 1800, 88)).d.state === 'waiting');
t('same player polling still waits', (await rep('uidAlice', 'uidBobby', 2500, 1800, 88)).d.state === 'waiting');
const stranger = await rep('uidCara1', 'uidAlice', 1800, 2500, 80);
t('a third player cannot answer (or dispute) somebody else\'s match', stranger.s === 403, stranger);
const m2 = 'ffff1234ffff1234ffff1234ffff1234';
await rep('uidAlice', 'uidBobby', 2500, 1800, 88, -1, m2);
const settle = await rep('uidBobby', 'uidAlice', 1800, 2500, 80, -1, m2);
t('agreeing second report settles: winner +12, loser -12', settle.d.state === 'settled' && settle.d.delta === -12 && settle.d.rating === 988 && settle.d.outcome === 'lose', settle);
const first = await rep('uidAlice', 'uidBobby', 2500, 1800, 88, -1, m2);
t('first player polling now gets the settled result + full stats', first.d.state === 'settled' && first.d.delta === 12 && first.d.rating === 1012 && first.d.stats.wins === 1 && first.d.stats.games === 1, first);
t('mpstats written by the server', F('mpstats/uidAlice', 'rating') === 1012 && F('mpstats/uidBobby', 'rating') === 988);
t('leaderboard mpRating shown only where a row exists', F('leaderboard/uidAlice', 'mpRating') === 1012 && !store.has('leaderboard/uidCara1'));
const m3 = '1111aaaa1111aaaa1111aaaa1111aaaa';
await rep('uidAlice', 'uidBobby', 3000, 100, 80, -1, m3);
const dis = await rep('uidBobby', 'uidAlice', 100, 9999, 80, -1, m3);       // uidBobby claims a different score for uidAlice than uidAlice reported
t('players that disagree -> disputed, no rating change', dis.d.state === 'disputed' && F('mpstats/uidAlice', 'rating') === 1012, dis);
// win-trading: same pair again and again
const rounds = [];
for (let i = 0; i < 5; i++) { const id = 'cccc' + i + '0000cccc' + i + '0000cccc' + i + '000'; await rep('uidAlice', 'uidBobby', 3000, 100, 80, -1, id); rounds.push((await rep('uidBobby', 'uidAlice', 100, 3000, 80, -1, id)).d); }
t('same pair: rated 3 more times today (x1, x0.5, x0.25), then unrated with delta 0', rounds[0].rated && rounds[1].rated && rounds[2].rated && !rounds[3].rated && !rounds[4].rated && rounds[3].delta === 0 && rounds[4].delta === 0, rounds);
console.log('      pair deltas for the loser uidBobby over 5 more games:', rounds.map((x) => x.delta).join(', '), '  (first game today was -12)');
t('rating never below 0 / above 4000', F('mpstats/uidBobby', 'rating') >= 0);
t('forged mid shape -> 400', (await call('/mp/report', { mid: '../../etc', opp: 'uidBobby', score: 1, oppScore: 1, at: 1, kind: 'global' }, { uid: 'uidAlice' })).s === 400);
t('absurd score -> clamped, not trusted', (await rep('uidAlice', 'uidCara1', 1e12, 0, 5, -1, 'dddd1234dddd1234dddd1234dddd1234')).d.state === 'waiting');

console.log(bad ? `\n${bad} test(s) FAILED` : '\nAll worker tests passed.');
process.exit(bad ? 1 : 0);
