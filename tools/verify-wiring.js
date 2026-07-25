/* Static wiring check: every data-action has a handler, every getElementById
 * target exists. Run: node tools/verify-wiring.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const app = read('js/app.js');
const ui = read('js/ui.js');
const html = read('index.html');
const src = app + ui;

let failures = 0;
const report = (ok, msg) => { if (!ok) failures++; console.log((ok ? '  ok   ' : '  FAIL ') + msg); };

/* ---- data-action ↔ handler ---- */
/* Literal data-action="x", plus the names threaded through the btn() and
 * menuItem() helpers, which interpolate the action into the attribute. */
const used = new Set([
    ...[...(src + html).matchAll(/data-action="([a-zA-Z-]+)"/g)].map(m => m[1]),
    /* btn(label, action, slot.id, …) — label may be a ternary, so anchor on
     * the slot.id argument that always follows the action name. */
    ...[...app.matchAll(/,\s*'([a-zA-Z-]+)',\s*slot\.id/g)].map(m => m[1]),
    ...[...app.matchAll(/menuItem\('[^']*',\s*'[^']*',\s*'([a-zA-Z-]+)'/g)].map(m => m[1])
]);
const block = app.slice(app.indexOf('var actions = {'), app.indexOf('function offerRestore'));
const handlers = new Set(
    [...block.matchAll(/^ {8}'?([a-zA-Z-]+)'?: function/gm)].map(m => m[1])
);

console.log('\n── actions ──');
console.log('  handlers:', [...handlers].sort().join(', '));
const missing = [...used].filter(a => !handlers.has(a));
report(!missing.length, missing.length ? 'data-action with no handler: ' + missing.join(', ')
    : 'every data-action has a handler (' + used.size + ' distinct)');
const dead = [...handlers].filter(h => !used.has(h));
report(!dead.length, dead.length ? 'handler never emitted: ' + dead.join(', ') : 'no dead handlers');

/* ---- element ids ---- */
console.log('\n── DOM ids ──');
const staticIds = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
const dynamicIds = new Set(
    [...src.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1])
        .concat([...src.matchAll(/id="' \+ ([A-Za-z0-9_]+)/g)].map(() => null))
        .filter(Boolean)
);
const looked = [...src.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
const querySel = [...src.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
const bad = [...new Set(looked.concat(querySel))].filter(i => !staticIds.has(i) && !dynamicIds.has(i));
report(!bad.length, bad.length ? 'looked up but never rendered: ' + bad.join(', ')
    : 'all ' + new Set(looked).size + ' lookups resolve');

/* ---- css classes used in markup exist in stylesheets ---- */
console.log('\n── CSS coverage ──');
const css = read('css/theme.css') + read('css/app.css');
const declared = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1]));
const classAttrs = [...(src + html).matchAll(/class="([^"'+]+)"/g)].map(m => m[1]);
const usedClasses = new Set();
classAttrs.forEach(a => a.split(/\s+/).forEach(c => { if (c && !c.includes('$')) usedClasses.add(c); }));
const undeclared = [...usedClasses].filter(c => !declared.has(c));
report(!undeclared.length, undeclared.length ? 'classes with no rule: ' + undeclared.join(', ')
    : usedClasses.size + ' classes all have rules');

/* ---- script tags load in dependency order ---- */
console.log('\n── load order ──');
const scripts = [...html.matchAll(/<script src="(js\/[^"]+)"/g)].map(m => m[1]);
const expected = ['js/config.js', 'js/util.js', 'js/schedule.js', 'js/store.js',
    'js/auth.js', 'js/images.js', 'js/backup.js', 'js/ui.js', 'js/app.js'];
report(JSON.stringify(scripts) === JSON.stringify(expected),
    'scripts load in dependency order → ' + scripts.join(' → '));
scripts.forEach(s => report(fs.existsSync(path.join(root, s)), 'exists: ' + s));
[...html.matchAll(/<link rel="stylesheet" href="(css\/[^"]+)"/g)].map(m => m[1])
    .forEach(s => report(fs.existsSync(path.join(root, s)), 'exists: ' + s));

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'Wiring OK.') + '\n');
process.exit(failures ? 1 : 0);
