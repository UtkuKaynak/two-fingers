# twofingers

Chrome-style **pinch-to-zoom** for VSCode — magnify with a trackpad pinch, pan
with two fingers, snap back to 100%.

Zoom is scoped to the **editor pane under the cursor**: pinch over an editor and
only that editor magnifies, with the content clipped to the pane and panning
kept inside it. Each editor remembers its own zoom independently. Non-editor
areas (explorer, menus, status bar) are deliberately left alone.

While an editor is zoomed, a small **↺ reset button** appears in its top-right
corner — one click snaps that editor back to 100%.

## What it does (and doesn't)

It emulates Chrome's **pinch** zoom (the visual-viewport one): it *magnifies the
rendered pixels* and lets you pan. It does **not** re-lay-out the UI, change
font size, or reflow text — that's the menu / `Ctrl +/-` zoom, which is *not*
what this is.

> **Why emulation?** VSCode's workbench renderer is **sandboxed**, so injected
> JS cannot reach Electron's `webFrame` to turn on *native* pinch zoom. Instead
> we drive a CSS `transform: scale()` on the workbench root from the trackpad
> pinch (which the browser delivers as a `ctrl`+wheel event). Pure DOM/CSS, so
> it works inside the sandbox.

### Trade-offs vs. native pinch

- A transformed layer can look **soft while you're actively pinching**;
  Chromium generally re-rasterizes crisply once you settle at a zoom level.
- **Clicking while zoomed** may mis-place the text cursor in editors (Monaco's
  mouse math assumes 1:1 pixels). Fine for "zoom → glance → zoom back"; less
  ideal for editing while magnified.
- **Webviews can't be zoomed.** Anything rendered in a webview — the Claude Code
  panel, the extension-details/store pages, Markdown preview, the Settings UI —
  is an isolated, cross-origin, sandboxed `<iframe>`. Pinch events fire *inside*
  that iframe and never reach our top-level script, and we can't attach a
  listener inside it. This is the one case native pinch (`webFrame`) would have
  covered, but the sandbox blocks that path. Editors and the native workbench UI
  work; webview content does not.
- No relayout, real two-finger pan, instant reset.

## Try it first (no install)

Paste the contents of [`inject/twofingers.js`](inject/twofingers.js) into
**Help → Toggle Developer Tools → Console** and press Enter, then pinch over an
editor / the terminal / the Claude Code panel. It lasts until the next reload —
a zero-commitment way to judge the feel before installing.

## Install (persistent)

1. Install the **Custom CSS and JS Loader** extension (`be5invis.vscode-custom-css`).
2. Add the import to `settings.json` (adjust the path):
   ```json
   "vscode_custom_css.imports": [
     "file:///d:/projects/twofingers/inject/twofingers.js"
   ]
   ```
3. Command Palette → **"Enable Custom CSS and JS"**, then reload.
   On Windows you may need to launch VSCode **as administrator once** so the
   loader can patch the install directory.

After each VSCode update the patch is wiped — re-run **"Enable Custom CSS and JS"**.

## Usage

- **Pinch in / out** on the trackpad — zoom the editor toward the cursor.
- **Two-finger drag** while zoomed — pan. Horizontal moves within the line;
  vertical scrolls the editor, so you can reach lines outside the slice that was
  on screen when you zoomed.
- **↺ button** (top-right of a zoomed editor) — one click back to 100%.
- **`Ctrl+Alt+0`** (`Cmd+Alt+0` on macOS) — reset every zoomed editor.

## Tuning (`inject/twofingers.js`)

- `MAX_SCALE` — maximum magnification (`3` = 300%, `5` = 500%).
- `ZOOM_SENS` — pinch sensitivity (higher = faster).
- `PAN_SENS` — pan speed.
- `MIN_SCALE` — set below `1` to allow pinching out below 100%.
