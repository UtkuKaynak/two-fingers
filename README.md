# two-fingers

Pinch or scroll to zoom into VS Code editors and previews — magnify, pan around,
snap back. Basically Chrome's pinch-zoom, but for the editor pane.

It's a hack, and I'd rather be upfront about it: VS Code's UI runs in a sandboxed
renderer, so there's no supported way to do this. two-fingers injects a small
script into the workbench by patching VS Code's own HTML — the same trick the
"Custom CSS/JS" loaders use. Two consequences: VS Code shows a cosmetic *"Your
installation appears corrupt"* banner, and every VS Code update wipes the patch.
The bundled extension re-applies it for you on the next launch (one reload).

Fair warning — this was **vibe-coded** in a long "can we even do this?" session.
It works nicely for me on VS Code Insiders, but it's unofficial, unsupported, and
pokes at internals. Use it because it's handy and fun, not because it's bulletproof.

## What you get

- **Editors** — pinch (trackpad) or `Ctrl`+wheel (mouse) to zoom toward the
  cursor; two-finger drag to pan; `Ctrl+Alt+=` / `-` for keyboard zoom. Each
  split remembers its own zoom. It's a real content magnify (crisp, no reflow),
  not the menu's `Ctrl +/-` UI zoom.
- **Webviews** (Markdown preview, the Claude Code panel, Settings UI) — a small
  **⤢** button, `Ctrl+Alt+=`, or `Ctrl`+wheel/scroll starts the zoom, then
  drag / wheel / pinch to move around. (See limits.)
- **Reset** — click the `%` readout in the corner, or `Ctrl+Alt+0`.
- **Settings** — the **⚙** gear (or `Ctrl+Alt+,`) opens a panel: sensitivity,
  max zoom, smoothing, auto-reset-on-idle, webview toggles, and more. Saved
  across reloads.

## Try it first (no install)

**Help → Toggle Developer Tools → Console**, paste the contents of
[`inject/two-fingers.js`](inject/two-fingers.js), press Enter. It lasts until you
reload the window — zero commitment, no patching.

## Install (persistent)

The extension delivers the script and keeps it alive across VS Code updates.

```bash
cd extension
npm run package        # copies the script in and builds two-fingers-0.1.2.vsix
```

Install the `.vsix` (Extensions view → `···` → **Install from VSIX**, or
`code --install-extension two-fingers-0.1.2.vsix` — use `code-insiders` for
Insiders), then **Reload** when prompted.

- **No admin** on user-scope installs (the common case). System-scope
  (`Program Files`) installs need an elevated launch once — the extension tells
  you if a write is denied.
- Commands: **two-fingers: Enable / Disable / Reapply** in the Command Palette.

## Limits (the honest part)

- **Webviews** are isolated cross-origin iframes: a *gesture* can't start their
  zoom (use ⤢ / `Ctrl`+wheel with focus outside the iframe), interaction is
  **suspended** while one is zoomed, and you can only pan the **currently-visible**
  region. Best for read-only previews.
- **Clicking** in a heavily-zoomed text editor can land slightly off (Monaco
  assumes 1:1 pixels). Right-click auto-resets the pane so menus open correctly.
- Trackpad **pinch can't initiate** a webview zoom — editors only.

## How it works

[`inject/two-fingers.js`](inject/two-fingers.js) is the whole thing: it catches
pinch / `Ctrl`+wheel, applies a CSS `transform: scale()` to the pane under the
cursor (crisp, no relayout), and forwards vertical pan to the editor's own scroll
so virtualized lines still render. Webviews get a capture overlay since their
events live inside the iframe. The [`extension/`](extension/) folder just delivers
that script and re-patches after updates.

## License

MIT
