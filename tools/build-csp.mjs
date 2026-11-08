#!/usr/bin/env node
/* INchase: build-csp.mjs
 *
 *   node tools/build-csp.mjs public/index.html > firebase.headers.json
 *
 * Reads index.html, hashes every INLINE <script> (sha256), and prints the "headers" array to merge into
 * firebase.json -> hosting.headers. Re-run it every time you edit an inline script in index.html,
 * because the hashes change with the script text. (Scripts loaded with src="..." need no hash: they are 'self'.)
 *
 * The strict policy ships as Content-Security-Policy-REPORT-ONLY first: it only logs violations in the browser
 * console, nothing breaks. When the console is clean on desktop + phone (login, multiplayer, daily run, PWA offline),
 * change the one line  REPORT_ONLY = true  to false and redeploy.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const REPORT_ONLY = true;
const file = process.argv[2] || 'public/index.html';
const html = readFileSync(file, 'utf8');

const hashes = [];
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html))) {
  const attrs = m[1];
  if (/\bsrc\s*=/.test(attrs)) continue;                                                // external file: covered by 'self'
  if (/type\s*=\s*["'](?!module|text\/javascript)[^"']*["']/i.test(attrs)) continue;    // application/ld+json etc. never executes
  const body = m[2].replace(/\r\n/g, '\n');                                             // browsers hash the LF-normalised text
  if (!body.trim()) continue;
  hashes.push("'sha256-" + createHash('sha256').update(body, 'utf8').digest('base64') + "'");
}

const FIREBASE_CONNECT = [
  'https://*.googleapis.com', 'https://*.firebaseio.com', 'wss://*.firebaseio.com',
  'https://*.firebasedatabase.app', 'wss://*.firebasedatabase.app',
  'https://firestore.googleapis.com', 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com',
  'https://firebaseinstallations.googleapis.com',
  'https://www.google-analytics.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.googletagmanager.com',
  'https://inchase.jhonw3171.workers.dev'                                                // ICE-server worker (mp-config.js)
];

const policy = [
  "default-src 'self'",
  "script-src 'self' " + hashes.join(' ') +
    ' https://cdn.tailwindcss.com https://www.gstatic.com https://www.googletagmanager.com https://www.google.com/recaptcha/',
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",    // Tailwind's CDN build and the game's style="" attributes need inline styles
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleusercontent.com https://www.google-analytics.com https://*.google-analytics.com https://www.gstatic.com",
  "connect-src 'self' " + FIREBASE_CONNECT.join(' '),
  "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com https://www.google.com/recaptcha/ https://recaptcha.google.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

// Always enforced, no risk to the game: nobody can frame it, no plugins, no <base> hijack, no off-site form posts.
const ENFORCED_MIN = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

const common = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  // same-origin-allow-popups keeps the Google sign-in popup working (plain same-origin would break it)
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()' },
  // Report-only phase: the small safe policy is enforced, the full one only reports.
  // Enforce phase: ONE header carrying the full policy (+ frame-ancestors, which report-only mode ignores). No duplicate header names.
  ...(REPORT_ONLY
    ? [{ key: 'Content-Security-Policy', value: ENFORCED_MIN },
       { key: 'Content-Security-Policy-Report-Only', value: policy }]
    : [{ key: 'Content-Security-Policy', value: policy + "; frame-ancestors 'none'" }])
];

const out = [
  { source: '**', headers: common },
  // The service worker and the manifest must never come from the browser's HTTP cache, or fixes reach players late.
  { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
  { source: '/manifest.json', headers: [{ key: 'Cache-Control', value: 'no-cache' }] }
];

console.log(JSON.stringify(out, null, 2));
console.error(`inline scripts hashed: ${hashes.length}   mode: ${REPORT_ONLY ? 'REPORT-ONLY' : 'ENFORCED'}`);
