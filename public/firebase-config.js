// Firebase web config for the INchase project.
// (These values are public identifiers, not secrets. Access is controlled by Firebase Auth + firestore.rules + database.rules.)
export const firebaseConfig = {
  apiKey: "AIzaSyB4XrRiVfKwBB0vpNQVp3owB4kIdcpX9Q0",
  authDomain: "inchase.web.app",   // same origin as the site: redirect + email-link login work in the installed app
  // Realtime Database (online/offline presence). Singapore region, copied from Firebase console > Realtime Database > Data.
  databaseURL: "https://inchase-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "inchase",
  storageBucket: "inchase.firebasestorage.app",
  messagingSenderId: "899688378990",
  appId: "1:899688378990:web:0e9e0f583cf38686ef6c7f",
  measurementId: "G-V9ETESWC9E"
};

// Firebase App Check (anti-abuse). Create a reCAPTCHA v3 key for inchase.web.app, register it in
// Firebase console > App Check, paste the SITE key here, then enforce it for Firestore / Realtime Database / Auth.
// Leave it empty to keep App Check off. (A site key is public by design; the secret key never goes in this file.)
export const appCheckSiteKey = '';