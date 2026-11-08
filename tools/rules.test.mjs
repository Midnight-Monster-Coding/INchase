/* Emulator tests for rules/firestore.rules (server-owned scores). NOT RUN by the author: run them before you deploy.
 *   npm i -D @firebase/rules-unit-testing firebase
 *   npx firebase emulators:exec --only firestore "node tools/rules.test.mjs"
 * Any FAIL = do not deploy the rules yet. */
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({ projectId: 'inchase-rules-test', firestore: { rules: readFileSync(new URL('../rules/firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 } });
let failed = 0;
const check = async (name, ok, fn) => { try { await (ok ? assertSucceeds(fn()) : assertFails(fn())); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '   ' + String(e.message || e).split('\n')[0]); } };
const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocJabc123=s96-c';

await env.clearFirestore();
let db = env.authenticatedContext('u1').firestore();
await check('sign-up: username + profile at zero', true, () => { const b = writeBatch(db);
  b.set(doc(db, 'usernames/alice'), { uid: 'u1', name: 'Alice', createdAt: serverTimestamp() });
  b.set(doc(db, 'users/u1'), { username: 'Alice', usernameLower: 'alice', photoURL: '', best: 0, total: 0, runs: [], light: false, ctrl: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return b.commit(); });
await check('sign-up with a pre-filled best (guest score import) is refused', false, () => { const d2 = env.authenticatedContext('u2').firestore(); const b = writeBatch(d2);
  b.set(doc(d2, 'usernames/bob'), { uid: 'u2', name: 'Bob', createdAt: serverTimestamp() });
  b.set(doc(d2, 'users/u2'), { username: 'Bob', usernameLower: 'bob', photoURL: '', best: 999999, total: 0, runs: [], light: false, ctrl: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return b.commit(); });

console.log('--- the browser can no longer write server-owned fields');
await check('console: users.best = 999999 refused', false, () => updateDoc(doc(db, 'users/u1'), { best: 999999, updatedAt: serverTimestamp() }));
await check('profile: history / settings still save', true, () => updateDoc(doc(db, 'users/u1'), { total: 3, runs: [{ score: 10, wave: 1, mode: 'arcade' }], light: true, ctrl: 'stick', updatedAt: serverTimestamp() }));
await check('profile: username can not change', false, () => updateDoc(doc(db, 'users/u1'), { username: 'Admin', updatedAt: serverTimestamp() }));
await check('profile: tracking-pixel photo refused', false, () => updateDoc(doc(db, 'users/u1'), { photoURL: 'https://evil.example/p.png', updatedAt: serverTimestamp() }));
await check('profile: Google photo accepted', true, () => updateDoc(doc(db, 'users/u1'), { photoURL: GOOGLE, updatedAt: serverTimestamp() }));

const row = (o) => ({ username: 'Alice', usernameLower: 'alice', photoURL: '', updatedAt: serverTimestamp(), ...o });
await check('leaderboard: create row with best 1000 refused', false, () => setDoc(doc(db, 'leaderboard/u1'), row({ best: 1000 })));
await check('leaderboard: create row (name + photo, no score)', true, () => setDoc(doc(db, 'leaderboard/u1'), row({})));
await check('leaderboard: console best = 999999 refused', false, () => setDoc(doc(db, 'leaderboard/u1'), row({ best: 999999 }), { merge: true }));
await check('leaderboard: console mpRating = 4000 refused', false, () => updateDoc(doc(db, 'leaderboard/u1'), { mpRating: 4000 }));
await check('leaderboard: re-sending the same name/photo (what the game does) works', true, () => setDoc(doc(db, 'leaderboard/u1'), row({}), { merge: true }));
await check('leaderboard: changing photo works', true, () => setDoc(doc(db, 'leaderboard/u1'), row({ photoURL: GOOGLE }), { merge: true }));
await check('leaderboard: name that is not mine refused', false, () => setDoc(doc(db, 'leaderboard/u1'), row({ username: 'Bob', usernameLower: 'bob' }), { merge: true }));

await check('mpstats: console rating write refused', false, () => setDoc(doc(db, 'mpstats/u1'), { rating: 1040, games: 1, updatedAt: serverTimestamp() }, { merge: true }));
await check('mpstats: clock read (seen) works', true, () => setDoc(doc(db, 'mpstats/u1'), { seen: serverTimestamp() }, { merge: true }));
await check('mpstats: anyone can read ratings', true, () => getDoc(doc(env.authenticatedContext('u2').firestore(), 'mpstats/u1')));

await check('daily: console entry refused', false, () => setDoc(doc(db, 'daily/20000/entries/u1'), { username: 'Alice', score: 999999 }));
await check('daily: players can read the board', true, () => getDoc(doc(db, 'daily/20000/entries/u1')));
for (const c of ['runs/x', 'daily_started/20000_u1', 'mp_reports/abc', 'mp_pairs/a_b_1', 'mp_rate/u1_1', 'banned/u1'])
  await check('server-only collection ' + c + ': no access', false, () => setDoc(doc(db, c), { a: 1 }));
await check('server-only: reads refused too', false, () => getDoc(doc(db, 'banned/u1')));

console.log(failed ? `\n${failed} test(s) FAILED: do not deploy the rules yet.` : '\nAll rule tests passed.');
await env.cleanup(); process.exit(failed ? 1 : 0);
