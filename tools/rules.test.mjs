/* INchase: rules.test.mjs  -- tests for rules/firestore.rules
 *
 * NOT RUN by the author (the sandbox could not download the Firebase emulator). Run it yourself before you deploy:
 *
 *   npm i -D @firebase/rules-unit-testing firebase
 *   npx firebase emulators:exec --only firestore "node tools/rules.test.mjs"
 *
 * Every line prints PASS or FAIL. Any FAIL means: do NOT deploy the rules yet, and send me that line.
 */
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'inchase-rules-test',
  firestore: { rules: readFileSync(new URL('../rules/firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 }
});

let failed = 0;
async function check(name, expectOk, fn) {
  try { await (expectOk ? assertSucceeds(fn()) : assertFails(fn())); console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '   ' + String(e.message || e).split('\n')[0]); }
}
const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocJabc123=s96-c';
const inOneHour = () => Timestamp.fromMillis(Date.now() + 3600e3);

async function seedAlice() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'usernames/alice'), { uid: 'u1', name: 'Alice', createdAt: new Date() });
    await setDoc(doc(db, 'users/u1'), { username: 'Alice', usernameLower: 'alice', photoURL: '', best: 0, total: 0, runs: [], light: false, ctrl: null });
  });
}

// ---------- accounts / usernames
await env.clearFirestore();
{
  const db = env.authenticatedContext('u1').firestore();
  await check('sign-up: username + profile claimed in one batch', true, () => {
    const b = writeBatch(db);
    b.set(doc(db, 'usernames/alice'), { uid: 'u1', name: 'Alice', createdAt: serverTimestamp() });
    b.set(doc(db, 'users/u1'), { username: 'Alice', usernameLower: 'alice', photoURL: '', best: 0, total: 0, runs: [], light: false, ctrl: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return b.commit();
  });
  await check('hoarding: a second username for the same account is refused', false, () => setDoc(doc(db, 'usernames/bob'), { uid: 'u1', name: 'Bob', createdAt: serverTimestamp() }));
}
await seedAlice();
{
  const db = env.authenticatedContext('u1').firestore();
  await check('profile: username can not be edited', false, () => updateDoc(doc(db, 'users/u1'), { username: 'AdminOfficial', updatedAt: serverTimestamp() }));
  await check('profile: cloud save (best/runs) works', true, () => updateDoc(doc(db, 'users/u1'), { best: 500, total: 3, runs: [{ score: 500, wave: 4, mode: 'arcade' }], updatedAt: serverTimestamp() }));
  await check('profile: more than 20 runs refused', false, () => updateDoc(doc(db, 'users/u1'), { runs: Array.from({ length: 21 }, () => ({ score: 1, wave: 1, mode: 'arcade' })), updatedAt: serverTimestamp() }));
  await check('profile: tracking-pixel photo refused', false, () => updateDoc(doc(db, 'users/u1'), { photoURL: 'https://evil.example/pixel.png', updatedAt: serverTimestamp() }));
  await check('profile: Google photo accepted', true, () => updateDoc(doc(db, 'users/u1'), { photoURL: GOOGLE, updatedAt: serverTimestamp() }));
  await check('profile: someone else cannot read it', false, () => getDoc(doc(env.authenticatedContext('u2').firestore(), 'users/u1')));

  // ---------- leaderboard
  const lb = (over) => ({ username: 'Alice', usernameLower: 'alice', photoURL: '', best: 1200, updatedAt: serverTimestamp(), ...over });
  await check('leaderboard: normal write', true, () => setDoc(doc(db, 'leaderboard/u1'), lb({})));
  await check('leaderboard: score above 1,000,000 refused', false, () => setDoc(doc(db, 'leaderboard/u1'), lb({ best: 2000000 })));
  await check('leaderboard: external photo URL refused', false, () => setDoc(doc(db, 'leaderboard/u1'), lb({ photoURL: 'http://evil.example/x.png' })));
  await check('leaderboard: name that is not my username refused', false, () => setDoc(doc(db, 'leaderboard/u1'), lb({ username: 'Bob', usernameLower: 'bob' })));
  await check('leaderboard: rating-only update', true, () => updateDoc(doc(db, 'leaderboard/u1'), { mpRating: 1024 }));

  // ---------- multiplayer
  await check('mp code: own name', true, () => setDoc(doc(db, 'mp_codes/ABC234'), { host: 'u1', name: 'Alice', state: 'open', ts: serverTimestamp(), expireAt: inOneHour() }));
  await check('mp code: pretending to be another player refused', false, () => setDoc(doc(db, 'mp_codes/XYZ789'), { host: 'u1', name: 'Bob', state: 'open', ts: serverTimestamp(), expireAt: inOneHour() }));
  await check('mp code: expireAt a year ahead refused', false, () => setDoc(doc(db, 'mp_codes/QWE456'), { host: 'u1', name: 'Alice', state: 'open', ts: serverTimestamp(), expireAt: Timestamp.fromMillis(Date.now() + 365 * 864e5) }));

  const base = { rating: 1000, wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, games: 0, bestScore: 0 };
  await check('mpstats: clock read (seen only)', true, () => setDoc(doc(db, 'mpstats/u1'), { seen: serverTimestamp() }, { merge: true }));
  await check('mpstats: first match, +24 with one new game', true, () => setDoc(doc(db, 'mpstats/u1'), { ...base, rating: 1024, wins: 1, games: 1, updatedAt: serverTimestamp() }, { merge: true }));
  await check('mpstats: rating moves WITHOUT a new game refused', false, () => setDoc(doc(db, 'mpstats/u1'), { rating: 1048, updatedAt: serverTimestamp() }, { merge: true }));
  await check('mpstats: +100 wins in one write refused', false, () => setDoc(doc(db, 'mpstats/u1'), { wins: 101, games: 2, rating: 1024, updatedAt: serverTimestamp() }, { merge: true }));
  await check('mpstats: second match, -12 with one new game', true, () => setDoc(doc(db, 'mpstats/u1'), { rating: 1012, losses: 1, games: 2, updatedAt: serverTimestamp() }, { merge: true }));

  // ---------- ghosts
  const ghost = { band: 1, seed: 7, score: 900, deadAt: 0, name: 'Alice', pos: 'AAAAAAAA', sc: 'AAAA', ts: serverTimestamp(), expireAt: Timestamp.fromMillis(Date.now() + 14 * 864e5) };
  await check('ghost: first upload', true, () => setDoc(doc(db, 'mp_ghosts/b1_0'), ghost));
  await check('ghost: overwriting the same slot again right away refused', false, () => setDoc(doc(db, 'mp_ghosts/b1_0'), { ...ghost, ts: serverTimestamp() }));
}

console.log(failed ? `\n${failed} test(s) FAILED: do not deploy the rules yet.` : '\nAll rule tests passed.');
await env.cleanup();
process.exit(failed ? 1 : 0);
