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
  const PANE_SELECTORS = '.editor-instance'; // editor only; webviews unreachable
  const ZOOM_KEY_STEP = 1.25; // per keypress zoom factor

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
  let lastPointer = null;               // {x, y} for keyboard-zoom targeting
  let idleTimer = 0;

  // A pane is zoomable only if it's a real text/code editor: it contains a
  // Monaco editor and NO iframe. This excludes webview editors (the Claude Code
  // panel, Markdown preview, the Settings UI) and notebooks — scaling their
  // iframes is laggy and we can't capture gestures inside them anyway.
  function isZoomable(el) {
    return !!(el && el.querySelector('.monaco-editor') && !el.querySelector('iframe'));
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
    if (ei && isZoomable(ei)) return ei;
    const focused = document.querySelector('.editor-instance .monaco-editor.focused');
    if (focused) {
      const p = focused.closest(PANE_SELECTORS);
      if (p && isZoomable(p)) return p;
    }
    const active = document.querySelector('.editor-group-container.active .editor-instance');
    if (active && isZoomable(active)) return active;
    for (const el of document.querySelectorAll(PANE_SELECTORS)) {
      if (isZoomable(el)) return el;
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
  function applySettingsLive() { panes.forEach(syncOverlays); }
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
    } else {
      el.style.transform = settled
        ? `translate(${s.panX}px, ${s.panY}px) scale(${s.scale})`
        : `translate3d(${s.panX}px, ${s.panY}px, 0) scale(${s.scale})`;
    }
    updateLabel(s);
  }

  function step(s) {
    const k = reducedMotion() ? 1 : (s.resetting ? settings.resetLerp : settings.lerp);
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
    syncOverlays(s);
    s.transformEl.style.willChange = 'transform';
    clearTimeout(s.sharpenTimer);
    if (!s.animating) {
      s.animating = true;
      requestAnimationFrame(() => step(s));
    }
  }

  function cleanup(s) {
    clearTimeout(s.sharpenTimer);
    clearTimeout(s.hideTimer);
    s.transformEl.style.transform = '';
    s.transformEl.style.willChange = 'auto';
    s.clipEl.style.overflow = s.prevOverflow;
    if (s.toolbar) { s.toolbar.remove(); s.toolbar = null; }
    if (s.frame) { s.frame.remove(); s.frame = null; }
    panes.delete(s.clipEl);
  }

  function resetPane(s) { s.resetting = true; s.tScale = MIN_SCALE; s.tPanX = 0; s.tPanY = 0; startAnim(s); }
  function resetAll() { panes.forEach(resetPane); }

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
    let el = null;
    if (lastPointer) {
      const hit = document.elementFromPoint(lastPointer.x, lastPointer.y);
      const cand = hit && hit.closest ? hit.closest(PANE_SELECTORS) : null;
      if (cand && isZoomable(cand)) el = cand;
    }
    if (!el) el = activeEditor();
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

  // --- settings panel -------------------------------------------------------
  let panel = null;
  const CONTROLS = [
    { key: 'autoReset', label: 'Auto-reset after idle', type: 'bool' },
    { key: 'idleMs', label: 'Idle delay (ms)', type: 'num', step: 50, min: 100, max: 5000 },
    { key: 'autoHide', label: 'Auto-hide buttons', type: 'bool' },
    { key: 'outline', label: 'Outline zoomed pane', type: 'bool' },
    { key: 'motion', label: 'Motion', type: 'select',
      options: [{ value: 'on', label: 'On' }, { value: 'auto', label: 'Auto (OS)' }, { value: 'off', label: 'Off' }] },
    { key: 'invertScroll', label: 'Invert scroll direction', type: 'bool' },
    { key: 'maxScale', label: 'Max zoom (×)', type: 'num', step: 0.5, min: 1.5, max: 20 },
    { key: 'zoomSens', label: 'Zoom sensitivity', type: 'num', step: 0.002, min: 0.002, max: 0.05 },
    { key: 'panSens', label: 'Pan speed', type: 'num', step: 0.1, min: 0.1, max: 5 },
    { key: 'lerp', label: 'Smoothing (0–1)', type: 'num', step: 0.05, min: 0.05, max: 1 },
    { key: 'resetLerp', label: 'Reset glide (lower=slower)', type: 'num', step: 0.02, min: 0.02, max: 0.6 },
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

    CONTROLS.forEach((c) => panel.appendChild(buildRow(c)));

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
      e.preventDefault(); e.stopPropagation(); keyboardZoom(ZOOM_KEY_STEP);
    } else if (code === 'Minus' || code === 'NumpadSubtract') {
      e.preventDefault(); e.stopPropagation(); keyboardZoom(1 / ZOOM_KEY_STEP);
    } else if (code === 'Comma') {
      e.preventDefault(); e.stopPropagation(); togglePanel();
    }
  }, true);

  console.log(TAG, 'active — pinch / Ctrl+wheel to zoom, Ctrl+Alt+, for settings');
})();
