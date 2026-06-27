// twofingers — Chrome-style pinch zoom for VSCode (sandbox-safe DOM emulation)
// ---------------------------------------------------------------------------
// VSCode's workbench renderer is sandboxed, so we cannot reach Electron's
// webFrame to enable *native* pinch zoom. Instead we emulate Chrome's pinch
// (visual-viewport) behaviour purely in the DOM: a trackpad pinch arrives as a
// `wheel` event with `ctrlKey === true`, and we respond by applying a CSS
// `transform: scale()` — magnifying the rendered UI WITHOUT re-laying-out
// anything, exactly like a pinch (not like the menu / `Ctrl +/-` zoom).
//
// Scope: the transform is applied to the single *pane under the cursor* (the
// `.editor-instance`), clipped by its parent, so only that editor zooms and the
// content stays inside the pane. Other surfaces fall back to the whole
// workbench. Each pane remembers its own zoom independently.
//
// Smoothness: we lerp toward a target scale/pan every frame (so spiky trackpad
// deltas don't jump), render on a GPU layer (`translate3d` + `will-change`)
// while moving, then drop to a plain 2D transform once settled so Chromium
// re-rasterizes the text crisply.
//
// Loaded via the "Custom CSS and JS Loader" extension. Pure DOM/CSS, so it
// works even though `require('electron')` is unavailable.
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  const TAG = '[twofingers]';

  // --- tuning ---------------------------------------------------------------
  const MIN_SCALE = 1;     // 1 = never shrink below 100%
  const MAX_SCALE = 5;     // max magnification (3 = 300%, 5 = 500%)
  const ZOOM_SENS = 0.01;  // pinch sensitivity (higher = faster zoom)
  const PAN_SENS = 1;      // two-finger pan speed multiplier
  const PAN_DIR = -1;      // vertical scroll-forward direction (flip if inverted)
  const LERP = 0.35;       // motion smoothing per frame (0..1; higher = snappier)
  const SHARPEN_MS = 160;  // idle delay before dropping to a crisp 2D raster
  // Pane we zoom (transform this element, clip with its parent). Editor only:
  // webviews can't be reached, and the whole-window fallback is intentionally
  // off so explorer / menus / status bar are never zoomed.
  const PANE_SELECTORS = '.editor-instance';
  // --------------------------------------------------------------------------

  // clipEl -> per-pane state
  const panes = new Map();

  function resolve(target) {
    // Only zoom an editor pane under the cursor — no whole-window fallback.
    const el = target && target.closest ? target.closest(PANE_SELECTORS) : null;
    if (!el || !el.parentElement) return null;
    return el;
  }

  function getState(transformEl, create) {
    const clipEl = transformEl.parentElement;
    let s = panes.get(clipEl);
    if (s) return s;
    if (!create) return null;
    const r = clipEl.getBoundingClientRect();
    s = {
      transformEl,
      clipEl,
      prevOverflow: clipEl.style.overflow,
      baseLeft: r.left,
      baseTop: r.top,
      baseW: r.width,
      baseH: r.height,
      scale: 1, panX: 0, panY: 0,          // current (animated)
      tScale: 1, tPanX: 0, tPanY: 0,       // target
      animating: false,
      sharpenTimer: 0,
    };
    transformEl.style.transformOrigin = '0 0';
    clipEl.style.overflow = 'hidden';
    s.button = makeButton(s);
    panes.set(clipEl, s);
    return s;
  }

  // A small floating "reset" button pinned to the top-right of a zoomed pane.
  // Click → animate that pane back to 100%. Lives in <body> (un-transformed) so
  // it stays crisp and screen-fixed while the editor under it is magnified.
  function makeButton(s) {
    const b = document.createElement('button');
    b.textContent = '↺';
    b.title = 'Reset zoom (Ctrl+Alt+0)';
    b.setAttribute('aria-label', 'Reset zoom');
    b.style.cssText =
      'position:fixed;z-index:2147483647;width:32px;height:32px;display:none;' +
      'align-items:center;justify-content:center;border:none;border-radius:6px;' +
      'cursor:pointer;background:rgba(40,40,40,0.85);color:#fff;font-size:18px;' +
      'line-height:1;padding:0;box-shadow:0 2px 8px rgba(0,0,0,0.45);' +
      '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);';
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    b.addEventListener('mousedown', stop, true);
    b.addEventListener('wheel', stop, true);
    b.addEventListener('click', function (e) {
      stop(e);
      s.tScale = MIN_SCALE;
      s.tPanX = 0;
      s.tPanY = 0;
      startAnim(s);
    });
    document.body.appendChild(b);
    return b;
  }

  function syncButton(s) {
    const b = s.button;
    if (!b) return;
    if (s.tScale > MIN_SCALE + 0.0005) {
      b.style.left = s.baseLeft + s.baseW - 44 + 'px';
      b.style.top = s.baseTop + 12 + 'px';
      b.style.display = 'flex';
    } else {
      b.style.display = 'none';
    }
  }

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
      return;
    }
    if (settled) {
      // Plain 2D transform → Chromium re-rasterizes at the new scale (sharp).
      el.style.transform = `translate(${s.panX}px, ${s.panY}px) scale(${s.scale})`;
    } else {
      // 3D transform → cheap GPU-composited scaling (smooth while moving).
      el.style.transform =
        `translate3d(${s.panX}px, ${s.panY}px, 0) scale(${s.scale})`;
    }
  }

  function step(s) {
    s.scale += (s.tScale - s.scale) * LERP;
    s.panX += (s.tPanX - s.panX) * LERP;
    s.panY += (s.tPanY - s.panY) * LERP;

    const done =
      Math.abs(s.tScale - s.scale) < 0.001 &&
      Math.abs(s.tPanX - s.panX) < 0.5 &&
      Math.abs(s.tPanY - s.panY) < 0.5;

    if (done) {
      s.scale = s.tScale;
      s.panX = s.tPanX;
      s.panY = s.tPanY;
      render(s, true);
      s.animating = false;
      if (s.scale <= MIN_SCALE + 0.0005) {
        cleanup(s);
      } else {
        // Hold the GPU layer briefly, then drop will-change so the next paint
        // is a crisp non-composited raster.
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
    syncButton(s);
    s.transformEl.style.willChange = 'transform';
    clearTimeout(s.sharpenTimer);
    if (!s.animating) {
      s.animating = true;
      requestAnimationFrame(() => step(s));
    }
  }

  function cleanup(s) {
    clearTimeout(s.sharpenTimer);
    s.transformEl.style.transform = '';
    s.transformEl.style.willChange = 'auto';
    s.clipEl.style.overflow = s.prevOverflow;
    if (s.button) { s.button.remove(); s.button = null; }
    panes.delete(s.clipEl);
  }

  // Forward vertical panning to Monaco's own scroll. The editor virtualizes —
  // only the lines visible when you zoomed exist in the DOM — so a transform
  // can't reveal lines outside that slice. Scrolling the editor makes it render
  // them. deltaY is converted from screen px to the editor's (unscaled) px.
  function scrollEditor(s, deltaYLayout) {
    const target =
      s.transformEl.querySelector('.editor-scrollable') ||
      s.transformEl.querySelector('.monaco-scrollable-element') ||
      s.transformEl.querySelector('.lines-content') ||
      s.transformEl;
    const ev = new WheelEvent('wheel', {
      deltaY: deltaYLayout,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
    });
    ev.__twofingers = true; // so our own capture listener ignores it
    target.dispatchEvent(ev);
  }

  function zoomAt(s, clientX, clientY, factor) {
    const X = clientX - s.baseLeft;
    const Y = clientY - s.baseTop;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s.tScale * factor));
    if (next === s.tScale) return;
    // Keep the point under the cursor fixed on screen.
    const worldX = (X - s.tPanX) / s.tScale;
    const worldY = (Y - s.tPanY) / s.tScale;
    s.tScale = next;
    s.tPanX = X - next * worldX;
    s.tPanY = Y - next * worldY;
    clampTarget(s);
    startAnim(s);
  }

  // Pinch (ctrl+wheel) → zoom the pane under the cursor.
  // Two-finger scroll over an already-zoomed pane → pan it.
  window.addEventListener(
    'wheel',
    function (e) {
      if (e.__twofingers) return; // our own forwarded scroll — let it through
      if (e.ctrlKey) {
        const el = resolve(e.target);
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        zoomAt(getState(el, true), e.clientX, e.clientY,
          Math.exp(-e.deltaY * ZOOM_SENS));
        return;
      }
      const el = resolve(e.target);
      const s = el ? getState(el, false) : null;
      if (s && s.tScale > MIN_SCALE) {
        e.preventDefault();
        e.stopPropagation();
        // Horizontal: pan within the rendered content via transform (the whole
        // line is in the DOM, so this reaches the full line width).
        if (e.deltaX) {
          s.tPanX -= e.deltaX * PAN_SENS;
          clampTarget(s);
          startAnim(s);
        }
        // Vertical: scroll the editor itself so it renders lines beyond the
        // originally-visible slice. PAN_DIR corrects the sign inversion from
        // forwarding a synthetic wheel (Monaco's legacy wheelDelta handling).
        if (e.deltaY) {
          scrollEditor(s, (PAN_DIR * e.deltaY * PAN_SENS) / s.tScale);
        }
      }
    },
    { capture: true, passive: false }
  );

  // Reset all zoomed panes: Ctrl+Alt+0 (Cmd+Alt+0 on macOS).
  window.addEventListener(
    'keydown',
    function (e) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.altKey && (e.key === '0' || e.code === 'Digit0')) {
        e.preventDefault();
        e.stopPropagation();
        panes.forEach((s) => {
          s.tScale = MIN_SCALE;
          s.tPanX = 0;
          s.tPanY = 0;
          startAnim(s);
        });
        console.log(TAG, 'reset all panes to 100%');
      }
    },
    true
  );

  console.log(TAG, 'per-pane pinch-zoom active (ctrl+wheel / trackpad pinch)');
})();
