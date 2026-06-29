// two-fingers — Chrome-style pinch zoom for VSCode (sandbox-safe DOM emulation)
// ---------------------------------------------------------------------------
// VSCode's workbench renderer is sandboxed, so we cannot reach Electron's
// webFrame to enable *native* pinch zoom. Instead we emulate Chrome's pinch
// (visual-viewport) behaviour purely in the DOM: a trackpad pinch arrives as a
// `wheel` event with `ctrlKey === true`, and we respond by applying a CSS
// `transform: scale()` to the editor pane under the cursor — magnifying it
// WITHOUT re-laying-out anything, exactly like a pinch (not the menu zoom).
//
// Scope is the editor pane (`.editor-instance`); each editor remembers its own
// zoom. Horizontal pan uses the transform; vertical pan is forwarded to
// Monaco's own scroll (the editor virtualizes, so only on-screen lines exist in
// the DOM — scrolling makes it render the rest).
//
// Features: per-pane pinch zoom, mouse Ctrl+wheel zoom, keyboard zoom
// (Ctrl+Alt+= / -), live % readout + reset button, optional auto-reset after
// idle, a persisted settings panel, prefers-reduced-motion support, auto-hiding
// buttons, and a subtle outline on the zoomed pane.
//
// Loaded via the "Custom CSS and JS Loader" extension. Pure DOM/CSS, so it
// works even though `require('electron')` is unavailable.
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  const TAG = '[two-fingers]';
  const MIN_SCALE = 1;        // never shrink below 100%
  const SHARPEN_MS = 160;     // idle delay before dropping to a crisp 2D raster
  const AUTOHIDE_MS = 2000;   // idle delay before fading the pane toolbar
  const PANE_SELECTORS = '.editor-instance';
  const WEBVIEW_SELECTOR = 'iframe.webview'; // VSCode webview iframes (own layer)

  // --- persisted settings ---------------------------------------------------
  const LS_KEY = 'two-fingers.settings';
  const DEFAULTS = {
    autoReset: false,    // ease back to 100% after idleMs of no activity
    idleMs: 500,
    autoHide: true,      // fade the pane toolbar when idle
    outline: true,       // subtle outline around a zoomed pane
    motion: 'on',        // 'on' (always animate) | 'auto' (follow OS) | 'off' (instant)
    invertScroll: false, // flip vertical pan direction
    maxScale: 5,
    zoomSens: 0.01,
    panSens: 1,
    lerp: 0.35,
    resetLerp: 0.1,      // easing for the zoom-out/reset glide (lower = slower)
    webviewZoom: true,   // allow zooming webview views (markdown preview, etc.)
    webviewWheel: true,  // Ctrl + wheel / two-finger scroll over a webview zooms it
    keyStep: 1.1,        // keyboard zoom factor per press (~10% steps)
    webviewEntry: 1.1,   // zoom level when entering a webview via ⤢ / keyboard
    buttonPos: 'bottom-left', // ⤢ entry button: off | {top,bottom}-{left,right}
  };
  let settings = loadSettings();

  function loadSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {}
  }
  function reducedMotion() {
    if (settings.motion === 'off') return true;
    if (settings.motion === 'on') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches; // 'auto'
  }
  function panDir() { return settings.invertScroll ? 1 : -1; }

  // --- state ----------------------------------------------------------------
  const panes = new Map();              // clipEl -> per-pane state
  const entryButtons = new Map();       // webview iframe -> ⤢ entry button
  const webviewOverlays = new Map();    // webview iframe -> capture overlay
  let ctrlHeld = false;                 // physical Ctrl down (for wheel-entry)
  let lastPointer = null;               // {x, y} for keyboard-zoom targeting
  let idleTimer = 0;
  let inScan = false;                   // guards cleanup() from re-entering scan

  // A pane is zoomable only if it's a real text/code editor: it contains a
  // Monaco editor and NO iframe. This excludes webview editors (the Claude Code
  // panel, Markdown preview, the Settings UI) and notebooks — scaling their
  // iframes is laggy and we can't capture gestures inside them anyway.
  function isZoomable(el) {
    return !!(el && el.querySelector('.monaco-editor') && !el.querySelector('iframe'));
  }

  // A webview pane: an editor hosting an iframe and no Monaco (Markdown preview,
  // custom editors, the Settings UI, the Claude Code panel). Gestures can't
  // reach inside the iframe, so these are entered via the ⤢ button / keyboard
  // and then driven by a capture overlay.
  // A webview pane's transform target is the webview <iframe> itself (it lives in
  // a separate overlay layer, not inside .editor-instance). Its parent is a
  // fixed, overflow:hidden wrapper sized to the editor region, which clips it.
  function isWebviewPane(el) { return !!(el && el.tagName === 'IFRAME'); }
  function isPane(el) { return isZoomable(el) || (settings.webviewZoom && isWebviewPane(el)); }

  function isVisible(el) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.02) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return false;
    // Also reject off-screen (a hidden tab may be parked outside the viewport).
    return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
  }

  // The zoom target (text editor-instance OR webview iframe) at a DOM element.
  function paneTargetFromElement(el) {
    if (!el || !el.closest) return null;
    const ed = el.closest('.editor-instance');
    if (ed && isZoomable(ed)) return ed;
    if (settings.webviewZoom) {
      const wv = el.closest(WEBVIEW_SELECTOR);
      if (wv && isVisible(wv)) return wv;
    }
    return null;
  }

  // The pane in the active editor group (the focused split) — text or webview.
  function activeTarget() {
    const group = document.querySelector('.editor-group-container.active');
    if (!group) return null;
    const ei = group.querySelector('.editor-instance');
    if (ei && isZoomable(ei)) return ei; // text editor in the active group
    if (settings.webviewZoom) {
      // Webview group: match by the visible webview iframe over this region.
      const gr = group.getBoundingClientRect();
      const cx = gr.left + gr.width / 2, cy = gr.top + gr.height / 2;
      for (const f of document.querySelectorAll(WEBVIEW_SELECTOR)) {
        if (!isVisible(f)) continue;
        const r = f.getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return f;
      }
    }
    return null;
  }

  // Best target for a keyboard shortcut: the focused split first (so it keeps
  // acting on what you're working in), then under the pointer, then any webview.
  function getTarget() {
    const a = activeTarget();
    if (a) return a;
    if (lastPointer) {
      const t = paneTargetFromElement(document.elementFromPoint(lastPointer.x, lastPointer.y));
      if (t) return t;
    }
    const ed = activeEditor();
    if (ed) return ed;
    if (settings.webviewZoom) {
      for (const f of document.querySelectorAll(WEBVIEW_SELECTOR)) if (isVisible(f)) return f;
    }
    return null;
  }

  function resolve(target) {
    const el = target && target.closest ? target.closest(PANE_SELECTORS) : null;
    if (!el || !el.parentElement || !isZoomable(el)) return null;
    return el;
  }

  // Editor to use when a keyboard shortcut has no cursor target: the focused /
  // active editor group (skipping non-text panes).
  function activeEditor() {
    const a = document.activeElement;
    const ei = a && a.closest ? a.closest(PANE_SELECTORS) : null;
    if (ei && isPane(ei)) return ei;
    const focused = document.querySelector('.editor-instance .monaco-editor.focused');
    if (focused) {
      const p = focused.closest(PANE_SELECTORS);
      if (p && isPane(p)) return p;
    }
    const active = document.querySelector('.editor-group-container.active .editor-instance');
    if (active && isPane(active)) return active;
    for (const el of document.querySelectorAll(PANE_SELECTORS)) {
      if (isPane(el)) return el;
    }
    return null;
  }

  function getState(transformEl, create) {
    const clipEl = transformEl.parentElement;
    let s = panes.get(clipEl);
    if (s) return s;
    if (!create) return null;
    const r = clipEl.getBoundingClientRect();
    s = {
      transformEl, clipEl,
      prevOverflow: clipEl.style.overflow,
      prevOutline: clipEl.style.outline,
      baseLeft: r.left, baseTop: r.top, baseW: r.width, baseH: r.height,
      scale: 1, panX: 0, panY: 0,      // current (animated)
      tScale: 1, tPanX: 0, tPanY: 0,   // target
      animating: false, sharpenTimer: 0, hideTimer: 0, resetting: false,
      webview: isWebviewPane(transformEl),
      toolbar: null, label: null, frame: null,
    };
    transformEl.style.transformOrigin = '0 0';
    clipEl.style.overflow = 'hidden';
    makeToolbar(s);
    makeFrame(s);
    panes.set(clipEl, s);
    return s;
  }

  // A border overlay framing the pane's viewport while zoomed (so it's obvious
  // which editor is magnified). Lives in <body> at the pane's untransformed
  // rect; pointer-events:none so it never blocks input.
  function makeFrame(s) {
    const f = document.createElement('div');
    f.style.cssText =
      'position:fixed;z-index:2147483646;display:none;box-sizing:border-box;' +
      'border:2px solid rgba(120,170,255,0.85);border-radius:3px;pointer-events:none;';
    document.body.appendChild(f);
    s.frame = f;
  }

  // --- pane toolbar (reset/% + gear) ----------------------------------------
  function makeToolbar(s) {
    const bar = document.createElement('div');
    bar.style.cssText =
      'position:fixed;z-index:2147483647;display:none;gap:4px;align-items:center;' +
      'transition:opacity .15s;';

    const reset = document.createElement('button');
    reset.textContent = '100%';
    reset.title = 'Reset zoom (Ctrl+Alt+0)';
    styleButton(reset, 'min-width:46px');
    bind(reset, () => resetPane(s));

    const gear = document.createElement('button');
    gear.textContent = '⚙';
    gear.title = 'two-fingers settings (Ctrl+Alt+,)';
    styleButton(gear, 'width:28px');
    bind(gear, () => togglePanel(s));

    bar.appendChild(reset);
    bar.appendChild(gear);
    document.body.appendChild(bar);
    s.toolbar = bar;
    s.label = reset;
  }

  function styleButton(b, extra) {
    b.style.cssText =
      'height:28px;display:flex;align-items:center;justify-content:center;' +
      'border:none;border-radius:6px;cursor:pointer;padding:0 8px;' +
      'background:rgba(40,40,40,0.85);color:#fff;font:600 12px/1 sans-serif;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.45);' +
      '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);' + (extra || '');
  }
  // Buttons must not let their clicks/wheels fall through to the editor.
  function bind(el, fn) {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener('mousedown', stop, true);
    el.addEventListener('wheel', stop, true);
    el.addEventListener('click', (e) => { stop(e); fn(); });
  }

  function syncOverlays(s) {
    const zoomed = s.tScale > MIN_SCALE + 0.0005;
    if (s.toolbar) {
      if (zoomed) {
        s.toolbar.style.right = window.innerWidth - (s.baseLeft + s.baseW) + 8 + 'px';
        s.toolbar.style.left = 'auto';
        s.toolbar.style.top = s.baseTop + 8 + 'px';
        s.toolbar.style.display = 'flex';
        wake(s);
      } else {
        s.toolbar.style.display = 'none';
      }
    }
    if (s.frame) {
      if (zoomed && settings.outline) {
        s.frame.style.left = s.baseLeft + 'px';
        s.frame.style.top = s.baseTop + 'px';
        s.frame.style.width = s.baseW + 'px';
        s.frame.style.height = s.baseH + 'px';
        s.frame.style.display = 'block';
      } else {
        s.frame.style.display = 'none';
      }
    }
  }

  // Refresh overlays for all panes immediately when a setting changes (so e.g.
  // toggling the outline is visible without first interacting with the pane).
  function applySettingsLive() { panes.forEach(syncOverlays); scanWebviewPanes(); }
  function wake(s) {
    const bar = s.toolbar;
    if (!bar) return;
    bar.style.opacity = '1';
    bar.style.pointerEvents = 'auto';
    clearTimeout(s.hideTimer);
    if (settings.autoHide) {
      s.hideTimer = setTimeout(() => {
        bar.style.opacity = '0';
        bar.style.pointerEvents = 'none';
      }, AUTOHIDE_MS);
    }
  }
  function updateLabel(s) {
    if (s.label) s.label.textContent = Math.round(s.scale * 100) + '%';
  }

  // --- transform / animation ------------------------------------------------
  function clampTarget(s) {
    const minX = s.baseW * (1 - s.tScale);
    const minY = s.baseH * (1 - s.tScale);
    if (s.tPanX > 0) s.tPanX = 0;
    if (s.tPanY > 0) s.tPanY = 0;
    if (s.tPanX < minX) s.tPanX = minX;
    if (s.tPanY < minY) s.tPanY = minY;
  }

  function render(s, settled) {
    const el = s.transformEl;
    if (s.scale <= MIN_SCALE + 0.0005) {
      el.style.transform = '';
    } else if (s.webview) {
      // Keep webviews on a GPU layer so panning (translate only) stays smooth
      // and doesn't re-raster the iframe.
      el.style.transform = `translate3d(${s.panX}px, ${s.panY}px, 0) scale(${s.scale})`;
    } else {
      el.style.transform = settled
        ? `translate(${s.panX}px, ${s.panY}px) scale(${s.scale})`
        : `translate3d(${s.panX}px, ${s.panY}px, 0) scale(${s.scale})`;
    }
    updateLabel(s);
  }

  function step(s) {
    // Webviews animate instantly: scaling an iframe re-rasters, so a multi-frame
    // glide is laggy — snap to the target in one step.
    const k = s.webview ? 1
      : reducedMotion() ? 1
      : (s.resetting ? settings.resetLerp : settings.lerp);
    s.scale += (s.tScale - s.scale) * k;
    s.panX += (s.tPanX - s.panX) * k;
    s.panY += (s.tPanY - s.panY) * k;

    const done =
      Math.abs(s.tScale - s.scale) < 0.001 &&
      Math.abs(s.tPanX - s.panX) < 0.5 &&
      Math.abs(s.tPanY - s.panY) < 0.5;

    if (done) {
      s.scale = s.tScale; s.panX = s.tPanX; s.panY = s.tPanY;
      s.resetting = false;
      render(s, true);
      s.animating = false;
      if (s.scale <= MIN_SCALE + 0.0005) {
        cleanup(s);
      } else {
        clearTimeout(s.sharpenTimer);
        s.sharpenTimer = setTimeout(() => {
          s.transformEl.style.willChange = 'auto';
          render(s, true);
        }, SHARPEN_MS);
      }
    } else {
      render(s, false);
      requestAnimationFrame(() => step(s));
    }
  }

  function startAnim(s) {
    if (s.webview) {
      const ov = ensureWebviewOverlay(s.transformEl);
      positionOverlay(ov, s.baseLeft, s.baseTop, s.baseW, s.baseH);
      ov.style.display = 'block';
      ov.style.pointerEvents = overlayActive(s.transformEl) ? 'auto' : 'none';
    }
    syncOverlays(s);
    s.transformEl.style.willChange = 'transform';
    clearTimeout(s.sharpenTimer);
    if (!s.animating) {
      s.animating = true;
      requestAnimationFrame(() => step(s));
    }
  }

  function cleanup(s) {
    if (s.dead) return;
    s.dead = true;
    clearTimeout(s.sharpenTimer);
    clearTimeout(s.hideTimer);
    s.transformEl.style.transform = '';
    s.transformEl.style.willChange = 'auto';
    s.clipEl.style.overflow = s.prevOverflow;
    if (s.toolbar) { s.toolbar.remove(); s.toolbar = null; }
    if (s.frame) { s.frame.remove(); s.frame = null; }
    const wasWebview = s.webview, iframe = s.transformEl;
    panes.delete(s.clipEl);
    if (wasWebview) { syncOneOverlay(iframe); if (!inScan) scanWebviewPanes(); }
  }

  function resetPane(s) { s.resetting = true; s.tScale = MIN_SCALE; s.tPanX = 0; s.tPanY = 0; startAnim(s); }
  function resetAll() { panes.forEach(resetPane); }

  // Snap a pane to 100% immediately (no glide). Used before VSCode needs the
  // editor at true coordinates — e.g. opening the right-click context menu,
  // which mis-anchors while the editor is transformed.
  function instantReset(s) {
    s.animating = false;
    s.scale = 1; s.tScale = 1;
    s.panX = s.panY = s.tPanX = s.tPanY = 0;
    s.transformEl.style.transform = '';
    s.transformEl.style.willChange = 'auto';
    cleanup(s);
  }

  function bumpIdle() {
    if (!settings.autoReset) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(resetAll, settings.idleMs);
  }

  // Forward vertical panning to Monaco's own scroll so it renders lines outside
  // the originally-visible slice. deltaY is converted from screen px to the
  // editor's (unscaled) px; panDir() corrects the synthetic-wheel sign.
  function scrollEditor(s, deltaYLayout) {
    const target =
      s.transformEl.querySelector('.editor-scrollable') ||
      s.transformEl.querySelector('.monaco-scrollable-element') ||
      s.transformEl.querySelector('.lines-content') ||
      s.transformEl;
    const ev = new WheelEvent('wheel', {
      deltaY: deltaYLayout, deltaMode: 0, bubbles: true, cancelable: true,
    });
    ev.__twofingers = true; // so our own capture listener ignores it
    target.dispatchEvent(ev);
  }

  function zoomAt(s, clientX, clientY, factor) {
    const X = clientX - s.baseLeft;
    const Y = clientY - s.baseTop;
    const next = Math.min(settings.maxScale, Math.max(MIN_SCALE, s.tScale * factor));
    if (next === s.tScale) return;
    s.resetting = false; // a fresh zoom interrupts any in-progress reset glide
    const worldX = (X - s.tPanX) / s.tScale;
    const worldY = (Y - s.tPanY) / s.tScale;
    s.tScale = next;
    s.tPanX = X - next * worldX;
    s.tPanY = Y - next * worldY;
    clampTarget(s);
    startAnim(s);
    bumpIdle();
  }

  // Keyboard zoom: target the editor under the pointer, else the active editor.
  function keyboardZoom(factor) {
    const el = getTarget();
    if (!el || !el.parentElement) return;
    const s = getState(el, true);
    const r = el.getBoundingClientRect();
    const overPointer = lastPointer &&
      lastPointer.x >= r.left && lastPointer.x <= r.right &&
      lastPointer.y >= r.top && lastPointer.y <= r.bottom;
    const fx = overPointer ? lastPointer.x : r.left + r.width / 2;
    const fy = overPointer ? lastPointer.y : r.top + r.height / 2;
    zoomAt(s, fx, fy, factor);
  }

  // --- webview views --------------------------------------------------------
  // Webviews can't be entered by a gesture (events fire inside the iframe), so
  // a small ⤢ button on each webview pane (or Ctrl+Alt+=) starts the zoom. Once
  // zoomed, a transparent capture overlay sits over the iframe and drives
  // zoom/pan from both mouse and trackpad. Reset removes the overlay.
  function paneZoomed(el) {
    const s = el.parentElement && panes.get(el.parentElement);
    return !!(s && s.tScale > MIN_SCALE + 0.0005);
  }

  function enterWebviewZoom(el) {
    if (!el || !el.parentElement) return;
    const s = getState(el, true);
    const btn = entryButtons.get(el);
    if (btn) btn.style.display = 'none';
    const r = el.getBoundingClientRect();
    zoomAt(s, r.left + r.width / 2, r.top + r.height / 2, settings.webviewEntry);
  }

  function makeEntryButton(el) {
    const b = document.createElement('button');
    b.textContent = '⤢';
    b.title = 'Zoom this view (two-fingers)';
    styleButton(b, 'position:fixed;z-index:2147483640;width:28px;display:none;opacity:0.5;transition:opacity .15s;');
    b.addEventListener('mouseenter', () => { b.style.opacity = '1'; });
    b.addEventListener('mouseleave', () => { b.style.opacity = '0.5'; });
    bind(b, () => enterWebviewZoom(el));
    document.body.appendChild(b);
    return b;
  }

  // The overlay is "active" (intercepts input) when the pane is zoomed, or — for
  // mouse wheel-entry — while Ctrl is physically held with that setting on.
  function overlayActive(iframe) {
    return paneZoomed(iframe) ||
      (settings.webviewZoom && settings.webviewWheel && ctrlHeld);
  }
  function positionOverlay(ov, l, t, w, h) {
    ov.style.left = l + 'px';
    ov.style.top = t + 'px';
    ov.style.width = w + 'px';
    ov.style.height = h + 'px';
  }
  function syncOneOverlay(iframe) {
    const ov = webviewOverlays.get(iframe);
    if (ov) ov.style.pointerEvents = overlayActive(iframe) ? 'auto' : 'none';
  }
  function updateArming() {
    webviewOverlays.forEach((ov, iframe) => {
      ov.style.pointerEvents = overlayActive(iframe) ? 'auto' : 'none';
    });
  }

  // One persistent capture overlay per webview. pointer-events stays 'none' (the
  // webview is fully interactive) unless active — see overlayActive(). It drives
  // zoom (Ctrl+wheel / pinch) and pan (wheel / click-drag).
  function ensureWebviewOverlay(iframe) {
    let ov = webviewOverlays.get(iframe);
    if (ov) return ov;
    ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;z-index:2147483644;display:none;cursor:grab;background:transparent;pointer-events:none;';
    ov.addEventListener('wheel', (e) => {
      const zoomed = paneZoomed(iframe);
      if (!zoomed && !(settings.webviewWheel && ctrlHeld)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey) {
        zoomAt(getState(iframe, true), e.clientX, e.clientY, Math.exp(-e.deltaY * settings.zoomSens));
      } else if (zoomed) {
        const s = panes.get(iframe.parentElement);
        if (s) {
          const inv = settings.invertScroll ? -1 : 1;
          s.tPanX -= e.deltaX * settings.panSens;
          s.tPanY -= e.deltaY * settings.panSens * inv;
          clampTarget(s);
          startAnim(s);
          bumpIdle();
        }
      }
    }, { passive: false });
    // Mouse click-drag to pan (only while zoomed; don't hijack clicks otherwise).
    ov.addEventListener('mousedown', (e) => {
      if (!paneZoomed(iframe)) return;
      e.preventDefault();
      e.stopPropagation();
      const s = panes.get(iframe.parentElement);
      if (!s) return;
      const sx = e.clientX, sy = e.clientY, px = s.tPanX, py = s.tPanY;
      ov.style.cursor = 'grabbing';
      const mm = (ev) => {
        s.tPanX = px + (ev.clientX - sx);
        s.tPanY = py + (ev.clientY - sy);
        clampTarget(s);
        startAnim(s);
        bumpIdle();
      };
      const mu = () => {
        ov.style.cursor = 'grab';
        window.removeEventListener('mousemove', mm, true);
        window.removeEventListener('mouseup', mu, true);
      };
      window.addEventListener('mousemove', mm, true);
      window.addEventListener('mouseup', mu, true);
    });
    document.body.appendChild(ov);
    webviewOverlays.set(iframe, ov);
    return ov;
  }

  // Find webview panes and keep a ⤢ entry button pinned to each (hidden while
  // that pane is zoomed). Runs on an interval since panes come and go.
  function scanWebviewPanes() {
    inScan = true;
    try {
    if (!settings.webviewZoom) {
      entryButtons.forEach((btn) => btn.remove());
      entryButtons.clear();
      webviewOverlays.forEach((ov) => { ov.style.display = 'none'; ov.style.pointerEvents = 'none'; });
      return;
    }
    const seen = new Set();
    document.querySelectorAll(WEBVIEW_SELECTOR).forEach((el) => {
      if (!el.parentElement) return;
      seen.add(el);
      let btn = entryButtons.get(el);
      if (!btn) { btn = makeEntryButton(el); entryButtons.set(el, btn); }
      const ov = ensureWebviewOverlay(el);
      const visible = isVisible(el);
      const zoomed = paneZoomed(el);
      // ⤢ button: only when visible, not zoomed, and not turned off. Position is
      // a configurable corner — no single spot avoids every webview's own UI.
      if (settings.buttonPos === 'off' || !visible || zoomed) {
        btn.style.display = 'none';
      } else {
        const r = el.getBoundingClientRect();
        const m = 8, sz = 28, pos = settings.buttonPos;
        btn.style.left = (pos.endsWith('left') ? r.left + m : r.left + r.width - sz - m) + 'px';
        btn.style.top = (pos.startsWith('top') ? r.top + m : r.top + r.height - sz - m) + 'px';
        btn.style.display = 'flex';
      }
      // Overlay: cover the clip region (parent, unaffected by the iframe's own
      // transform) and arm per overlayActive().
      if (!visible) {
        ov.style.display = 'none';
        ov.style.pointerEvents = 'none';
      } else {
        const pr = el.parentElement.getBoundingClientRect();
        positionOverlay(ov, pr.left, pr.top, pr.width, pr.height);
        ov.style.display = 'block';
        ov.style.pointerEvents = overlayActive(el) ? 'auto' : 'none';
      }
    });
    entryButtons.forEach((btn, el) => {
      if (!seen.has(el) || !document.body.contains(el)) {
        btn.remove();
        entryButtons.delete(el);
        const ov = webviewOverlays.get(el);
        if (ov) { ov.remove(); webviewOverlays.delete(el); }
      }
    });
    // A zoomed webview keeps its state across tab switches, but its toolbar and
    // outline must follow the iframe's visibility — otherwise a hidden tab's
    // overlays linger over (and its capture overlay hijacks) whatever tab now
    // occupies the same area. (The capture overlay itself is handled above.)
    panes.forEach((s) => {
      if (!s.webview) return;
      if (!document.contains(s.transformEl)) {
        cleanup(s); // VSCode replaced the iframe — drop the stale zoom state
        return;
      }
      if (isVisible(s.transformEl)) {
        // Re-assert the transform; VSCode may wipe it when re-showing a webview,
        // which otherwise leaves the % readout out of sync with an unzoomed view.
        if (s.tScale > MIN_SCALE + 0.0005) render(s, true);
        syncOverlays(s);
      } else {
        if (s.toolbar) s.toolbar.style.display = 'none';
        if (s.frame) s.frame.style.display = 'none';
      }
    });
    } finally {
      inScan = false;
    }
  }

  // --- settings panel -------------------------------------------------------
  let panel = null;
  const CONTROLS = [
    { type: 'header', label: 'Zoom' },
    { key: 'maxScale', label: 'Max zoom (×)', type: 'num', step: 0.5, min: 1.5, max: 20 },
    { key: 'zoomSens', label: 'Zoom sensitivity', type: 'num', step: 0.002, min: 0.002, max: 0.05 },
    { key: 'keyStep', label: 'Keyboard step (×)', type: 'num', step: 0.05, min: 1.02, max: 2 },
    { key: 'panSens', label: 'Pan speed', type: 'num', step: 0.1, min: 0.1, max: 5 },
    { key: 'invertScroll', label: 'Invert scroll direction', type: 'bool' },

    { type: 'header', label: 'Motion' },
    { key: 'motion', label: 'Motion', type: 'select',
      options: [{ value: 'on', label: 'On' }, { value: 'auto', label: 'Auto (OS)' }, { value: 'off', label: 'Off' }] },
    { key: 'lerp', label: 'Smoothing (0–1)', type: 'num', step: 0.05, min: 0.05, max: 1 },
    { key: 'resetLerp', label: 'Reset glide (lower=slower)', type: 'num', step: 0.02, min: 0.02, max: 0.6 },

    { type: 'header', label: 'Auto-reset' },
    { key: 'autoReset', label: 'Auto-reset after idle', type: 'bool' },
    { key: 'idleMs', label: 'Idle delay (ms)', type: 'num', step: 50, min: 100, max: 5000 },

    { type: 'header', label: 'Appearance' },
    { key: 'outline', label: 'Outline zoomed pane', type: 'bool' },
    { key: 'autoHide', label: 'Auto-hide buttons', type: 'bool' },

    { type: 'header', label: 'Webviews' },
    { key: 'webviewZoom', label: 'Zoom webviews (previews)', type: 'bool' },
    { key: 'webviewWheel', label: 'Ctrl+wheel/scroll on webviews', type: 'bool' },
    { key: 'webviewEntry', label: 'Webview entry zoom (×)', type: 'num', step: 0.1, min: 1, max: 5 },
    { key: 'buttonPos', label: 'Webview button', type: 'select',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'top-left', label: 'Top-left' },
        { value: 'top-right', label: 'Top-right' },
        { value: 'bottom-left', label: 'Bottom-left' },
        { value: 'bottom-right', label: 'Bottom-right' },
      ] },
  ];

  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;z-index:2147483647;top:64px;left:24px;width:280px;' +
      'display:none;flex-direction:column;gap:8px;padding:14px;border-radius:10px;' +
      'background:rgba(30,30,30,0.96);color:#eee;font:12px/1.4 sans-serif;' +
      'box-shadow:0 6px 24px rgba(0,0,0,0.5);' +
      '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;';
    const title = document.createElement('div');
    title.textContent = 'two-fingers';
    title.style.cssText = 'font-weight:700;font-size:13px;';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Close (Ctrl+Alt+,)';
    close.style.cssText =
      'border:none;background:transparent;color:#aaa;cursor:pointer;' +
      'font-size:14px;line-height:1;padding:2px 6px;';
    close.addEventListener('click', () => { panel.style.display = 'none'; });
    header.appendChild(title);
    header.appendChild(close);
    panel.appendChild(header);

    CONTROLS.forEach((c) =>
      panel.appendChild(c.type === 'header' ? buildHeader(c) : buildRow(c)));

    const reset = document.createElement('button');
    reset.textContent = 'Reset to defaults';
    reset.style.cssText =
      'margin-top:6px;height:28px;border:none;border-radius:6px;cursor:pointer;' +
      'background:#3a3d41;color:#fff;font:600 12px sans-serif;';
    reset.addEventListener('click', () => {
      settings = Object.assign({}, DEFAULTS);
      saveSettings();
      refreshPanel();
      applySettingsLive();
    });
    panel.appendChild(reset);

    // Stop panel interactions from reaching the editor underneath — bubble
    // phase, so the panel's own buttons still receive their clicks.
    ['mousedown', 'wheel', 'click'].forEach((t) =>
      panel.addEventListener(t, (e) => e.stopPropagation()));
    document.body.appendChild(panel);
  }

  function buildHeader(c) {
    const h = document.createElement('div');
    h.textContent = c.label;
    h.style.cssText =
      'margin-top:6px;font:700 10px/1.8 sans-serif;letter-spacing:.06em;' +
      'text-transform:uppercase;color:#9aa0a6;border-bottom:1px solid #444;';
    return h;
  }

  function buildRow(c) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const span = document.createElement('span');
    span.textContent = c.label;
    row.appendChild(span);
    let input;
    if (c.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!settings[c.key];
      input.addEventListener('change', () => {
        settings[c.key] = input.checked; saveSettings(); applySettingsLive();
      });
    } else if (c.type === 'select') {
      input = document.createElement('select');
      input.style.cssText = 'background:#1e1e1e;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 4px;';
      c.options.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        input.appendChild(opt);
      });
      input.value = settings[c.key];
      input.addEventListener('change', () => {
        settings[c.key] = input.value; saveSettings(); applySettingsLive();
      });
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.step = c.step; input.min = c.min; input.max = c.max;
      input.value = settings[c.key];
      input.style.cssText = 'width:72px;background:#1e1e1e;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 4px;';
      // Apply live as you type (no Enter needed), but only when the value is
      // valid and in range — don't fight the field mid-edit.
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (!isNaN(v) && v >= c.min && v <= c.max) {
          settings[c.key] = v; saveSettings(); applySettingsLive();
        }
      });
      // On commit (Enter / blur), normalise and clamp the displayed value.
      input.addEventListener('change', () => {
        let v = parseFloat(input.value);
        if (isNaN(v)) v = DEFAULTS[c.key];
        v = Math.min(c.max, Math.max(c.min, v));
        settings[c.key] = v; input.value = v; saveSettings(); applySettingsLive();
      });
    }
    input.dataset.key = c.key;
    row.appendChild(input);
    return row;
  }

  function refreshPanel() {
    if (!panel) return;
    panel.querySelectorAll('input, select').forEach((input) => {
      const k = input.dataset.key;
      if (input.type === 'checkbox') input.checked = !!settings[k];
      else input.value = settings[k];
    });
  }

  function togglePanel(s) {
    if (!panel) buildPanel();
    const showing = panel.style.display !== 'none';
    if (showing) { panel.style.display = 'none'; return; }
    positionPanel(s);
    refreshPanel();
    panel.style.display = 'flex';
  }

  // Float the panel over the focused editor (or the pane whose gear was used),
  // horizontally centred and just below its top — clear of the explorer and the
  // pane's own top-right toolbar.
  function positionPanel(s) {
    const PW = 280;
    let left, top;
    if (s) {
      left = s.baseLeft + (s.baseW - PW) / 2;
      top = s.baseTop + 24;
    } else {
      const el = activeEditor();
      if (el) {
        const r = el.getBoundingClientRect();
        left = r.left + (r.width - PW) / 2;
        top = r.top + 24;
      } else {
        left = (window.innerWidth - PW) / 2;
        top = 64;
      }
    }
    left = Math.max(8, Math.min(left, window.innerWidth - PW - 8));
    panel.style.left = left + 'px';
    panel.style.right = 'auto';
    panel.style.top = Math.max(8, top) + 'px';
  }

  // --- input ----------------------------------------------------------------
  window.addEventListener('mousemove', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (panes.size) {
      // Mouse movement counts as activity: it wakes the toolbar and defers
      // auto-reset, so moving toward the gear/% button doesn't reset the pane
      // out from under you.
      panes.forEach((s) => { if (s.tScale > MIN_SCALE) wake(s); });
      bumpIdle();
    }
  }, true);

  window.addEventListener('wheel', function (e) {
    if (e.__twofingers) return; // our own forwarded scroll — let it through
    if (e.ctrlKey) {
      const el = resolve(e.target);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      zoomAt(getState(el, true), e.clientX, e.clientY, Math.exp(-e.deltaY * settings.zoomSens));
      return;
    }
    const el = resolve(e.target);
    const s = el ? getState(el, false) : null;
    if (s && s.tScale > MIN_SCALE) {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaX) {
        s.tPanX -= e.deltaX * settings.panSens;
        clampTarget(s);
        startAnim(s);
      }
      if (e.deltaY) {
        scrollEditor(s, (panDir() * e.deltaY * settings.panSens) / s.tScale);
      }
      bumpIdle();
    }
  }, { capture: true, passive: false });

  window.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey && e.altKey)) return;
    const code = e.code;
    if (code === 'Digit0' || code === 'Numpad0' || e.key === '0') {
      e.preventDefault(); e.stopPropagation(); resetAll();
    } else if (code === 'Equal' || code === 'NumpadAdd') {
      e.preventDefault(); e.stopPropagation(); keyboardZoom(settings.keyStep);
    } else if (code === 'Minus' || code === 'NumpadSubtract') {
      e.preventDefault(); e.stopPropagation(); keyboardZoom(1 / settings.keyStep);
    } else if (code === 'Comma') {
      e.preventDefault(); e.stopPropagation(); togglePanel();
    }
  }, true);

  // Right-clicking a transformed editor mis-anchors VSCode's context menu, so
  // snap that pane to 100% first (capture phase, before VSCode handles it).
  window.addEventListener('contextmenu', (e) => {
    const ed = e.target && e.target.closest ? e.target.closest(PANE_SELECTORS) : null;
    if (!ed) return;
    const s = panes.get(ed.parentElement);
    if (s && !s.webview && s.tScale > MIN_SCALE) instantReset(s);
  }, true);

  // Coalesced rescan, so tab switches / focus changes refresh the overlays
  // promptly instead of waiting for the 700ms poll.
  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => { scanScheduled = false; scanWebviewPanes(); }, 40);
  }

  // Track physical Ctrl so mouse Ctrl+wheel can arm the webview overlay. On the
  // Ctrl press, rescan immediately so the overlay is correctly shown/positioned/
  // armed *before* the Ctrl+scroll that follows (fixes the post-tab-switch race).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control' && !ctrlHeld) { ctrlHeld = true; scanWebviewPanes(); }
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control' && ctrlHeld) { ctrlHeld = false; updateArming(); }
  }, true);
  window.addEventListener('blur', () => {
    if (ctrlHeld) { ctrlHeld = false; updateArming(); }
  });

  scanWebviewPanes();
  setInterval(scanWebviewPanes, 700);
  window.addEventListener('resize', scheduleScan);
  window.addEventListener('focusin', scheduleScan, true);

  console.log(TAG, 'active — pinch / Ctrl+wheel to zoom, Ctrl+Alt+, for settings');
})();
