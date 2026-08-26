/* Build: assemble src/ + vendor/ into a single self-contained index.html at the project root
   Source layout:
     src/index.html   — template with injection markers
     src/styles.css   — all styles
     src/calc.js      — capacity calculation engine (also unit-tested via `npm test`)
     src/app.jsx      — React app (JSX, precompiled here so the browser needs no Babel)
     vendor/          — React + ReactDOM UMD production builds (inlined)
   Output: ./index.html — ONE file with every dependency written into it. */
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const template = read('src/index.html');
const css = read('src/styles.css');
const react = read('vendor/react.production.min.js');
const reactDom = read('vendor/react-dom.production.min.js');
const calc = read('src/calc.js').replace(/if \(typeof module[^\n]*\n?/, ''); // strip Node-only export
const appCompiled = babel.transformSync(read('src/app.jsx'), {
  presets: [['@babel/preset-react', { runtime: 'classic' }]],
  compact: false,
}).code;

// Replacements are functions so `$` sequences in minified vendor code are never interpreted.
const out = template
  .replace('/*__CSS__*/', () => css)
  .replace('/*__VENDOR_REACT__*/', () => '/* React UMD (production) */\n' + react)
  .replace('/*__VENDOR_REACT_DOM__*/', () => '/* ReactDOM UMD (production) */\n' + reactDom)
  .replace('/*__CALC__*/', () => calc)
  .replace('/*__APP__*/', () => appCompiled);

fs.writeFileSync(path.join(__dirname, 'index.html'), out);
console.log('index.html written,', (out.length / 1024).toFixed(0) + ' KB');
