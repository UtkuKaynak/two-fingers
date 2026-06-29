# two-fingers (extension)

Installs the [two-fingers](https://github.com/UtkuKaynak/two-fingers) zoom script
into VS Code by patching the workbench HTML, and re-applies it automatically
after VS Code updates (which wipe the patch).

## Build & install

```bash
cd extension
npm run package      # copies the script in, builds two-fingers-x.y.z.vsix
```

Then install the `.vsix`: Extensions view → `...` → **Install from VSIX**, or

```bash
code --install-extension two-fingers-0.1.2.vsix      # use code-insiders for Insiders
```

Reload when prompted. On user-scope VS Code installs no admin is needed; on
system-scope (Program Files) installs you'll be told to launch VS Code as admin
once.

## Commands

- **two-fingers: Enable (patch + reload)**
- **two-fingers: Disable (unpatch + reload)**
- **two-fingers: Reapply patch**

## Notes

This modifies VS Code's own files, so VS Code shows a cosmetic *"Your
installation appears corrupt"* banner — it's harmless and dismissable.
