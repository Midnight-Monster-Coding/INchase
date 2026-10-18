/* =============================================================================
 * INchase auth + cloud save  (loaded by index.html as <script type="module" src="auth.js">)
 *
 * Responsibilities
 *   1. Login: Google, Email + Password, Email link (passwordless)
 *   2. Username picker (unique, claimed in a Firestore transaction)
 *   3. Account chip (avatar + #username)
 *   4. Cloud save of best score / match history (browser cache stays the fast path)
 *
 * It talks to the game only through window.INchaseApp (defined in index.html):
 *   getUid / setUid / getData / setData / resetData / pauseIfPlaying
 * and the game calls window.INchaseCloud.schedulePush() whenever it saves.
 *
 * Debugging: run  localStorage.inchase_debug = '1'  in the console and reload
 * to see "[auth]" logs for every step.
 * ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-analytics.js";
import {
  getAuth, onAuthStateChanged, signOut,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, runTransaction, serverTimestamp,
  collection, query, orderBy, limit, startAfter, where, getDocs, getCountFromServer, writeBatch
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------------------------------------------------------------------------
 * 0. Setup + helpers
 * ------------------------------------------------------------------------ */
const app = initializeApp(firebaseConfig);
window.firebaseApp = app;
isSupported().then((ok) => { if (ok) getAnalytics(app); }).catch(() => {});

const auth = getAuth(app);
const db = getFirestore(app);
const App = window.INchaseApp;

const $ = (id) => document.getElementById(id);
const MODE_KEY = 'inchase_mode';                 // 'guest' | 'user'
const PROFILE_KEY = 'inchase_profile_v1';        // cached {uid, username, photoURL, email}
const EMAIL_KEY = 'inchase_email_for_signin';    // remembered between "send link" and "open link"

const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } };

const DEBUG = lsGet('inchase_debug') === '1';
const log = (...a) => { if (DEBUG) console.log('[auth]', ...a); };

const showModal = (id) => { App.pauseIfPlaying(); $(id).classList.remove('hidden'); };
const hideModal = (id) => $(id).classList.add('hidden');
const isOpen = (id) => !$(id).classList.contains('hidden');

// The game checks this so WASD / Space don't move the player while you type.
window.INchaseAuthBusy = () => !!document.querySelector('.auth-modal:not(.hidden)');

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}

/* ---------------------------------------------------------------------------
 * 1. State
 * ------------------------------------------------------------------------ */
let currentUser = null;      // Firebase user (may not have a username yet)
let profile = null;          // {uid, username, photoURL, email}: only set once a username exists
let needPush = false;
let pushTimer = null;
let completingLink = false;  // true while finishing an email-link login
const splashDone = new Promise((res) => setTimeout(res, Math.max(0, 2300 - performance.now())));

// Leaderboard state (the code lives in section 8; the state is here because updateAccountUI() below uses it)
const BOARD_PAGE = 12;       // players fetched per request
const BOARD_TOP = 4;         // rows that are visible at once; your own row is pinned below when you are not among them
const Board = {
  rows: [],                  // [{uid, username, photoURL, best, rank}] in global order
  cursor: null,              // last Firestore doc of the loaded rows (for the next page)
  done: false,               // true once the last page has been loaded
  loading: false,
  error: false,
  loadedAt: 0,               // ms timestamp of the last successful first-page load
  myRank: null,              // my global rank from a count query (covers "not in the loaded rows")
  seq: 0,                    // bumped on every reset so stale responses are ignored
  tab: 'ranks'               // 'ranks' | 'history'
};
let lastBoardSig = '';       // what the leaderboard doc currently holds (avoids pointless writes)

try {
  const raw = lsGet(PROFILE_KEY);
  if (raw && lsGet(MODE_KEY) === 'user') profile = JSON.parse(raw);
} catch (e) { profile = null; }

/* ---------------------------------------------------------------------------
 * 2. Account chip / account modal
 * ------------------------------------------------------------------------ */
function renderAvatar(el, p) {
  el.textContent = '';
  el.style.background = '';
  el.style.color = '';
  const letter = () => {
    el.textContent = '';
    el.style.background = 'var(--cyan)';
    el.style.color = '#0A0A0A';
    el.textContent = (p && p.username ? p.username[0] : '?').toUpperCase();
  };
  if (p && p.photoURL) {
    const img = new Image();
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.className = 'w-full h-full object-cover';
    img.onerror = letter;
    img.src = p.photoURL;
    el.appendChild(img);
  } else {
    letter();
  }
}

function updateAccountUI() {
  $('chipName').textContent = profile ? '#' + profile.username : 'LOGIN';
  $('accountChip').title = profile ? 'Account' : 'Login to save your scores';
  renderAvatar($('chipAvatar'), profile);
  renderAvatar($('mAvatar'), profile);
  applyBoardUI();
}
updateAccountUI();

function openAccount() {
  if (!profile) { openLogin(); return; }
  renderAvatar($('aAvatar'), profile);
  $('aName').textContent = '#' + profile.username;
  $('aEmail').textContent = profile.email || '';
  $('photoMsg').textContent = '';
  $('photoRemoveBtn').classList.toggle('hidden', !profile.custom);
  showModal('accountModal');
}
$('accountChip').addEventListener('click', openAccount);
$('accountBtnM').addEventListener('click', openAccount);
$('accountCloseBtn').addEventListener('click', () => hideModal('accountModal'));
$('signOutBtn').addEventListener('click', async () => {
  hideModal('accountModal');
  try { await signOut(auth); } catch (e) { toast('SIGN OUT FAILED'); }
});

/* ---------------------------------------------------------------------------
 * 3. Welcome + login modals
 * ------------------------------------------------------------------------ */
const AUTH_BUTTONS = ['googleBtn', 'emailLoginBtn', 'emailSignupBtn', 'emailLinkBtn', 'forgotBtn'];
const setMsg = (t) => { $('authMsg').textContent = t; };
const setAuthBusy = (b) => AUTH_BUTTONS.forEach((id) => { $(id).disabled = b; });

function openWelcome() { showModal('welcomeModal'); }
function openLogin() {
  setMsg('');
  setAuthBusy(false);
  hideModal('welcomeModal');
  showModal('loginModal');
}
function closeLogin() {
  hideModal('loginModal');
  if (!lsGet(MODE_KEY) && !currentUser) openWelcome();
}

$('welcomeLoginBtn').addEventListener('click', openLogin);
$('welcomeGuestBtn').addEventListener('click', () => { lsSet(MODE_KEY, 'guest'); hideModal('welcomeModal'); });
$('loginBackBtn').addEventListener('click', closeLogin);

// Turn a Firebase error into something a player can read.
function explain(err) {
  const code = (err && err.code) || '';
  log('auth error', code, err);
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'WRONG EMAIL OR PASSWORD.';
    case 'auth/invalid-email': return 'THAT EMAIL LOOKS WRONG.';
    case 'auth/email-already-in-use': return 'EMAIL ALREADY REGISTERED. TRY LOGIN.';
    case 'auth/weak-password': return 'PASSWORD NEEDS 6+ CHARACTERS.';
    case 'auth/missing-password': return 'ENTER A PASSWORD.';
    case 'auth/too-many-requests': return 'TOO MANY TRIES. WAIT A BIT.';
    case 'auth/user-disabled': return 'THIS ACCOUNT IS DISABLED.';
    case 'auth/network-request-failed': return 'NETWORK PROBLEM. CHECK YOUR INTERNET.';
    case 'auth/operation-not-allowed': return 'THIS LOGIN METHOD IS NOT ENABLED IN FIREBASE.';
    case 'auth/unauthorized-domain': return 'THIS DOMAIN IS NOT AUTHORIZED IN FIREBASE.';
    case 'auth/account-exists-with-different-credential': return 'THIS EMAIL USES ANOTHER LOGIN METHOD.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request': return 'LOGIN CANCELLED.';
    case 'auth/invalid-action-code':
    case 'auth/expired-action-code': return 'THAT LOGIN LINK EXPIRED. REQUEST A NEW ONE.';
    default: return 'LOGIN FAILED (' + (code || 'error') + ')';
  }
}

function readEmail() {
  const email = $('emailInput').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg('ENTER A VALID EMAIL FIRST.'); $('emailInput').focus(); return null; }
  return email;
}

async function run(label, fn) {
  setMsg('');
  setAuthBusy(true);
  log('start', label);
  try { await fn(); } catch (err) { setMsg(explain(err)); }
  setAuthBusy(false);
}

// --- Google ---
$('googleBtn').addEventListener('click', () => run('google', async () => {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    const code = err && err.code;
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);   // page leaves; result is picked up on return
      return;
    }
    throw err;
  }
}));

// --- Email + password ---
$('emailLoginBtn').addEventListener('click', () => run('email-login', async () => {
  const email = readEmail(); if (!email) return;
  const pass = $('passInput').value;
  if (!pass) { setMsg('ENTER YOUR PASSWORD.'); return; }
  await signInWithEmailAndPassword(auth, email, pass);
}));
$('emailSignupBtn').addEventListener('click', () => run('email-signup', async () => {
  const email = readEmail(); if (!email) return;
  const pass = $('passInput').value;
  if (pass.length < 6) { setMsg('PASSWORD NEEDS 6+ CHARACTERS.'); return; }
  await createUserWithEmailAndPassword(auth, email, pass);
}));
$('passInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('emailLoginBtn').click(); }
});
$('forgotBtn').addEventListener('click', () => run('reset', async () => {
  const email = readEmail(); if (!email) return;
  await sendPasswordResetEmail(auth, email);
  setMsg('RESET EMAIL SENT. CHECK INBOX AND SPAM.');
}));

// --- Email link (passwordless) ---
$('emailLinkBtn').addEventListener('click', () => run('email-link', async () => {
  const email = readEmail(); if (!email) return;
  await sendSignInLinkToEmail(auth, email, {
    url: location.origin + location.pathname,   // the link brings the player back to this page
    handleCodeInApp: true
  });
  lsSet(EMAIL_KEY, email);
  setMsg('LOGIN LINK SENT. OPEN IT FROM YOUR EMAIL (CHECK SPAM).');
}));

async function completeEmailLinkIfPresent() {
  if (!isSignInWithEmailLink(auth, location.href)) return;
  completingLink = true;
  log('finishing email-link login');
  let email = lsGet(EMAIL_KEY);
  if (!email) email = window.prompt('ENTER THE EMAIL YOU REQUESTED THE LINK WITH');  // opened on a different device
  if (!email) { completingLink = false; toast('LOGIN LINK NOT COMPLETED'); return; }
  try {
    await signInWithEmailLink(auth, email.trim(), location.href);
    lsDel(EMAIL_KEY);
  } catch (err) {
    toast(explain(err));
  }
  completingLink = false;
  history.replaceState(null, '', location.pathname);   // remove the one-time code from the address bar
}

/* ---------------------------------------------------------------------------
 * 4. Cloud save (Firestore: users/{uid})
 * ------------------------------------------------------------------------ */
async function pushNow() {
  clearTimeout(pushTimer);
  pushTimer = null;
  if (!currentUser || !profile || profile.uid !== currentUser.uid) return;
  const d = App.getData();
  try {
    await setDoc(doc(db, 'users', currentUser.uid), {
      best: d.best, total: d.total, runs: d.runs, light: d.light, ctrl: d.ctrl,
      updatedAt: serverTimestamp()
    }, { merge: true });
    log('cloud save ok');
  } catch (e) {
    console.warn('[auth] cloud save failed', e);
  }
  // Keep the public leaderboard entry in step with the private save, then refresh the list.
  const boardChanged = await pushBoard(false);
  refreshBoard(boardChanged);
}
function schedulePush() {
  if (!currentUser || !profile || profile.uid !== currentUser.uid) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 800);
}
window.INchaseCloud = { schedulePush };
document.addEventListener('visibilitychange', () => { if (document.hidden && pushTimer) pushNow(); });

/* ---------------------------------------------------------------------------
 * 5. Signed-in flow
 * ------------------------------------------------------------------------ */
function applyCloud(d, user) {
  const local = App.getData();
  // Offline play on this same account can be ahead of the cloud copy: keep it and upload it.
  if (App.getUid() === user.uid && local.total > (Number(d.total) || 0)) {
    needPush = true;
  } else {
    App.setData({
      best: d.best,
      total: d.total || (Array.isArray(d.runs) ? d.runs.length : 0),
      runs: d.runs, light: d.light, ctrl: d.ctrl
    });
  }
  App.setUid(user.uid);
}

function finishLogin(user, username, photoURL, custom) {
  profile = { uid: user.uid, username, photoURL: photoURL || '', custom: !!custom, email: user.email || '' };
  lsSet(PROFILE_KEY, JSON.stringify(profile));
  lsSet(MODE_KEY, 'user');
  updateAccountUI();
  ['welcomeModal', 'loginModal', 'nameModal'].forEach(hideModal);
  if (needPush) { needPush = false; schedulePush(); }
  syncBoardAfterLogin();
}

async function handleSignedIn(user) {
  log('signed in', user.uid, user.providerData.map((p) => p.providerId));
  ['welcomeModal', 'loginModal'].forEach(hideModal);
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (snap.exists() && snap.data().username) {
      const d = snap.data();
      applyCloud(d, user);
      const wasShown = profile && profile.uid === user.uid;
      // An uploaded photo wins over the Google one
      const custom = !!(d.customPhoto && typeof d.photoURL === 'string' && d.photoURL);
      finishLogin(user, d.username, custom ? d.photoURL : (user.photoURL || ''), custom);
      if (!wasShown) toast('LOGGED IN AS #' + d.username);
    } else {
      await splashDone;
      openNameModal();
    }
  } catch (err) {
    console.warn('[auth] profile load failed', err);
    if (profile && profile.uid === user.uid) {
      updateAccountUI();   // offline: keep cached profile + local cache
    } else {
      toast('COULD NOT REACH THE SERVER. TRY AGAIN.');
    }
  }
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    await handleSignedIn(user);
  } else {
    log('signed out');
    if (App.getUid()) App.resetData();   // keep the next guest session clean
    profile = null;
    lsDel(PROFILE_KEY);
    resetBoard();
    updateAccountUI();
    hideModal('nameModal');
    hideModal('accountModal');
    const mode = lsGet(MODE_KEY);
    if (!mode && !completingLink) { await splashDone; if (!currentUser && !completingLink) openWelcome(); }
    else if (mode === 'user') lsSet(MODE_KEY, 'guest');
  }
});

completeEmailLinkIfPresent();

/* ---------------------------------------------------------------------------
 * 6. Username picker (# prefix, uniqueness via usernames/{lowercase})
 * ------------------------------------------------------------------------ */
let checkTimer = null;
let checkSeq = 0;
let nameOk = false;

function setNameStatus(text, kind) {
  const el = $('nameStatus');
  el.textContent = '';
  if (!text) return;
  const s = document.createElement('span');
  s.textContent = text;
  if (kind === 'good') s.className = 'nb-pill c-lime';
  else if (kind === 'bad') s.className = 'nb-pill c-pink';
  el.appendChild(s);
}

function openNameModal() {
  const input = $('nameInput');
  input.value = '';
  nameOk = false;
  $('nameSaveBtn').disabled = true;
  setNameStatus('', '');
  showModal('nameModal');
  setTimeout(() => input.focus(), 50);
}

$('nameInput').addEventListener('input', () => {
  const input = $('nameInput');
  const v = input.value.replace(/[^A-Za-z0-9_]/g, '');
  if (v !== input.value) input.value = v;
  nameOk = false;
  $('nameSaveBtn').disabled = true;
  clearTimeout(checkTimer);
  const seq = ++checkSeq;
  if (v.length < 3) { setNameStatus(v.length ? 'MINIMUM 3 CHARACTERS' : '', ''); return; }
  setNameStatus('CHECKING...', '');
  checkTimer = setTimeout(async () => {
    try {
      const s = await getDoc(doc(db, 'usernames', v.toLowerCase()));
      if (seq !== checkSeq) return;
      if (s.exists()) {
        setNameStatus('#' + v + ' IS TAKEN', 'bad');
      } else {
        nameOk = true;
        $('nameSaveBtn').disabled = false;
        setNameStatus('#' + v + ' IS AVAILABLE', 'good');
      }
    } catch (e) {
      console.warn('[auth] name check failed', e);
      if (seq !== checkSeq) return;
      setNameStatus('COULD NOT CHECK. TRY AGAIN.', 'bad');
    }
  }, 400);
});
$('nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('nameSaveBtn').click(); }
});

$('nameSaveBtn').addEventListener('click', async () => {
  const user = currentUser;
  const name = $('nameInput').value;
  if (!user || !nameOk || name.length < 3) return;
  $('nameSaveBtn').disabled = true;
  setNameStatus('SAVING...', '');
  const lower = name.toLowerCase();
  // A brand-new account inherits guest progress from this device (unless the cache belongs to someone else).
  const local = App.getData();
  const seed = App.getUid() ? { best: 0, total: 0, runs: [] } : { best: local.best, total: local.total, runs: local.runs };
  try {
    await runTransaction(db, async (tx) => {
      const nameRef = doc(db, 'usernames', lower);
      const userRef = doc(db, 'users', user.uid);
      const n = await tx.get(nameRef);
      if (n.exists()) throw new Error('taken');
      const u = await tx.get(userRef);
      if (u.exists() && u.data().username) throw new Error('already');
      tx.set(nameRef, { uid: user.uid, name, createdAt: serverTimestamp() });
      tx.set(userRef, {
        username: name, usernameLower: lower, photoURL: user.photoURL || '',
        best: seed.best, total: seed.total, runs: seed.runs,
        light: local.light, ctrl: local.ctrl,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      }, { merge: true });
    });
    App.setUid(user.uid);
    App.setData({ best: seed.best, total: seed.total, runs: seed.runs, light: local.light, ctrl: local.ctrl });
    finishLogin(user, name, user.photoURL || '', false);
    toast('WELCOME, #' + name);
  } catch (err) {
    console.warn('[auth] username claim failed', err);
    if (err && err.message === 'taken') {
      setNameStatus('#' + name + ' WAS JUST TAKEN', 'bad');
    } else if (err && err.message === 'already') {
      location.reload();
    } else {
      setNameStatus('COULD NOT SAVE. TRY AGAIN.', 'bad');
      $('nameSaveBtn').disabled = false;
    }
  }
});

$('nameSignOutBtn').addEventListener('click', async () => {
  hideModal('nameModal');
  try { await signOut(auth); } catch (e) { /* ignore */ }
});

/* ---------------------------------------------------------------------------
 * 7. Misc
 * ------------------------------------------------------------------------ */
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;
  if (isOpen('accountModal')) hideModal('accountModal');
  else if (isOpen('loginModal')) closeLogin();
});

/* ---------------------------------------------------------------------------
 * 8. Leaderboard (Firestore: leaderboard/{uid}) + profile photo upload
 *
 *  - Only logged-in players see it (guests keep the match history only).
 *  - Each row: rank, photo, #username, best score. Four rows are visible at once; the list
 *    scrolls inside its own box and loads more players as you reach the bottom.
 *  - If you are not among the visible top four, your own row (same four columns) is pinned
 *    under the list. Your rank comes from a count query, so it is right even when you are
 *    far down the list.
 *  - Ties share a rank (1, 2, 2, 4 ...).
 * ------------------------------------------------------------------------ */
// (function declarations on purpose: updateAccountUI() runs at startup, before this section is reached)
function boardBest() { return Math.max(0, Math.floor(Number(App.getData().best) || 0)); }
function boardSig(best) { return best + '|' + (profile ? profile.username + '|' + profile.photoURL : ''); }
function boardRoots() { return Array.from(document.querySelectorAll('[data-lb]')); }

// --- public entry for this player ---
async function pushBoard(force) {
  const user = currentUser;
  if (!user || !profile || profile.uid !== user.uid) return false;
  const best = boardBest();
  const sig = boardSig(best);
  if (!force && sig === lastBoardSig) return false;
  try {
    await setDoc(doc(db, 'leaderboard', user.uid), {
      username: profile.username,
      usernameLower: profile.username.toLowerCase(),
      photoURL: profile.photoURL || '',
      best,
      updatedAt: serverTimestamp()
    });
    lastBoardSig = sig;
    log('leaderboard entry saved', best);
    return true;
  } catch (e) {
    console.warn('[auth] leaderboard save failed', e);
    return false;
  }
}

async function syncBoardAfterLogin() {
  await pushBoard(true);       // also creates the entry for accounts that existed before the leaderboard
  loadBoard(true);
}

function resetBoard() {
  Board.seq++;
  Board.rows = [];
  Board.cursor = null;
  Board.done = false;
  Board.loading = false;
  Board.error = false;
  Board.loadedAt = 0;
  Board.myRank = null;
  lastBoardSig = '';
}

// --- reading ---
function addRows(docs) {
  docs.forEach((d) => {
    const x = d.data() || {};
    const best = Number(x.best) || 0;
    const prev = Board.rows[Board.rows.length - 1];
    Board.rows.push({
      uid: d.id,
      username: String(x.username || '?'),
      photoURL: typeof x.photoURL === 'string' ? x.photoURL : '',
      best,
      rank: prev && prev.best === best ? prev.rank : Board.rows.length + 1
    });
  });
}

async function fetchMyRank() {
  try {
    const snap = await getCountFromServer(query(collection(db, 'leaderboard'), where('best', '>', boardBest())));
    return snap.data().count + 1;
  } catch (e) {
    console.warn('[auth] rank lookup failed', e);
    return null;
  }
}

// Rival: the closest player above `score`, never me. Uses the loaded rows only if they reach down to this
// score (or the whole board is loaded); otherwise runs a one-off query.
App.findRival = async function (score) {
  if (!currentUser || !profile) return null;
  const rows = Board.rows;
  if (rows.length && (Board.done || rows[rows.length - 1].best <= score)) {
    const above = rows.filter((r) => r.best > score && r.uid !== currentUser.uid);
    const r = above[above.length - 1];
    return r ? { name: r.username, gap: r.best - score } : null;
  }
  try {
    const snap = await getDocs(query(collection(db, 'leaderboard'), where('best', '>', score), orderBy('best', 'asc'), limit(2)));
    const d = snap.docs.find((x) => x.id !== currentUser.uid);
    if (!d) return null;
    const x = d.data() || {};
    return { name: String(x.username || '?'), gap: (Number(x.best) || 0) - score };
  } catch (e) {
    console.warn('[auth] rival lookup failed', e);
    return null;
  }
};

// reset = true: reload from the top (and re-count my rank). Otherwise load the next page.
async function loadBoard(reset) {
  if (!currentUser || !profile) return;
  if (reset) {
    Board.seq++;
    Board.loading = false;
    Board.error = false;
  } else if (Board.loading || Board.done || Board.error || !Board.cursor) {
    return;
  }
  const seq = Board.seq;
  Board.loading = true;
  renderBoard();
  try {
    const col = collection(db, 'leaderboard');
    const q = reset
      ? query(col, orderBy('best', 'desc'), limit(BOARD_PAGE))
      : query(col, orderBy('best', 'desc'), startAfter(Board.cursor), limit(BOARD_PAGE));
    const [snap, rank] = await Promise.all([getDocs(q), reset ? fetchMyRank() : Promise.resolve(Board.myRank)]);
    if (seq !== Board.seq) return;            // a newer reset replaced this request
    if (reset) {
      Board.rows = [];
      Board.cursor = null;
      Board.myRank = rank;
    }
    addRows(snap.docs);
    if (snap.docs.length) Board.cursor = snap.docs[snap.docs.length - 1];
    Board.done = snap.docs.length < BOARD_PAGE;
    if (reset) Board.loadedAt = Date.now();
  } catch (e) {
    console.warn('[auth] leaderboard load failed', e);
    if (seq !== Board.seq) return;
    Board.error = true;
  }
  Board.loading = false;
  renderBoard();
}

// force = ignore the 15 s throttle
function refreshBoard(force) {
  if (!currentUser || !profile) return;
  if (!force && Board.loadedAt && Date.now() - Board.loadedAt < 15000) return;
  loadBoard(true);
}

// --- drawing ---
function buildRow(rank, p, isMe) {
  const row = document.createElement('div');
  row.className = 'lb-row' + (isMe ? ' me' : '');
  row.setAttribute('role', 'listitem');
  row.title = '#' + p.username + ' \u2022 ' + (Number(p.best) || 0).toLocaleString();

  const r = document.createElement('span');
  r.className = 'lb-rank tabular-nums' + (rank <= 3 ? ' r' + rank : '') + (rank >= 1000 ? ' long' : '');
  r.textContent = String(rank);

  const av = document.createElement('span');
  av.className = 'chip-avatar lb-av';
  renderAvatar(av, p);

  const n = document.createElement('span');
  n.className = 'lb-name';
  n.textContent = '#' + p.username;

  const s = document.createElement('span');
  s.className = 'lb-score tabular-nums';
  s.textContent = (Number(p.best) || 0).toLocaleString();

  row.appendChild(r);
  row.appendChild(av);
  row.appendChild(n);
  row.appendChild(s);
  return row;
}

function buildNote(text) {
  const d = document.createElement('div');
  d.className = 'lb-note';
  d.textContent = text;
  return d;
}

function renderBoard() {
  const myUid = currentUser ? currentUser.uid : (profile ? profile.uid : null);
  const rows = Board.rows;
  const idx = myUid ? rows.findIndex((r) => r.uid === myUid) : -1;
  const myRank = idx > -1 ? rows[idx].rank : Board.myRank;
  const inTop = idx > -1 && idx < BOARD_TOP;
  const showMe = !!profile && myRank != null && !inTop;

  boardRoots().forEach((root) => {
    const list = root.querySelector('.lb-list');
    const me = root.querySelector('.lb-me');
    if (!list || !me) return;
    const keep = list.scrollTop;               // appending a page must not throw the scroll position back to the top
    list.textContent = '';
    me.textContent = '';
    if (!profile) { me.classList.add('lb-off'); return; }

    if (rows.length) {
      rows.forEach((r) => list.appendChild(buildRow(r.rank, r, r.uid === myUid)));
      if (Board.error) list.appendChild(buildNote('COULD NOT LOAD MORE. TAP \u21BB TO RETRY.'));
      else if (Board.loading && !Board.done) list.appendChild(buildNote('LOADING...'));
    } else if (Board.error) {
      list.appendChild(buildNote('COULD NOT LOAD. TAP \u21BB TO RETRY.'));
    } else if (Board.loading || !Board.loadedAt) {
      list.appendChild(buildNote('LOADING...'));
    } else {
      list.appendChild(buildNote('NO PLAYERS YET.'));
    }
    list.scrollTop = keep;

    if (showMe) {
      me.appendChild(buildRow(myRank, { username: profile.username, photoURL: profile.photoURL, best: boardBest() }, true));
      me.classList.remove('lb-off');
    } else {
      me.classList.add('lb-off');
    }
  });
}

// Show / hide the leaderboard pieces depending on login state and the selected tab.
function applyBoardUI() {
  const on = !!profile;
  const ranks = on && Board.tab === 'ranks';
  $('board').classList.toggle('has-tabs', on);
  $('boardTabs').classList.toggle('lb-off', !on);
  $('rankPane').classList.toggle('lb-off', !ranks);
  $('historyPane').classList.toggle('lb-off', ranks);
  $('tabRanks').classList.toggle('active', Board.tab === 'ranks');
  $('tabHistory').classList.toggle('active', Board.tab === 'history');
  $('lbModalBox').classList.toggle('lb-off', !on);
  renderBoard();
}

$('tabRanks').addEventListener('click', () => { Board.tab = 'ranks'; applyBoardUI(); refreshBoard(false); });
$('tabHistory').addEventListener('click', () => { Board.tab = 'history'; applyBoardUI(); });

let lastManualRefresh = 0;
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('[data-lb-refresh]') : null;
  if (!btn) return;
  if (Date.now() - lastManualRefresh < 2000) return;   // protects the free Firestore quota from button mashing
  lastManualRefresh = Date.now();
  refreshBoard(true);
});

// Opening the BEST screen (the phone layout shows the leaderboard there)
$('bestBtn').addEventListener('click', () => refreshBoard(false));

// Load the next page when the list is scrolled near its end (each list has its own box)
boardRoots().forEach((root) => {
  const list = root.querySelector('.lb-list');
  if (!list) return;
  list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 30) loadBoard(false);
  }, { passive: true });
});

// Coming back to the tab after a while
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Board.loadedAt && Date.now() - Board.loadedAt > 120000) refreshBoard(false);
});

// --- profile photo ---
const PHOTO_SIZE = 128;           // px, square
const PHOTO_SOFT_LIMIT = 14000;   // characters of the data URL we aim to stay under
const PHOTO_HARD_LIMIT = 19000;   // the Firestore rule rejects more than 20000

function setPhotoMsg(t) { $('photoMsg').textContent = t; }
function setPhotoBusy(b) {
  ['photoChangeBtn', 'photoRemoveBtn', 'signOutBtn', 'accountCloseBtn'].forEach((id) => { $(id).disabled = b; });
}

// Centre-crop to a square, shrink to 128 px and encode as JPEG (keeps the upload a few KB)
async function makeAvatarDataUrl(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('decode');
    const c = document.createElement('canvas');
    c.width = PHOTO_SIZE;
    c.height = PHOTO_SIZE;
    const g = c.getContext('2d');
    g.fillStyle = '#FFFFFF';                   // transparent PNGs get a white background instead of black
    g.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    let q = 0.85;
    let out = c.toDataURL('image/jpeg', q);
    while (out.length > PHOTO_SOFT_LIMIT && q > 0.4) {
      q -= 0.1;
      out = c.toDataURL('image/jpeg', q);
    }
    if (out.length > PHOTO_HARD_LIMIT) throw new Error('toolarge');
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// dataUrl = new uploaded photo, null = go back to the Google photo (or the letter avatar)
async function applyPhoto(dataUrl) {
  const user = currentUser;
  if (!user || !profile || profile.uid !== user.uid) throw new Error('nouser');
  const custom = !!dataUrl;
  const photo = custom ? dataUrl : (user.photoURL || '');
  const best = boardBest();
  const batch = writeBatch(db);
  batch.set(doc(db, 'users', user.uid), { photoURL: photo, customPhoto: custom, updatedAt: serverTimestamp() }, { merge: true });
  batch.set(doc(db, 'leaderboard', user.uid), {
    username: profile.username,
    usernameLower: profile.username.toLowerCase(),
    photoURL: photo,
    best,
    updatedAt: serverTimestamp()
  });
  await batch.commit();
  profile = { ...profile, photoURL: photo, custom };
  lsSet(PROFILE_KEY, JSON.stringify(profile));
  lastBoardSig = boardSig(best);
  updateAccountUI();
  renderAvatar($('aAvatar'), profile);
  $('photoRemoveBtn').classList.toggle('hidden', !custom);
  refreshBoard(true);
}

$('photoChangeBtn').addEventListener('click', () => $('photoInput').click());
$('aAvatar').addEventListener('click', () => $('photoInput').click());
$('aAvatar').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('photoInput').click(); }
});

$('photoInput').addEventListener('change', async () => {
  const input = $('photoInput');
  const file = input.files && input.files[0];
  input.value = '';                            // lets the same file be picked again later
  if (!file) return;
  if (!/^image\//.test(file.type)) { setPhotoMsg('THAT FILE IS NOT AN IMAGE.'); return; }
  if (file.size > 15 * 1024 * 1024) { setPhotoMsg('IMAGE IS TOO BIG. PICK ONE UNDER 15 MB.'); return; }
  setPhotoBusy(true);
  setPhotoMsg('UPLOADING...');
  try {
    await applyPhoto(await makeAvatarDataUrl(file));
    setPhotoMsg('PHOTO UPDATED!');
  } catch (err) {
    console.warn('[auth] photo upload failed', err);
    setPhotoMsg(err && err.message === 'decode' ? 'COULD NOT READ THAT IMAGE. TRY JPG OR PNG.' : 'COULD NOT SAVE. TRY AGAIN.');
  }
  setPhotoBusy(false);
});

$('photoRemoveBtn').addEventListener('click', async () => {
  setPhotoBusy(true);
  setPhotoMsg('REMOVING...');
  try {
    await applyPhoto(null);
    setPhotoMsg('PHOTO REMOVED.');
  } catch (err) {
    console.warn('[auth] photo remove failed', err);
    setPhotoMsg('COULD NOT SAVE. TRY AGAIN.');
  }
  setPhotoBusy(false);
});

log('auth.js ready');