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
  getFirestore, doc, getDoc, setDoc, runTransaction, serverTimestamp
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
}
updateAccountUI();

function openAccount() {
  if (!profile) { openLogin(); return; }
  renderAvatar($('aAvatar'), profile);
  $('aName').textContent = '#' + profile.username;
  $('aEmail').textContent = profile.email || '';
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

function finishLogin(user, username) {
  profile = { uid: user.uid, username, photoURL: user.photoURL || '', email: user.email || '' };
  lsSet(PROFILE_KEY, JSON.stringify(profile));
  lsSet(MODE_KEY, 'user');
  updateAccountUI();
  ['welcomeModal', 'loginModal', 'nameModal'].forEach(hideModal);
  if (needPush) { needPush = false; schedulePush(); }
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
      finishLogin(user, d.username);
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
    finishLogin(user, name);
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

log('auth.js ready');
