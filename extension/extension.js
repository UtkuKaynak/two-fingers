// two-fingers — VS Code patcher extension
// ---------------------------------------------------------------------------
// VS Code's workbench renderer is sandboxed, so an extension can't inject into
// it directly. This extension does what the "Custom CSS and JS" loaders do: it
// writes our injection script into the workbench HTML that the renderer loads.
// A VS Code update rewrites that file (wiping the patch), so on every launch we
// check and re-apply, prompting a single reload. Patching needs write access to
// VS Code's install dir — free on user-scope installs, admin-once on system
// installs (we surface a clear message if the write is denied).
// ---------------------------------------------------------------------------
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const START = '<!-- two-fingers:start -->';
const END = '<!-- two-fingers:end -->';
const INJECTED_NAME = 'two-fingers.injected.js';
const VERSION_KEY = 'two-fingers.patchedVersion';

function currentVersion(context) {
  return (context.extension && context.extension.packageJSON.version) || '0';
}

// Candidate workbench HTML files inside the *running* VS Code (any variant /
// location), discovered via env.appRoot — no hardcoded install paths.
function workbenchFiles() {
  const base = path.join(vscode.env.appRoot, 'out', 'vs', 'code');
  const names = ['workbench.html', 'workbench.esm.html', 'workbench-dev.html'];
  const dirs = [
    path.join(base, 'electron-sandbox', 'workbench'),
    path.join(base, 'electron-browser', 'workbench'),
  ];
  const found = [];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (fs.existsSync(p)) found.push(p);
    }
  }
  return found;
}

function stripBlock(html) {
  const s = html.indexOf(START);
  const e = html.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) {
    return html.slice(0, s) + html.slice(e + END.length).replace(/^\n/, '');
  }
  return html;
}

function patchOne(file, context) {
  const dir = path.dirname(file);
  // Inline scripts are blocked by the workbench CSP, but `script-src 'self'`
  // allows a same-origin file: drop the script next to workbench.html and load
  // it with a relative <script src>.
  fs.copyFileSync(path.join(context.extensionPath, 'two-fingers.js'), path.join(dir, INJECTED_NAME));
  let html = stripBlock(fs.readFileSync(file, 'utf8')); // remove any stale block
  const block = `${START}<script src="${INJECTED_NAME}"></script>${END}\n`;
  html = html.includes('</html>')
    ? html.replace('</html>', block + '</html>')
    : html + '\n' + block;
  fs.writeFileSync(file, html, 'utf8');
}

function isPatched(file) {
  try { return fs.readFileSync(file, 'utf8').includes(START); }
  catch (e) { return false; }
}

function reloadPrompt(message) {
  vscode.window.showInformationMessage(message, 'Reload').then((choice) => {
    if (choice === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
  });
}

function writeError(e) {
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
    vscode.window.showErrorMessage(
      'two-fingers: could not write VS Code’s files. Launch VS Code as administrator once, then run "two-fingers: Reapply patch".'
    );
  } else {
    vscode.window.showErrorMessage('two-fingers: patch failed — ' + (e && e.message));
  }
}

function enable(context) {
  const files = workbenchFiles();
  if (!files.length) {
    vscode.window.showErrorMessage('two-fingers: could not locate the workbench HTML to patch.');
    return;
  }
  try {
    files.forEach((f) => patchOne(f, context));
  } catch (e) {
    writeError(e);
    return;
  }
  context.globalState.update(VERSION_KEY, currentVersion(context));
  reloadPrompt('two-fingers installed. Reload to activate.');
}

function disable() {
  const files = workbenchFiles();
  try {
    files.forEach((f) => {
      if (isPatched(f)) fs.writeFileSync(f, stripBlock(fs.readFileSync(f, 'utf8')), 'utf8');
      const inj = path.join(path.dirname(f), INJECTED_NAME);
      if (fs.existsSync(inj)) fs.unlinkSync(inj);
    });
  } catch (e) {
    writeError(e);
    return;
  }
  reloadPrompt('two-fingers removed. Reload to apply.');
}

const ENABLED_KEY = 'two-fingers.enabled';

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('two-fingers.enable', () => {
      context.globalState.update(ENABLED_KEY, true);
      enable(context);
    }),
    vscode.commands.registerCommand('two-fingers.reapply', () => enable(context)),
    vscode.commands.registerCommand('two-fingers.disable', () => {
      context.globalState.update(ENABLED_KEY, false);
      disable();
    })
  );

  // Auto-apply on launch, unless the user explicitly disabled it. If already
  // patched, this session is live — do nothing. If not (fresh install, or a
  // VS Code update wiped the patch), re-apply and offer a single reload.
  if (context.globalState.get(ENABLED_KEY, true) === false) return;
  const files = workbenchFiles();
  if (!files.length) return;
  // Re-apply if not patched (a VS Code update wiped it) or if this extension
  // version patched differently than what's on disk (upgrades the patch).
  const fresh = files.some(isPatched) && context.globalState.get(VERSION_KEY) === currentVersion(context);
  if (fresh) return;
  try {
    files.forEach((f) => patchOne(f, context));
    context.globalState.update(VERSION_KEY, currentVersion(context));
    reloadPrompt('two-fingers (re)applied. Reload to activate.');
  } catch (e) {
    writeError(e);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
