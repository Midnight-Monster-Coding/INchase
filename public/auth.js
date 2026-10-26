/* =============================================================================
 * INchase auth + cloud save  (loaded by index.html as <script type="module" src="auth.js">)
 *
 * Responsibilities
 *   1. Login: Google, Email + Password, Email link (passwordless)
 *   2. Username picker (unique, claimed in a Firestore transaction)
 *   3. Account chip (avatar + #username)
 *   4. Cloud save of best score / match history (browser cache stays the fast path)
 *
 * It talks to the game through a one-time private handshake (window.__inchaseLink, defined in index.html,
 * deletes itself on first use). Nothing is left on window, so the browser console cannot reach the
 * score / cloud-save functions. The bridge gives auth.js:
 *   getUid / setUid / getData / setData / resetData / pauseIfPlaying / daily helpers
 * and auth.js hands the game schedulePush / daily / rival / isBusy functions in return.
 *
 * Debugging: run  localStorage.inchase_debug = '1'  in the console and reload
 * to see "[auth]" logs for every step.
 * ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-analytics.js";
import {
  getAuth, onAuthStateChanged, signOut,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, runTransaction, serverTimestamp,
  collection, query, orderBy, limit, where, getDocs, getCountFromServer, writeBatch, onSnapshot, Timestamp
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import {
  getDatabase, ref as dbRef, push as dbPush, set as dbSet, remove as dbRemove,
  onValue as dbOnValue, onDisconnect as dbOnDisconnect, goOffline as dbGoOffline, goOnline as dbGoOnline
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------------------------------------------------------------------------
 * 0. Setup + helpers
 * ------------------------------------------------------------------------ */
const app = initializeApp(firebaseConfig);
isSupported().then((ok) => { if (ok) getAnalytics(app); }).catch(() => {});

const auth = getAuth(app);
const db = getFirestore(app);
let rtdb = null;             // Realtime Database: used only for online / offline presence
try { rtdb = getDatabase(app); } catch (e) { console.warn('[auth] realtime database unavailable', e); }
// Private handshake: the game gives us its bridge once; we give it our API at the bottom of this file.
const App = (typeof window.__inchaseLink === 'function') ? window.__inchaseLink(authApiForGame()) : null;
if (!App) throw new Error('INchase: game bridge unavailable');

const $ = (id) => document.getElementById(id);
const MODE_KEY = 'inchase_mode';                 // 'guest' | 'user'
const PROFILE_KEY = 'inchase_profile_v1';        // cached {uid, username, photoURL, email}
const EMAIL_KEY = 'inchase_email_for_signin';    // remembered between "send link" and "open link"

const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } };

// Installed app (Microsoft Store / PWABuilder / "Install app"): popups and external browser hops are unreliable there.
const IS_APP = (() => {
  try {
    const mq = (q) => window.matchMedia && window.matchMedia(q).matches;
    return mq('(display-mode: standalone)') || mq('(display-mode: window-controls-overlay)') ||
      mq('(display-mode: minimal-ui)') || mq('(display-mode: fullscreen)') ||
      navigator.standalone === true || !!(window.chrome && window.chrome.webview);
  } catch (e) { return false; }
})();

const DEBUG = lsGet('inchase_debug') === '1';
const log = (...a) => { if (DEBUG) console.log('[auth]', ...a); };

const showModal = (id) => { App.pauseIfPlaying(); $(id).classList.remove('hidden'); };
const hideModal = (id) => $(id).classList.add('hidden');
const isOpen = (id) => !$(id).classList.contains('hidden');

// The game checks this so WASD / Space don't move the player while you type.
const authBusy = () => !!document.querySelector('.auth-modal:not(.hidden)');

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
const BOARD_PAGE = 12;       // the live list grows by this many players each time you scroll to its end
const BOARD_MAX = 200;       // never listen to more players than this
const BOARD_TOP = 4;         // rows that are visible at once; your own row is pinned below when you are not among them
const Board = {
  rows: [],                  // [{uid, username, photoURL, best, rank}] in global order
  limit: BOARD_PAGE,         // how many players the live listener currently asks for
  unsub: null,               // detaches the live Firestore listener
  done: false,               // true once the listener returns fewer players than it asked for (or the cap is reached)
  loading: false,            // true until the listener delivers its first result
  error: false,
  loadedAt: 0,               // ms timestamp of the last live result
  myRank: null,              // my global rank from a count query (covers "not in the loaded rows")
  seq: 0,                    // bumped on every (re)subscribe so stale callbacks are ignored
  tab: 'ranks',              // 'ranks' | 'history'
  retryTimer: null,          // reconnect timer after a listener error
  rankTimer: null            // debounce for the rank count query
};
let lastBoardSig = '';       // what the leaderboard doc currently holds (avoids pointless writes)

// Presence (Realtime Database): status/{uid}/{connectionId} = true while a tab is open
const Online = new Set();    // uids that have at least one open connection right now
const Presence = { uid: null, conn: null, unsubInfo: null, unsubAll: null };

// Player card + name hover card (declared here because renderBoard() runs at startup, before section 8)
let playerCardUid = null;    // uid shown in the player card (null = closed)
let tipFor = null;           // name element the hover card is currently showing for

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
  applyOnline();
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
  try {
    await stopPresence();      // go offline while we are still allowed to write
    await signOut(auth);
  } catch (e) { toast('SIGN OUT FAILED'); }
});

/* ---------------------------------------------------------------------------
 * 3. Welcome + login modals
 * ------------------------------------------------------------------------ */
const AUTH_BUTTONS = ['googleBtn', 'emailLoginBtn', 'emailSignupBtn', 'emailLinkBtn', 'linkFinishBtn', 'forgotBtn'];
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
    case 'auth/popup-blocked': return 'POPUP BLOCKED. TAP GOOGLE AGAIN.';
    case 'auth/web-storage-unsupported': return 'THIS WINDOW BLOCKS LOGIN STORAGE. USE EMAIL LOGIN.';
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
// Installed app: go straight to redirect (a popup can hang or open in the default browser and never report back).
// Browser tab: popup first, redirect as the fallback.
$('googleBtn').addEventListener('click', () => run('google', async () => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  if (IS_APP) {
    setMsg('OPENING GOOGLE LOGIN...');
    const rescue = setTimeout(() => { setAuthBusy(false); setMsg('GOOGLE DID NOT OPEN. TAP GOOGLE AGAIN OR USE EMAIL.'); }, 20000);
    try { await signInWithRedirect(auth, provider); } catch (err) { clearTimeout(rescue); throw err; }
    return;
  }
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    const code = err && err.code;
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment' || code === 'auth/web-storage-unsupported') {
      await signInWithRedirect(auth, provider);   // page leaves; result is picked up on return
      return;
    }
    throw err;
  }
}));

// Back from a Google redirect: onAuthStateChanged does the sign-in itself; this only surfaces a failure.
getRedirectResult(auth).catch((err) => { toast(explain(err)); });

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
  setMsg('LOGIN LINK SENT (CHECK SPAM). IF IT OPENS IN YOUR BROWSER, COPY THE LINK AND PASTE IT BELOW.');
}));

let lastLinkTried = '';
// Finishes a login from an email link. `href` is the opened page URL, a launch URL handed over by the OS,
// or a link pasted by the player. Returns true when a sign-in was attempted.
async function completeEmailLink(href, typedEmail) {
  if (completingLink || !href || href === lastLinkTried) return false;
  if (!isSignInWithEmailLink(auth, href)) return false;
  lastLinkTried = href;
  completingLink = true;
  log('finishing email-link login');
  let email = typedEmail || lsGet(EMAIL_KEY);
  if (!email) { try { email = window.prompt('ENTER THE EMAIL YOU REQUESTED THE LINK WITH'); } catch (e) { email = null; } }
  if (!email) {
    // opened on another device, or this window cannot show prompts: let the player type it in the login box
    completingLink = false;
    lastLinkTried = '';
    openLogin();
    $('linkInput').value = href;
    setMsg('TYPE YOUR EMAIL ABOVE, THEN TAP FINISH LOGIN.');
    return false;
  }
  try {
    await signInWithEmailLink(auth, email.trim(), href);
    lsDel(EMAIL_KEY);
    $('linkInput').value = '';
  } catch (err) {
    lastLinkTried = '';
    toast(explain(err));
  }
  completingLink = false;
  if (href === location.href) history.replaceState(null, '', location.pathname);   // remove the one-time code from the address bar
  return true;
}
const completeEmailLinkIfPresent = () => completeEmailLink(location.href);

// Installed app: when the OS hands a clicked email link to the already-open app window, finish the login here.
if ('launchQueue' in window && window.launchQueue && typeof window.launchQueue.setConsumer === 'function') {
  window.launchQueue.setConsumer((p) => { if (p && p.targetURL) completeEmailLink(p.targetURL); });
}

// Player pasted the link from the email (works even when the email link opened in the browser instead of the app)
$('linkFinishBtn').addEventListener('click', () => run('email-link-paste', async () => {
  const email = readEmail(); if (!email) return;
  const link = $('linkInput').value.trim();
  if (!link || !isSignInWithEmailLink(auth, link)) { setMsg('THAT IS NOT A LOGIN LINK. COPY THE WHOLE LINK FROM THE EMAIL.'); return; }
  await signInWithEmailLink(auth, email, link);
  lsDel(EMAIL_KEY);
  $('linkInput').value = '';
}));

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
  // Keep the public leaderboard entry in step with the private save (the live listener updates the list itself).
  const boardChanged = await pushBoard(false);
  if (boardChanged) updateMyRank();
}
function schedulePush() {
  if (!currentUser || !profile || profile.uid !== currentUser.uid) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 800);
}
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
  startPresence();
  ['welcomeModal', 'loginModal', 'nameModal'].forEach(hideModal);
  if (needPush) { needPush = false; schedulePush(); }
  syncBoardAfterLogin();
  dailyAfterLogin();
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
      startPresence();
      startBoardLive();
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
    stopPresence();
    updateAccountUI();
    hideModal('nameModal');
    hideModal('accountModal');
    closePlayerCard();
    const mode = lsGet(MODE_KEY);
    if (!mode && !completingLink) { await splashDone; if (!currentUser && !completingLink && !isOpen('loginModal')) openWelcome(); }
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
  if (isOpen('playerModal')) closePlayerCard();
  else if (isOpen('accountModal')) hideModal('accountModal');
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

// Left leaderboard panel: only for logged-in players, not on phones, and only when there is room beside the game box.
function sideWanted() {
  return !!profile && !document.documentElement.classList.contains('mob') && window.innerWidth >= 1100;
}
function updateSideMode() {
  const side = sideWanted();
  document.documentElement.classList.toggle('lb-side', side);
  return side;
}
// How many rows fit in a list before its owner has to scroll (the pinned "me" row is always reserved for)
function visibleRows(root, list) {
  if (root.dataset.lb !== 'side') return BOARD_TOP;
  const cs = getComputedStyle(list);
  const row = parseFloat(cs.getPropertyValue('--lb-row')) || 54;
  const gap = parseFloat(cs.getPropertyValue('--lb-gap')) || 9;
  const room = root.clientHeight - (row + 22);
  return Math.max(3, Math.floor((room + gap) / (row + gap)));
}
function syncSideMode() {
  if (document.documentElement.classList.contains('lb-side') !== sideWanted()) applyBoardUI();
  else if (sideWanted()) renderBoard();   // panel height changed: re-check which rows are visible
}
window.addEventListener('resize', syncSideMode);
window.addEventListener('orientationchange', () => setTimeout(syncSideMode, 150));
if (document.readyState === 'complete') syncSideMode(); else window.addEventListener('load', syncSideMode);

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
  startBoardLive();
}

function resetBoard() {
  dailyReset();
  Board.seq++;
  stopBoardLive();
  Board.rows = [];
  Board.limit = BOARD_PAGE;
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
async function findRival(score) {
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
}

// --- live leaderboard: a Firestore listener on the top `Board.limit` players ---
function stopBoardLive() {
  if (Board.unsub) { try { Board.unsub(); } catch (e) { /* ignore */ } Board.unsub = null; }
  clearTimeout(Board.retryTimer);
  Board.retryTimer = null;
  clearTimeout(Board.rankTimer);
  Board.rankTimer = null;
}

// (Re)subscribes with the current limit. Every change anywhere on the board arrives here by itself.
function startBoardLive() {
  if (!currentUser || !profile) return;
  if (Board.unsub) { try { Board.unsub(); } catch (e) { /* ignore */ } Board.unsub = null; }
  clearTimeout(Board.retryTimer);
  Board.retryTimer = null;
  const seq = ++Board.seq;
  Board.loading = true;
  Board.error = false;
  renderBoard();
  const q = query(collection(db, 'leaderboard'), orderBy('best', 'desc'), limit(Board.limit));
  Board.unsub = onSnapshot(q, (snap) => {
    if (seq !== Board.seq) return;
    Board.rows = [];
    addRows(snap.docs);
    Board.done = snap.docs.length < Board.limit || Board.limit >= BOARD_MAX;
    Board.loading = false;
    Board.error = false;
    Board.loadedAt = Date.now();
    renderBoard();
    updateMyRank();
  }, (err) => {
    console.warn('[auth] leaderboard listener failed', err);
    if (seq !== Board.seq) return;
    Board.unsub = null;
    Board.loading = false;
    Board.error = true;
    renderBoard();
    clearTimeout(Board.retryTimer);
    Board.retryTimer = setTimeout(startBoardLive, 6000);   // try again by itself
  });
}

// Scrolled to the end of a list: listen to a few more players
function growBoard() {
  if (!currentUser || !profile || Board.loading || Board.done || Board.error) return;
  if (Board.limit >= BOARD_MAX) return;
  Board.limit = Math.min(BOARD_MAX, Board.limit + BOARD_PAGE);
  startBoardLive();
}

// My global rank when I am not among the loaded rows (one cheap count query, debounced)
function updateMyRank() {
  clearTimeout(Board.rankTimer);
  Board.rankTimer = null;
  if (!currentUser || !profile) return;
  const myUid = currentUser.uid;
  if (Board.rows.some((r) => r.uid === myUid)) return;     // the rows already tell my rank
  const seq = Board.seq;
  Board.rankTimer = setTimeout(async () => {
    Board.rankTimer = null;
    const rank = await fetchMyRank();
    if (seq !== Board.seq || !currentUser || !profile) return;
    if (rank != null && rank !== Board.myRank) { Board.myRank = rank; renderBoard(); }
  }, 1200);
}

// --- presence: who is online right now (Realtime Database) ---
// Every open tab writes status/{uid}/{its own id} = true and registers an onDisconnect remove, so the SERVER
// deletes it when the tab closes, the phone loses signal or the browser crashes. A player is online while their
// status/{uid} node has at least one child (this also keeps them online when one of two tabs is closed).
function startPresence() {
  if (!rtdb || !currentUser || !profile) return;
  if (Presence.uid === currentUser.uid && Presence.unsubInfo) return;   // already running for this account
  stopPresence();
  const uid = currentUser.uid;
  Presence.uid = uid;
  try {
    const connRef = dbPush(dbRef(rtdb, 'status/' + uid));               // new unique id for THIS tab (nothing written yet)
    Presence.conn = connRef;
    // .info/connected flips true on every (re)connect, so presence heals itself after a network drop
    Presence.unsubInfo = dbOnValue(dbRef(rtdb, '.info/connected'), (snap) => {
      if (snap.val() !== true || Presence.conn !== connRef) return;
      // Register the server-side cleanup first, then mark online: an "online" mark can never be left behind
      dbOnDisconnect(connRef).remove()
        .then(() => (Presence.conn === connRef ? dbSet(connRef, true) : null))
        .then(() => log('presence online'))
        .catch((e) => console.warn('[auth] presence write failed', e));
    });
    Presence.unsubAll = dbOnValue(dbRef(rtdb, 'status'), (snap) => {
      Online.clear();
      snap.forEach((child) => { if (child.hasChildren()) Online.add(child.key); });
      applyOnline();
    }, (err) => console.warn('[auth] presence read failed', err));
    sweepOrphans(uid);   // remove any mark an earlier sign-out / network drop failed to delete
  } catch (e) {
    console.warn('[auth] presence unavailable', e);
  }
}

// Marks whose removal was NOT confirmed by the server (offline sign-out, token already gone...).
// They are remembered on this device and deleted the next time this account is signed in.
const ORPHAN_KEY = 'inchase_presence_orphans_v1';
function orphanList() { try { const a = JSON.parse(lsGet(ORPHAN_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function orphanSave(a) { if (a.length) lsSet(ORPHAN_KEY, JSON.stringify(a.slice(-20))); else lsDel(ORPHAN_KEY); }
function orphanAdd(path) { const a = orphanList(); if (!a.includes(path)) { a.push(path); orphanSave(a); } }
function orphanDrop(path) { orphanSave(orphanList().filter((x) => x !== path)); }
function sweepOrphans(uid) {
  if (!rtdb) return;
  orphanList().filter((path) => path.startsWith('status/' + uid + '/')).forEach((path) => {
    dbRemove(dbRef(rtdb, path)).then(() => orphanDrop(path)).catch((e) => console.warn('[auth] orphan sweep failed', e));
  });
}
// Makes the server notice this client is gone, so it runs the onDisconnect cleanup we registered earlier.
function bounceRealtime() {
  if (!rtdb) return;
  try { dbGoOffline(rtdb); setTimeout(() => { try { dbGoOnline(rtdb); } catch (e) { /* ignore */ } }, 1500); } catch (e) { /* ignore */ }
}

// Goes offline. Called BEFORE signOut(): after sign-out the rules would no longer let us delete our mark.
// Returns true when the server confirmed the mark is gone.
async function stopPresence() {
  const c = Presence.conn;
  if (Presence.unsubInfo) { try { Presence.unsubInfo(); } catch (e) { /* ignore */ } Presence.unsubInfo = null; }
  if (Presence.unsubAll) { try { Presence.unsubAll(); } catch (e) { /* ignore */ } Presence.unsubAll = null; }
  Presence.conn = null;
  Presence.uid = null;
  Online.clear();
  applyOnline();
  if (!c) return true;
  let confirmed = false;
  try {
    // offline: do not hold up the sign-out waiting for the server
    confirmed = await Promise.race([dbRemove(c).then(() => true), new Promise((res) => setTimeout(() => res(false), 2000))]);
  } catch (e) { confirmed = false; }   // e.g. permission denied because we are already signed out
  if (confirmed) {
    // Only now is it safe to drop the server-side cleanup. If the remove was NOT confirmed we KEEP the onDisconnect
    // (cancelling it here is what used to leave a user "online" forever) and remember the mark for a later sweep.
    try { dbOnDisconnect(c).cancel().catch(() => {}); } catch (e) { /* ignore */ }
  } else {
    try { orphanAdd('status/' + c.parent.key + '/' + c.key); } catch (e) { /* ignore */ }
    bounceRealtime();
  }
  return confirmed;
}

// Green glow on every online player's avatar (leaderboard rows, footer chip, account photo) + the online counter
function applyOnline() {
  document.querySelectorAll('.lb-row[data-uid]').forEach((row) => {
    const av = row.querySelector('.lb-av');
    if (av) av.classList.toggle('online', Online.has(row.dataset.uid));
  });
  // the glow lives in the leaderboard only (and on a player's own card), never on my own footer chip / account photo
  const card = $('pAvatar');
  if (card && playerCardUid) card.classList.toggle('online', Online.has(playerCardUid));
  const n = $('onlineCount');
  if (n) n.textContent = String(Online.size);
}

// --- drawing ---
function buildRow(rank, p, isMe) {
  const row = document.createElement('div');
  row.className = 'lb-row' + (isMe ? ' me' : '');
  row.dataset.uid = p.uid || '';
  row.setAttribute('role', 'listitem');

  const r = document.createElement('span');
  r.className = 'lb-rank tabular-nums' + (rank <= 3 ? ' r' + rank : '') + (rank >= 1000 ? ' long' : '');
  r.textContent = String(rank);

  const av = document.createElement('span');
  av.className = 'chip-avatar lb-av' + (p.uid && Online.has(p.uid) ? ' online' : '');
  renderAvatar(av, p);

  const n = document.createElement('span');
  n.className = 'lb-name' + (isMe ? '' : ' lb-link');   // other players' names are clickable (player card)
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

  boardRoots().forEach((root) => {
    const list = root.querySelector('.lb-list');
    const me = root.querySelector('.lb-me');
    if (!list || !me) return;
    const inTop = idx > -1 && idx < visibleRows(root, list);
    const showMe = !!profile && myRank != null && !inTop;
    const keep = list.scrollTop;               // appending a page must not throw the scroll position back to the top
    list.textContent = '';
    me.textContent = '';
    if (!profile) { me.classList.add('lb-off'); return; }

    if (rows.length) {
      rows.forEach((r) => list.appendChild(buildRow(r.rank, r, r.uid === myUid)));
      if (Board.error) list.appendChild(buildNote('CONNECTION LOST. RECONNECTING...'));
      else if (Board.loading && !Board.done) list.appendChild(buildNote('LOADING...'));
    } else if (Board.error) {
      list.appendChild(buildNote('CONNECTION LOST. RECONNECTING...'));
    } else if (Board.loading || !Board.loadedAt) {
      list.appendChild(buildNote('LOADING...'));
    } else {
      list.appendChild(buildNote('NO PLAYERS YET.'));
    }
    list.scrollTop = keep;

    if (showMe) {
      me.appendChild(buildRow(myRank, { uid: profile.uid, username: profile.username, photoURL: profile.photoURL, best: boardBest() }, true));
      me.classList.remove('lb-off');
    } else {
      me.classList.add('lb-off');
    }
  });
  if (tipFor && !document.body.contains(tipFor)) hideTip();   // the hovered name was just redrawn
  refreshPlayerCard();                                         // keep an open player card live
}

// --- hover card: the full name pops up above a name you point at ---
function showTip(n) {
  const tip = $('lbTip');
  if (!tip) return;
  tip.textContent = n.textContent;
  tipFor = n;
  const r = n.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.max(8, Math.min(r.left - 6, window.innerWidth - w - 8));
  let top = r.top - h - 12;
  const below = top < 8;                       // no room above: pop up underneath instead
  if (below) top = r.bottom + 12;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
  tip.classList.toggle('below', below);
  tip.classList.add('show');
}
function hideTip() {
  tipFor = null;
  const tip = $('lbTip');
  if (tip) tip.classList.remove('show');
}
document.addEventListener('mouseover', (e) => {
  const n = e.target && e.target.closest ? e.target.closest('.lb-name') : null;
  if (n && n !== tipFor) showTip(n);
});
document.addEventListener('mouseout', (e) => {
  const n = e.target && e.target.closest ? e.target.closest('.lb-name') : null;
  if (n && !(e.relatedTarget && n.contains(e.relatedTarget))) hideTip();
});
window.addEventListener('scroll', hideTip, true);   // capture: also fires for the scrolling lists

// --- player card: click another player's name to see their profile ---
function fillPlayerCard(r) {
  const av = $('pAvatar');
  renderAvatar(av, r);
  av.classList.toggle('online', Online.has(r.uid));
  $('pName').textContent = '#' + r.username;
  $('pBest').textContent = (Number(r.best) || 0).toLocaleString();
  $('pRank').textContent = String(r.rank);
}
function openPlayerCard(uid) {
  const r = Board.rows.find((x) => x.uid === uid);
  if (!r) return;
  playerCardUid = uid;
  fillPlayerCard(r);
  showModal('playerModal');
}
function refreshPlayerCard() {
  if (!playerCardUid || !isOpen('playerModal')) return;
  const r = Board.rows.find((x) => x.uid === playerCardUid);
  if (r) fillPlayerCard(r);
}
function closePlayerCard() {
  playerCardUid = null;
  hideModal('playerModal');
}
$('playerCloseBtn').addEventListener('click', closePlayerCard);
$('playerModal').addEventListener('click', (e) => { if (e.target === $('playerModal')) closePlayerCard(); });
document.addEventListener('click', (e) => {
  const n = e.target && e.target.closest ? e.target.closest('.lb-name.lb-link') : null;
  if (!n || !profile) return;
  const row = n.closest('.lb-row');
  if (!row || !row.dataset.uid) return;
  hideTip();
  openPlayerCard(row.dataset.uid);
});

// Show / hide the leaderboard pieces depending on login state and the selected tab.
function applyBoardUI() {
  const on = !!profile;
  const side = updateSideMode();     // wide screen + logged in: the ranks live in the left panel
  const tabsOn = on && !side;        // otherwise they stay in the points board (RANKS / HISTORY tabs)
  const ranks = tabsOn && Board.tab === 'ranks';
  $('board').classList.toggle('has-tabs', tabsOn);
  $('boardTabs').classList.toggle('lb-off', !tabsOn);
  $('rankPane').classList.toggle('lb-off', !ranks);
  $('historyPane').classList.toggle('lb-off', ranks);
  $('tabRanks').classList.toggle('active', Board.tab === 'ranks');
  $('tabHistory').classList.toggle('active', Board.tab === 'history');
  $('lbModalBox').classList.toggle('lb-off', !on);
  renderBoard();
}

$('tabRanks').addEventListener('click', () => { Board.tab = 'ranks'; applyBoardUI(); });
$('tabHistory').addEventListener('click', () => { Board.tab = 'history'; applyBoardUI(); });

// The list is live (no refresh button). Scrolling near the end of a list makes it listen to a few more players.
boardRoots().forEach((root) => {
  const list = root.querySelector('.lb-list');
  if (!list) return;
  list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 30) growBoard();
  }, { passive: true });
});

// Coming back to the tab: make sure the live listener is running (it may have dropped while the tab slept)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser && profile && !Board.unsub) startBoardLive();
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
  applyOnline();           // the avatar element was redrawn: keep its glow
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

/* ---------------------------------------------------------------------------
 * 9. Daily Run ranks (Firestore: daily/{dayNumber}/entries/{uid})
 *
 *  - Every UTC day has its own collection path, so at midnight the board is simply a new, empty one:
 *    nothing has to be deleted for "yesterday's scores" to disappear from view. A Firestore TTL policy on
 *    the `expireAt` field removes the old documents by itself later (see the notes in firestore.rules).
 *  - A score is written ONCE. The rules allow create only (no update, no delete), the day in the path must
 *    be today by the SERVER clock, and the name must match the private profile. So nobody can edit or
 *    remove a posted score, or post one for another day / another player.
 *  - index.html talks to this section through the private handshake API (see authApiForGame): isLoggedIn / status / openRanks / submit.
 * ------------------------------------------------------------------------ */
const DAILY_TOP = 50;                // players loaded (the list scrolls inside its box)
const DAILY_PIN_AFTER = 5;           // my own row is pinned under the list when I am not among the first rows
const Dly = {
  state: 'idle',                     // my score for today: 'idle' | 'posting' | 'ranked' | 'failed'
  day: null,                         // day number that state belongs to
  rank: null,                        // my rank today
  err: '',                           // last Firebase error code for the post (shown on the result card)
  rankAt: 0,                         // when that rank was read
  busy: null,                        // in-flight submit promise
  rows: [], loading: false, error: false, slow: false,
  unsub: null, seq: 0, viewDay: null, tick: null, slowTimer: null
};

const dailyPhotos = new Map();       // uid -> photo (data URL or https) read from the public leaderboard entry

// Daily entries only keep short https photos (rules: <= 600 chars). Uploaded avatars are big data URLs,
// so for rows with no photo we read the player's public leaderboard entry, which can hold them.
function fillDailyPhotos(seq) {
  const missing = Dly.rows.filter((r) => !r.photoURL && !dailyPhotos.has(r.uid));
  Dly.rows.forEach((r) => { if (!r.photoURL && dailyPhotos.get(r.uid)) r.photoURL = dailyPhotos.get(r.uid); });
  if (!missing.length) return;
  Promise.all(missing.map((r) =>
    getDoc(doc(db, 'leaderboard', r.uid))
      .then((s) => { dailyPhotos.set(r.uid, s.exists() && typeof (s.data() || {}).photoURL === 'string' ? s.data().photoURL : ''); })
      .catch(() => {})
  )).then(() => {
    if (seq !== Dly.seq) return;
    Dly.rows.forEach((r) => { if (!r.photoURL && dailyPhotos.get(r.uid)) r.photoURL = dailyPhotos.get(r.uid); });
    renderDaily();
  });
}

const dailyOk = () => !!(currentUser && profile && profile.uid === currentUser.uid);
const dailyRef = (day, uid) => doc(db, 'daily', String(day), 'entries', uid);
const dailyCol = (day) => collection(db, 'daily', String(day), 'entries');

async function fetchDailyRank(day, score) {
  const snap = await getCountFromServer(query(dailyCol(day), where('score', '>', score)));
  return snap.data().count + 1;
}

// Post today's finished run. Safe to call again: it never overwrites an entry that already exists.
function submitDaily() {
  if (Dly.busy) return Dly.busy;
  if (!dailyOk()) return Promise.resolve();
  const rec = App.getDaily();
  if (!rec || !rec.done) return Promise.resolve();
  const day = rec.day;
  const uid = currentUser.uid;
  Dly.day = day;
  Dly.state = 'posting';
  Dly.err = '';
  Dly.busy = (async () => {
    try {
      const ref = dailyRef(day, uid);
      const snap = await getDoc(ref);
      let score;
      if (snap.exists()) {
        score = Number((snap.data() || {}).score) || 0;        // already posted (earlier try or another device)
      } else {
        score = Math.max(0, Math.floor(Number(rec.score) || 0));
        const photo = typeof profile.photoURL === 'string' && /^https?:/.test(profile.photoURL) && profile.photoURL.length <= 600 ? profile.photoURL : '';
        await setDoc(ref, {
          username: profile.username,
          usernameLower: profile.username.toLowerCase(),
          photoURL: photo,
          score,
          wave: Math.max(1, Math.floor(Number(rec.wave) || 1)),
          grid: String(rec.grid || '').replace(/[^GYR]/g, '').slice(0, 60),
          day,
          createdAt: serverTimestamp(),
          expireAt: Timestamp.fromMillis((day + 3) * 86400000)   // the TTL policy deletes the document after this
        });
      }
      App.markDailySubmitted();
      Dly.state = 'ranked';
      try { Dly.rank = await fetchDailyRank(day, score); Dly.rankAt = Date.now(); } catch (e) { Dly.rank = null; }
    } catch (e) {
      console.warn('[auth] daily post failed', e && e.code, e);
      Dly.err = (e && e.code) ? String(e.code).replace('firestore/', '') : 'unknown';
      Dly.state = 'failed';
    } finally {
      Dly.busy = null;
    }
  })();
  return Dly.busy;
}

// What the result card asks for: { state: 'ranked' | 'failed' | 'idle', rank }
async function dailyStatus() {
  if (Dly.busy) await Dly.busy;
  const rec = App.getDaily();
  if (!dailyOk() || !rec || !rec.done) return { state: 'idle' };
  if (Dly.state === 'failed' && Dly.day === rec.day) return { state: 'failed', code: Dly.err };
  if (Dly.state !== 'ranked' || Dly.day !== rec.day) {
    await submitDaily();
  } else if (Date.now() - Dly.rankAt > 30000) {
    try { Dly.rank = await fetchDailyRank(rec.day, Number(rec.score) || 0); Dly.rankAt = Date.now(); } catch (e) { /* keep the old rank */ }
  }
  if (Dly.state === 'ranked' && Dly.day === rec.day) return { state: 'ranked', rank: Dly.rank };
  return Dly.state === 'failed' ? { state: 'failed', code: Dly.err } : { state: 'idle' };
}

// After login: post a finished run that was waiting for a login, or pick up today's run played on another device
async function dailyAfterLogin() {
  if (!dailyOk()) return;
  const rec = App.getDaily();
  if (rec && rec.done) { await submitDaily(); App.dailyChanged(); return; }
  if (rec && rec.started) { App.dailyChanged(); return; }   // a run is going on (or was left) on this device
  try {
    const day = App.dayNum();
    const snap = await getDoc(dailyRef(day, currentUser.uid));
    if (!snap.exists()) { App.dailyChanged(); return; }   // refresh the card: it is unlocked now
    const x = snap.data() || {};
    App.setDaily({ day, started: true, done: true, score: Number(x.score) || 0, wave: Number(x.wave) || 1, grid: String(x.grid || 'R'), submitted: true });
    App.dailyChanged();
  } catch (e) { log('daily pickup failed', e); }
}

function dailyReset() {
  closeDailyRanks();
  try { App.dailyChanged(); } catch (e) { /* ignore */ }   // logged out: the daily card locks again
  Dly.state = 'idle';
  Dly.day = null;
  Dly.rank = null;
  Dly.busy = null;
}

// A failed post tries again by itself when the connection is back or the tab is shown again
function dailyRetry() {
  if (Dly.state === 'failed' && dailyOk()) submitDaily().then(() => App.dailyChanged());
}
window.addEventListener('online', dailyRetry);
document.addEventListener('visibilitychange', () => { if (!document.hidden) dailyRetry(); });

// --- ranks window ---
function buildDailyRow(rank, p, isMe) {
  const row = buildRow(rank, p, isMe);
  const n = row.querySelector('.lb-name');
  if (n) n.classList.remove('lb-link');                // no player card from daily rows
  return row;
}

function renderDaily() {
  const list = $('dailyList');
  const me = $('dailyMe');
  if (!list || !me) return;
  const myUid = currentUser ? currentUser.uid : null;
  const rec = App.getDaily();
  const idx = myUid ? Dly.rows.findIndex((r) => r.uid === myUid) : -1;
  const keep = list.scrollTop;
  list.textContent = '';
  me.textContent = '';

  const offline = navigator.onLine === false || Dly.slow || Dly.error;
  if (Dly.rows.length) {
    Dly.rows.forEach((r) => list.appendChild(buildDailyRow(r.rank, r, r.uid === myUid)));
  } else if (offline) {
    list.appendChild(buildNote('RANKS NEED AN INTERNET CONNECTION.'));
  } else if (Dly.loading) {
    list.appendChild(buildNote('LOADING...'));
  } else {
    list.appendChild(buildNote('NO SCORES YET TODAY. BE THE FIRST!'));
  }
  list.scrollTop = keep;

  // my own row, pinned below the list when I am not near the top
  const played = !!(rec && rec.done && dailyOk());
  const myRank = idx > -1 ? Dly.rows[idx].rank : (Dly.state === 'ranked' ? Dly.rank : null);
  if (played && myRank != null && !(idx > -1 && idx < DAILY_PIN_AFTER)) {
    me.appendChild(buildDailyRow(myRank, { uid: profile.uid, username: profile.username, photoURL: profile.photoURL, best: Number(rec.score) || 0 }, true));
    me.classList.remove('lb-off');
  } else {
    me.classList.add('lb-off');
  }
}

function updateDailySub() {
  const sub = $('dailySub');
  if (sub) sub.textContent = 'DAILY #' + App.dailyNumber() + ' \u00B7 RESETS IN ' + App.dailyTimeLeft();
}

function stopDailyLive() {
  if (Dly.unsub) { try { Dly.unsub(); } catch (e) { /* ignore */ } Dly.unsub = null; }
  clearTimeout(Dly.slowTimer);
  Dly.slowTimer = null;
}

function startDailyLive() {
  stopDailyLive();
  const seq = ++Dly.seq;
  const day = App.dayNum();
  Dly.viewDay = day;
  Dly.rows = [];
  Dly.loading = true;
  Dly.error = false;
  Dly.slow = false;
  renderDaily();
  // offline, Firestore just waits quietly: after a few seconds say so instead of "LOADING..." forever
  Dly.slowTimer = setTimeout(() => { if (seq === Dly.seq && Dly.loading) { Dly.slow = true; renderDaily(); } }, 7000);
  Dly.unsub = onSnapshot(query(dailyCol(day), orderBy('score', 'desc'), limit(DAILY_TOP)), (snap) => {
    if (seq !== Dly.seq) return;
    const rows = [];
    snap.docs.forEach((d) => {
      const x = d.data() || {};
      const score = Number(x.score) || 0;
      const prev = rows[rows.length - 1];
      rows.push({
        uid: d.id,
        username: String(x.username || '?'),
        photoURL: typeof x.photoURL === 'string' ? x.photoURL : '',
        best: score,
        rank: prev && prev.best === score ? prev.rank : rows.length + 1      // ties share a rank
      });
    });
    Dly.rows = rows;
    Dly.loading = false;
    Dly.error = false;
    Dly.slow = false;
    fillDailyPhotos(seq);
    renderDaily();
    // I played but I am below the loaded rows: look up my rank
    const rec = App.getDaily();
    if (dailyOk() && rec && rec.done && !rows.some((r) => r.uid === currentUser.uid) && Dly.state !== 'posting') {
      dailyStatus().then(() => { if (seq === Dly.seq) renderDaily(); });
    }
  }, (err) => {
    console.warn('[auth] daily ranks listener failed', err);
    if (seq !== Dly.seq) return;
    Dly.unsub = null;
    Dly.loading = false;
    Dly.error = true;
    renderDaily();
  });
}

function openDailyRanks() {
  if (!dailyOk()) {
    toast("LOGIN TO SEE TODAY'S RANKS");
    openWelcome();
    return;
  }
  showModal('dailyModal');
  updateDailySub();
  startDailyLive();
  clearInterval(Dly.tick);
  Dly.tick = setInterval(() => {
    if (!isOpen('dailyModal')) { closeDailyRanks(); return; }
    updateDailySub();
    if (App.dayNum() !== Dly.viewDay) startDailyLive();   // midnight passed with the window open: a new, empty board
  }, 1000);
}

function closeDailyRanks() {
  clearInterval(Dly.tick);
  Dly.tick = null;
  stopDailyLive();
  hideModal('dailyModal');
}

$('dailyCloseBtn').addEventListener('click', closeDailyRanks);
$('dailyModal').addEventListener('click', (e) => { if (e.target === $('dailyModal')) closeDailyRanks(); });
window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && isOpen('dailyModal')) closeDailyRanks(); });


log('auth.js ready');

// What the game receives in the handshake (hoisted, so it exists when the handshake runs at the top of the file)
function authApiForGame() {
  return {
    schedulePush,
    isLoggedIn: () => dailyOk(),      // arrow wrappers: dailyOk / authBusy are consts defined later in this file
    status: dailyStatus,
    submit: submitDaily,
    openRanks: openDailyRanks,
    openLogin: openWelcome,
    findRival,
    isBusy: () => authBusy()
  };
}