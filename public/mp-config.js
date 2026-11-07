/* =============================================================================
 * INchase multiplayer: mp-config.js
 *
 * ICE servers (STUN + Metered TURN + ExpressTURN) are NOT stored in the browser. They come from your
 * Cloudflare Worker (worker/worker.js), which only answers players who are logged in to INchase.
 * The game asks it once per session (and again every 45 minutes), then keeps the answer in memory.
 *
 * If the Worker can not be reached the game still works with the public STUN servers below
 * (direct connections only: players behind strict mobile NAT may fail to connect).
 * ========================================================================== */
export const ICE_WORKER_URL = 'https://inchase.jhonw3171.workers.dev/';

export const ICE_STUN_FALLBACK = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.relay.metered.ca:80'
];

// 'all'   = direct first, relay only when needed (recommended)
// 'relay' = ALWAYS relay: hides both players' IP addresses from each other, uses more TURN quota
export const FRIEND_POLICY = 'all';
export const GLOBAL_POLICY = 'all';