// Copies the canonical injection script into the extension so it gets bundled
// into the .vsix. Run via `npm run build` (and `npm run package`).
'use strict';
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'inject', 'two-fingers.js');
const dst = path.join(__dirname, 'two-fingers.js');
fs.copyFileSync(src, dst);
console.log('two-fingers: copied inject/two-fingers.js -> extension/two-fingers.js');
