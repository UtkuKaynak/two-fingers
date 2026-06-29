# two-fingers

Chrome-style **pinch-to-zoom** for VSCode — magnify with a trackpad pinch, pan
with two fingers, snap back to 100%.

Zoom is scoped to the **editor pane under the cursor**: pinch over an editor and
only that editor magnifies, with the content clipped to the pane and panning
kept inside it. Each editor remembers its own zoom independently. Non-editor
areas (explorer, menus, status bar) are deliberately left alone.

While an editor is zoomed, a small toolbar appears in its top-right corner: a
**live `150%` readout** (click to snap back to 100%) and a **⚙ gear** that opens
the settings panel.

## What it does (and doesn't)

It emulates Chrome's **pinch** zoom (the visual-viewport one): it *magnifies the
rendered pixels* and lets you pan. It does **not** re-lay-out the UI, change
font size, or reflow text — that's the menu / `Ctrl +/-` zoom, which is *not*
what this is.

> **Why emulation?** VSCode's workbench renderer is **sandboxed**, so injected
> JS cannot reach Electron's `webFrame` to turn on *native* pinch zoom. Instead
> we drive a CSS `transform: scale()` on the editor pane from the trackpad
> pinch (which the browser delivers as a `ctrl`+wheel event). Pure DOM/CSS, so
> it works inside the sandbox.

### Trade-offs vs. native pinch

- A transformed layer can look **soft while you're actively pinching**;
  Chromium generally re-rasterizes crisply once you settle at a zoom level.
- **Clicking while zoomed** may mis-place the text cursor in editors (Monaco's
  mouse math assumes 1:1 pixels). Fine for "zoom → glance → zoom back"; less
  ideal for editing while magnified.
- **Webviews zoom too, with limits.** Webview-based views (Markdown preview, the
  Claude Code panel, the Settings UI) are isolated cross-origin `<iframe>`s, so a
  *gesture* can't start a zoom there (the events fire inside the iframe). Enter
  with the **⤢ button**, **`Ctrl+Alt+=`**, or **`Ctrl`+wheel/scroll** (with focus
  outside the iframe); a capture overlay then drives zoom/pan. While zoomed the
  view is **non-interactive** (overlay on top), and you can only pan within the
  **currently-visible** region (we can't scroll inside a cross-origin iframe).
  Best for read-only previews.
- No relayout, real two-finger pan, instant reset.

## Try it first (no install)

Paste the contents of [`inject/two-fingers.js`](inject/two-fingers.js) into
**Help → Toggle Developer Tools → Console** and press Enter, then pinch over a
code editor. It lasts until the next reload — a zero-commitment way to judge the
feel before installing.

## Install (persistent)

1. Install the **Custom CSS and JS Loader** extension (`be5invis.vscode-custom-css`).
2. Add the import to `settings.json` (adjust the path):
   ```json
   "vscode_custom_css.imports": [
     "file:///d:/projects/twofingers/inject/two-fingers.js"
   ]
   ```
3. Command Palette → **"Enable Custom CSS and JS"**, then reload.
   On Windows you may need to launch VSCode **as administrator once** so the
   loader can patch the install directory.

After each VSCode update the patch is wiped — re-run **"Enable Custom CSS and JS"**.

## Usage

- **Pinch in / out** (trackpad) — zoom the editor toward the cursor.
- **`Ctrl` + mouse-wheel** — same zoom, for people on a mouse (a pinch arrives as
  `Ctrl`+wheel anyway, so both go through the same path).
- **`Ctrl+Alt+=` / `Ctrl+Alt+-`** — zoom in / out from the keyboard. Targets the
  editor under the pointer, or the focused editor if the pointer is elsewhere.
- **Two-finger drag** while zoomed — pan. Horizontal moves within the line;
  vertical scrolls the editor, so you can reach lines outside the slice that was
  on screen when you zoomed.
- **`150%` button** (top-right of a zoomed editor) — click to reset to 100%.
- **`Ctrl+Alt+0`** — reset every zoomed editor.
- **`Ctrl+Alt+,`** — open / close the settings panel (also the ⚙ gear).
- **Webviews** (previews, Claude Code, Settings UI): click the **⤢ button** on the
  view, or `Ctrl+Alt+=`, or hold `Ctrl` and wheel/two-finger-scroll over it (with
  focus outside the iframe). Then drag / wheel / pinch to pan and zoom; `100%`
  resets. See the webview note under Trade-offs for the limits.

> On a **Turkish keyboard layout**, `Ctrl+Alt` is AltGr, so `Ctrl+Alt+=/-` may
> collide with character entry. Adjust **Keyboard step** in settings, or the key
> codes in the script, if needed.

## Settings

Open the panel with the **⚙ gear** or **`Ctrl+Alt+,`**. Everything is saved to
`localStorage`, so it persists across reloads (and VSCode updates):

| Setting | Default | What it does |
|---|---|---|
| Auto-reset after idle | off | Ease all panes back to 100% after a period of no activity |
| Idle delay (ms) | 500 | How long "no activity" waits before auto-reset |
| Auto-hide buttons | on | Fade the pane toolbar when idle |
| Outline zoomed pane | on | Subtle outline so you can tell which editor is magnified |
| Motion | On | Animate zoom/pan/reset. `On` always, `Off` instant, `Auto` follows the OS "reduce motion" setting |
| Invert scroll direction | off | Flip vertical pan |
| Max zoom (×) | 5 | Maximum magnification |
| Zoom sensitivity | 0.01 | Pinch speed (higher = faster) |
| Pan speed | 1 | Two-finger pan speed |
| Smoothing (0–1) | 0.35 | Animation easing (higher = snappier) |
| Reset glide | 0.1 | Speed of the zoom-out on reset (lower = slower) |
| Zoom webviews (previews) | on | Enable the ⤢ button and webview zoom |
| Ctrl+wheel/scroll on webviews | on | Hold `Ctrl` + wheel/scroll over a webview to enter zoom |
| Keyboard step (×) | 1.1 | Zoom factor per `Ctrl+Alt+=/-` press |
| Webview entry zoom (×) | 1.1 | Zoom level when entering a webview |

A **Reset to defaults** button is at the bottom of the panel.
