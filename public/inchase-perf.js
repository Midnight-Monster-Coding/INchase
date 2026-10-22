/*! inchase-perf.js — INchase adaptive performance engine (Developed by IAB)

   Load this as a plain <script src="inchase-perf.js"></script> in <head>,
   BEFORE the main game script. It needs no changes to the game code.

   What it does
   1. Picks a starting quality tier from CPU cores, RAM, GPU name hint, Save-Data and battery.
   2. Measures real frame times while the game runs and moves between 3 tiers
      (Low / Balanced / Ultra): drops fast when struggling, climbs slowly when smooth,
      backs off if a climb fails, so it never flaps.
   3. Never caps FPS. The game keeps using requestAnimationFrame, so a 120/144 Hz
      display gets 120/144 fps whenever the device can sustain it.
   4. Watches network hints (online/offline, Save-Data, slow connection) and publishes them.

   How it hooks in without touching the game
   - devicePixelRatio : the game reads it in resizeCanvas(); we return min(real, tier cap).
   - shadowBlur       : the 2D context's glow strength is scaled by the tier (0 = no glow).
   - getContext       : the game canvas gets {alpha:false} (add ?perfdesync=1 to test desynchronized).
   - requestAnimationFrame : wrapped only to read frame timestamps (nothing is throttled).

   Testing
   - ?perf=low | balanced | ultra   lock a tier (no auto-adapting)
   - ?perf=auto                     forget the saved tier and auto-detect again
   - ?perfhud=1                     small on-screen readout (tier, fps, refresh rate, GPU)
   - window.INchasePerf             runtime API (see bottom of file)
*/
(function () {
  'use strict';
  if (window.INchasePerf) return;

  var root = document.documentElement;
  var STORE_KEY = 'inchase_perf_v1';

  /* ---------------------------------------------------------------------------
   * Quality profiles. Gameplay (speed, scoring, collisions) never depends on these.
   * ------------------------------------------------------------------------- */
  var PROFILES = [
    { name: 'Low',      dprCap: 1,   glow: 0,   particles: 160, scanlines: false },
    { name: 'Balanced', dprCap: 1.5, glow: 0.5, particles: 350, scanlines: true  },
    { name: 'Ultra',    dprCap: 2,   glow: 1,   particles: 512, scanlines: true  }
  ];

  /* ---------------------------------------------------------------------------
   * Small helpers
   * ------------------------------------------------------------------------- */
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function byNum(a, b) { return a - b; }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function loadSaved() {
    try {
      var v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      // A saved tier only counts for 24 h, so one bad session (background download, low battery) cannot stick forever.
      if (v && typeof v.tier === 'number' && v.tier >= 0 && v.tier <= 2 &&
          typeof v.ts === 'number' && Date.now() - v.ts < 86400000) return v.tier | 0;
    } catch (e) {}
    return null;
  }
  function saveTier(t) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ tier: t, ts: Date.now() })); } catch (e) {}
  }
  function clearSaved() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  // Common display refresh intervals (ms): 240, 180, 165, 144, 120, 90, 75, 60 Hz
  var STD_MS = [4.17, 5.56, 6.06, 6.94, 8.33, 11.11, 13.33, 16.67];
  function snapMs(ms) {
    for (var i = 0; i < STD_MS.length; i++) {
      if (Math.abs(ms - STD_MS[i]) / STD_MS[i] < 0.07) return STD_MS[i];
    }
    return 0;
  }

  /* ---------------------------------------------------------------------------
   * Device detection (a rough starting guess; the live frame monitor has the final say)
   * ------------------------------------------------------------------------- */
  function readGpuName() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return '';
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      var name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return name;
    } catch (e) { return ''; }
  }

  function gpuScore(name) {
    if (!name) return 0;
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) return -3;
    if (/rtx|gtx|geforce|radeon rx|radeon pro|arc.*\b[ab]\d{3}\b|radeon.*\b[5-8][0-9]0m\b|adreno.*x1|apple m\d|apple gpu|adreno.*\b[6-9]\d\d\b|mali-g[789]\d|immortalis|xclipse/i.test(name)) return 2;
    if (/intel.*(hd graphics|uhd)|adreno.*\b[2-5]\d\d\b|mali-[t4]|powervr|sgx/i.test(name)) return -1;
    return 0;
  }

  function detectTier() {
    var cores = navigator.hardwareConcurrency || 4;
    var mem = navigator.deviceMemory || 0; // Chrome only; 0 = unknown
    var gpu = readGpuName();
    var score = gpuScore(gpu);
    if (cores >= 8) score += 1; else if (cores <= 2) score -= 1;
    if (mem >= 8) score += 1; else if (mem && mem <= 2) score -= 1;
    var tier = score >= 2 ? 2 : (score <= -1 ? 0 : 1);
    return { tier: tier, gpu: gpu, score: score, cores: cores, mem: mem };
  }

  /* ---------------------------------------------------------------------------
   * Network + battery hints
   * ------------------------------------------------------------------------- */
  var net = { online: true, saveData: false, effectiveType: 'unknown', downlink: null, rtt: null, slow: false };
  var battery = null;

  function connection() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }
  function readNetwork() {
    var c = connection();
    var eff = (c && c.effectiveType) || 'unknown';
    net = {
      online: navigator.onLine !== false,
      saveData: !!(c && c.saveData),
      effectiveType: eff,
      downlink: (c && typeof c.downlink === 'number') ? c.downlink : null,
      rtt: (c && typeof c.rtt === 'number') ? c.rtt : null,
      slow: /(^|-)2g$/.test(eff)
    };
  }
  function publishNetwork() {
    readNetwork();
    root.classList.toggle('net-offline', !net.online);
    root.classList.toggle('net-slow', net.slow);
    root.classList.toggle('save-data', net.saveData);
    try { window.dispatchEvent(new CustomEvent('inchase:network', { detail: net })); } catch (e) {}
    enforceCeiling();
  }

  // Highest tier we allow right now. Data-saver and low battery both signal "go easy".
  function ceiling() {
    var c = 2;
    if (net.saveData) c = Math.min(c, 1);
    if (battery && !battery.charging && battery.level <= 0.2) c = Math.min(c, 1);
    return c;
  }

  /* ---------------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------------- */
  var params;
  try { params = new URLSearchParams(location.search); } catch (e) { params = { get: function () { return null; } }; }
  var urlPerf = (params.get('perf') || '').toLowerCase();
  var hudOn = params.get('perfhud') === '1';

  var locked = false;
  var tier = 1;
  var detected = null;
  var glowScale = 1;

  var URL_TIERS = { low: 0, balanced: 1, ultra: 2 };
  if (urlPerf === 'auto') clearSaved();

  readNetwork();
  if (Object.prototype.hasOwnProperty.call(URL_TIERS, urlPerf)) {
    tier = URL_TIERS[urlPerf];
    locked = true;
  } else {
    detected = detectTier(); // always run: it also supplies the GPU name
    var saved = loadSaved();
    // A saved result may sit at most one tier below what the hardware suggests.
    tier = saved === null ? detected.tier : Math.max(saved, detected.tier - 1);
    tier = Math.min(tier, ceiling());
  }
  glowScale = PROFILES[tier].glow;

  var gpuName = detected ? detected.gpu : '';
  if (!gpuName && hudOn) gpuName = readGpuName();

  /* ---------------------------------------------------------------------------
   * Hook 1: devicePixelRatio (the game calls Math.min(devicePixelRatio, 2) on resize)
   * ------------------------------------------------------------------------- */
  var realDprGetter = null;
  (function hookDpr() {
    try {
      var holder = window;
      var d = Object.getOwnPropertyDescriptor(holder, 'devicePixelRatio');
      if (!d && window.Window && Window.prototype) {
        holder = Window.prototype;
        d = Object.getOwnPropertyDescriptor(holder, 'devicePixelRatio');
      }
      if (!d || !d.get || !d.configurable) return;
      realDprGetter = d.get;
      Object.defineProperty(holder, 'devicePixelRatio', {
        configurable: true,
        enumerable: d.enumerable,
        get: function () {
          var real = realDprGetter.call(window) || 1;
          return Math.min(real, PROFILES[tier].dprCap);
        }
      });
    } catch (e) { realDprGetter = null; }
  })();

  function realDpr() { return realDprGetter ? (realDprGetter.call(window) || 1) : (window.devicePixelRatio || 1); }
  function effectiveDpr(t) { return Math.min(realDpr(), PROFILES[t].dprCap); }

  /* ---------------------------------------------------------------------------
   * Hook 2: the game canvas 2D context (context hints + glow scaling)
   * ------------------------------------------------------------------------- */
  (function hookContext() {
    try {
      var nativeGet = HTMLCanvasElement.prototype.getContext;
      var shadowDesc = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'shadowBlur');

      HTMLCanvasElement.prototype.getContext = function (type, opts) {
        if (type !== '2d' || this.id !== 'gameCanvas') return nativeGet.apply(this, arguments);

        // The arena repaints every pixel each frame, so an opaque canvas is safe and cheaper to composite.
        var o = opts || { alpha: false, desynchronized: params.get('perfdesync') === '1' };
        var ctx = nativeGet.call(this, type, o);

        if (ctx && !ctx.__inchasePerf && shadowDesc && shadowDesc.get && shadowDesc.set) {
          ctx.__inchasePerf = true;
          Object.defineProperty(ctx, 'shadowBlur', {
            configurable: true,
            enumerable: true,
            get: function () { return shadowDesc.get.call(this); },
            set: function (v) { shadowDesc.set.call(this, v * glowScale); }
          });
        }
        return ctx;
      };
    } catch (e) {}
  })();

  /* ---------------------------------------------------------------------------
   * Hook 3: CSS that only matters on the Low tier
   * ------------------------------------------------------------------------- */
  (function injectCss() {
    try {
      var st = document.createElement('style');
      st.textContent =
        'html.perf-low body::before,html.perf-low .scanlines::after{display:none!important}' +
        '#inchasePerfHud{position:fixed;left:4px;bottom:4px;z-index:99999;pointer-events:none;' +
        'font:10px/1.4 monospace;color:#9f9;background:rgba(0,0,0,.65);padding:3px 6px;border-radius:3px;white-space:pre}';
      (document.head || root).appendChild(st);
    } catch (e) {}
  })();
  root.classList.toggle('perf-low', !PROFILES[tier].scanlines);
  root.setAttribute('data-perf', PROFILES[tier].name.toLowerCase());

  /* ---------------------------------------------------------------------------
   * Tier changes
   * ------------------------------------------------------------------------- */
  var stats = { fps: 0, p95: 0 };
  var hudEl = null;

  function updateHud() {
    if (!hudOn) return;
    if (!hudEl) {
      if (!document.body) return;
      hudEl = document.createElement('div');
      hudEl.id = 'inchasePerfHud';
      document.body.appendChild(hudEl);
    }
    hudEl.textContent =
      'tier ' + PROFILES[tier].name + (locked ? ' (locked)' : '') +
      '\nfps ' + (stats.fps ? stats.fps.toFixed(0) : '--') + '  p95 ' + (stats.p95 ? stats.p95.toFixed(1) : '--') + 'ms' +
      '\ndisplay ~' + (1000 / refreshMs).toFixed(0) + 'Hz  dpr ' + effectiveDpr(tier).toFixed(2) +
      '\n' + (gpuName || 'gpu: unknown').slice(0, 48);
  }

  function setTier(next, reason) {
    next = clamp(next | 0, 0, 2);
    if (next === tier) return;
    var before = effectiveDpr(tier);
    tier = next;
    glowScale = PROFILES[tier].glow;
    root.classList.toggle('perf-low', !PROFILES[tier].scanlines);
    root.setAttribute('data-perf', PROFILES[tier].name.toLowerCase());
    if (!locked) saveTier(tier);

    // Resolution changed: the game rebuilds its canvas on 'resize' (applyLayout -> resizeCanvas).
    // Done outside the animation frame so it never lands inside a frame that is already late.
    if (effectiveDpr(tier) !== before) {
      setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 0);
    }
    try {
      window.dispatchEvent(new CustomEvent('inchase:perf', {
        detail: { tier: tier, name: PROFILES[tier].name, reason: reason || '', profile: PROFILES[tier] }
      }));
    } catch (e) {}
    updateHud();
  }

  function enforceCeiling() {
    if (!locked && tier > ceiling()) setTier(ceiling(), 'ceiling');
  }

  /* ---------------------------------------------------------------------------
   * Frame-time monitor
   * ------------------------------------------------------------------------- */
  var refreshMs = 1000 / 60;   // refined by the startup probe and by gameplay samples
  var WINDOW_MS = 2000;        // evaluate every ~2 s of play
  var WARMUP_FRAMES = 20;      // skip frames right after a pause / tab switch
  var lastTs = 0, winStart = 0, warm = 0;
  var win = new Float32Array(1024); // frame-time samples, reused every window (no per-window garbage)
  var winN = 0;
  var steadySnap = 0, steadyCount = 0, steadyDrops = 0;
  var slow = 0, good = 0;
  var upAt = -1e9, blockUpUntil = 0, backoff = 30000;

  function stepTier(delta, t, why) {
    if (delta < 0) {
      // A climb that failed within 30 s doubles the wait before the next attempt.
      if (t - upAt < 30000) backoff = Math.min(backoff * 2, 240000);
      blockUpUntil = t + backoff;
    } else {
      upAt = t;
    }
    setTier(tier + delta, why);
  }

  function evaluate(t) {
    var n = winN;
    var s = win.subarray(0, n);
    s.sort();                       // typed-array sort is numeric
    winN = 0;
    winStart = 0;
    if (n < 12) return;

    var med = s[n >> 1];
    var p10 = s[Math.floor(n * 0.1)];
    var p95 = s[Math.min(n - 1, Math.floor(n * 0.95))];

    // If the fastest frames match a faster display (e.g. 120/144 Hz), raise the target.
    var snapped = snapMs(p10);
    if (snapped && snapped < refreshMs) refreshMs = snapped;

    // Display switched to a slower refresh (power mode, monitor change)? Frames then sit rock-steady on
    // a slower standard interval. If that holds for 3 windows (a tier drop in between did not change it),
    // treat it as the new display rate instead of as lag.
    var medSnap = snapMs(med);
    if (medSnap && medSnap > refreshMs * 1.3 && (p95 - p10) < 1.5) {
      if (medSnap === steadySnap) steadyCount++; else { steadySnap = medSnap; steadyCount = 1; }
      if (steadyCount >= 3) {
        refreshMs = medSnap; steadySnap = 0; steadyCount = 0; steadyDrops = 0; slow = 0;
        blockUpUntil = 0; // it was a display switch, not GPU lag: allow climbing back right away
      }
    } else {
      steadySnap = 0; steadyCount = 0; steadyDrops = 0;
    }

    stats = { fps: 1000 / med, p95: p95 };
    updateHud();
    if (locked) return;

    if (t - upAt > 120000) backoff = 30000; // a climb that held for 2 min counts as a success

    var b = refreshMs;
    var severe = med > b * 2;
    var struggling = severe || med > b * 1.3 + 1 || p95 > b * 2.4;
    var smooth = med <= b * 1.12 && p95 <= b * 1.6;

    if (struggling) {
      good = 0;
      slow++;
      // While a steady slower rate is being checked, lose at most one tier for it.
      if ((slow >= 2 || severe) && tier > 0 && !(steadyCount > 0 && steadyDrops >= 1)) {
        slow = 0;
        if (steadyCount > 0) steadyDrops++;
        stepTier(-1, t, 'slow frames');
      }
    } else if (smooth) {
      slow = 0;
      good++;
      if (good >= 4 && tier < ceiling() && t >= blockUpUntil) { good = 0; stepTier(+1, t, 'headroom'); }
    } else {
      slow = 0;
      good = 0;
    }
  }

  function onFrame(ts) {
    if (ts === lastTs) return;              // several callbacks in one frame
    var prev = lastTs;
    lastTs = ts;
    if (!prev) return;
    var dt = ts - prev;
    if (dt < 1) return;
    if (dt > 250) { winN = 0; winStart = 0; warm = 0; return; } // paused / hidden tab / menu
    if (warm < WARMUP_FRAMES) { warm++; return; }
    if (!winStart) winStart = ts;
    if (winN < win.length) win[winN++] = dt;
    if (ts - winStart >= WINDOW_MS) evaluate(ts);
  }

  var nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return nativeRaf(function (ts) {
      try { onFrame(ts); } catch (e) {}
      cb(ts);
    });
  };

  document.addEventListener('visibilitychange', function () { lastTs = 0; winN = 0; winStart = 0; warm = 0; });

  // Startup probe: estimate the display refresh rate from ~50 idle frames (never blocks the game).
  (function probeRefresh() {
    var n = 0, last = 0, arr = [];
    function step(ts) {
      if (last) { var d = ts - last; if (d > 1 && d < 100) arr.push(d); }
      last = ts;
      if (++n < 50) { nativeRaf(step); return; }
      if (arr.length < 20) return;
      arr.sort(byNum);
      var snapped = snapMs(arr[Math.floor(arr.length * 0.15)]);
      if (snapped && snapped < refreshMs) refreshMs = snapped;
      updateHud();
    }
    nativeRaf(step);
  })();

  /* ---------------------------------------------------------------------------
   * Network / battery listeners
   * ------------------------------------------------------------------------- */
  window.addEventListener('online', publishNetwork);
  window.addEventListener('offline', publishNetwork);
  (function () {
    var c = connection();
    if (c && c.addEventListener) c.addEventListener('change', publishNetwork);
  })();
  try {
    if (navigator.getBattery) {
      navigator.getBattery().then(function (b) {
        battery = b;
        b.addEventListener('levelchange', enforceCeiling);
        b.addEventListener('chargingchange', enforceCeiling);
        enforceCeiling();
      }).catch(function () {});
    }
  } catch (e) {}

  function onReady() { publishNetwork(); updateHud(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  /* ---------------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------------- */
  window.INchasePerf = {
    get tier() { return tier; },
    get tierName() { return PROFILES[tier].name; },
    get profile() { return PROFILES[tier]; },
    get particleLimit() { return PROFILES[tier].particles; }, // optional: see notes, not used unless the game reads it
    get refreshHz() { return Math.round(1000 / refreshMs); },
    get fps() { return stats.fps; },
    get network() { return net; },
    get locked() { return locked; },
    get gpu() { return gpuName; },
    setTier: function (t) { locked = true; setTier(t, 'manual'); updateHud(); },
    auto: function () { locked = false; clearSaved(); slow = 0; good = 0; updateHud(); }
  };
})();
