/* =====================================================================
   INchase — responsiveness.js
   Companion to responsiveness.css. It never touches game logic. It only:
     1. adds viewport-fit=cover (notch / rounded-corner support)
     2. publishes the REAL visible size as CSS variables (--app-h, --vv-top)
        so dialogs fit above the on-screen keyboard and the browser bars
     3. re-fires "resize" after a rotation (iOS reports stale sizes at first)
        and pauses a running game so a rotation never costs a life
     4. fixes the iOS "page stuck scrolled after the keyboard closes" bug
   ===================================================================== */
(function () {
  'use strict';
  var root = document.documentElement;
  var vv = window.visualViewport;

  /* 1. viewport-fit=cover (the same change is also made directly in index.html) */
  try {
    var meta = document.querySelector('meta[name="viewport"]');
    if (meta && !/viewport-fit/.test(meta.content)) {
      meta.setAttribute('content', meta.content + ', viewport-fit=cover');
    }
  } catch (e) { /* ignore */ }

  /* 2. visible size -> CSS variables */
  var raf = 0;
  function measure() {
    raf = 0;
    var h = vv ? vv.height : window.innerHeight;
    var top = vv ? vv.offsetTop : 0;
    root.style.setProperty('--app-h', Math.round(h) + 'px');
    root.style.setProperty('--vv-top', Math.round(top) + 'px');
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(measure); }
  measure();
  window.addEventListener('resize', schedule);
  if (vv) {
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
  }

  /* 3. rotation: wait for the browser to settle, then let the game re-measure */
  function settle() {
    [60, 200, 450, 900].forEach(function (ms) {
      setTimeout(function () {
        measure();
        window.dispatchEvent(new Event('resize'));
      }, ms);
    });
  }
  window.addEventListener('orientationchange', function () {
    // the game listens for this event and only pauses when a run is in progress
    window.dispatchEvent(new Event('inchase-pause'));
    settle();
  });
  // bfcache restore (Safari back/forward) and late web-font swap change the sizes too
  window.addEventListener('pageshow', function (e) { if (e.persisted) settle(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(settle);

  /* 4. keyboard handling */
  function isTextField(el) {
    return !!(el && el.matches && el.matches('input, textarea, [contenteditable="true"]'));
  }
  function resetScroll() {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  }
  document.addEventListener('focusout', function () {
    setTimeout(function () { resetScroll(); measure(); }, 120);
  });
  if (vv) {
    vv.addEventListener('resize', function () {
      if (!isTextField(document.activeElement)) resetScroll();
    });
  }
  // keep the focused field visible inside a dialog while the keyboard is up
  document.addEventListener('focusin', function (e) {
    var t = e.target;
    if (isTextField(t) && t.closest && t.closest('[id$="Modal"]')) {
      setTimeout(function () {
        try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { /* ignore */ }
      }, 250);
    }
  });
})();
