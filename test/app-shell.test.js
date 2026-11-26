/**
 * Static checks for installed-app mode.
 *
 * The point of these tests is coverage: the installed app must not offer a tile that
 * goes nowhere. Every page in the sheet has to be a real route, and every WhatsApp
 * console tool has to have a real open function wired in the deep-link dispatcher.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const appmode = read('public/js/appmode.js');
const appjs = read('public/js/app.js');
const index = read('public/index.html');
const sw = read('public/sw.js');
const css = read('public/css/style.css');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  \u2713 ' + name); };

console.log('\nInstalled app shell');

ok('appmode.js is loaded by index.html', () => {
  assert.ok(/<script src="\/js\/appmode\.js"><\/script>/.test(index), 'script tag missing');
  // must load after app.js so `state` already exists
  assert.ok(index.indexOf('/js/app.js') < index.indexOf('/js/appmode.js'), 'appmode must load after app.js');
});

ok('appmode.js is precached so the installed app has it offline', () => {
  assert.ok(/'\s*\/js\/appmode\.js'\s*,?/.test(sw), 'not in SHELL');
  assert.ok(/ladybug-v8/.test(sw), 'cache version not bumped');
});

ok('app mode is detected from standalone display, ?app=1 and the stored flag', () => {
  assert.ok(/display-mode: standalone/.test(appmode));
  assert.ok(/display-mode: window-controls-overlay/.test(appmode));
  assert.ok(/navigator\.standalone === true/.test(appmode));
  assert.ok(/app=1/.test(appmode));
  assert.ok(/lb_app_mode/.test(appmode));
});

ok('the app shell builds a bar, a tab bar and a features sheet', () => {
  for (const id of ['appBar', 'appTabs', 'appSheet', 'appBarTitle', 'appSearch', 'appBell', 'appMenu']) {
    assert.ok(appmode.includes(id), 'missing ' + id);
  }
  assert.ok(/appbar/.test(appmode) && /apptabs/.test(appmode) && /appsheet/.test(appmode));
});

ok('the tab bar has home, chats, drive, activity and all', () => {
  for (const t of ['home', 'chats', 'drive', 'activity', 'more']) {
    assert.ok(new RegExp('data-tab="' + t + '"').test(appmode), 'missing tab ' + t);
  }
});

/* ---- every page in the sheet must be a real route ---- */
const pageHrefs = [...appmode.matchAll(/href: '#(\/[a-z]*)'/g)].map((m) => m[1]);
const routeKeys = [...appjs.matchAll(/^\s*'(\/[a-z]*)':\s*render[A-Za-z]+/gm)].map((m) => m[1]);

ok('the sheet lists 10 pages', () => {
  assert.strictEqual(pageHrefs.length, 10, 'found ' + pageHrefs.length + ': ' + pageHrefs.join(', '));
  assert.strictEqual(new Set(pageHrefs).size, 10, 'duplicate page');
});

ok('every page in the sheet is a real route', () => {
  const missing = pageHrefs.filter((h) => !routeKeys.includes(h));
  assert.deepStrictEqual(missing, [], 'routes not found: ' + missing.join(', '));
});

/* ---- every tool in the sheet must be wired to an open function ---- */
const toolIds = [...appmode.matchAll(/tool: '([a-z]+)'/g)].map((m) => m[1]);
const dispatch = /const TOOL = \{([\s\S]*?)\n      \};/.exec(appjs);
assert.ok(dispatch, 'deep-link TOOL map not found in app.js');
const wired = [...dispatch[1].matchAll(/^\s*([a-z]+):\s*\(\)/gm)].map((m) => m[1]);

ok('the sheet lists all 16 console tools', () => {
  assert.strictEqual(toolIds.length, 16, 'found ' + toolIds.length);
  assert.strictEqual(new Set(toolIds).size, 16, 'duplicate tool');
});

ok('every console tool has a deep-link handler', () => {
  const missing = toolIds.filter((t) => !wired.includes(t));
  assert.deepStrictEqual(missing, [], 'no handler for: ' + missing.join(', '));
  const extra = wired.filter((t) => !toolIds.includes(t));
  assert.deepStrictEqual(extra, [], 'handler without a tile: ' + extra.join(', '));
});

ok('each handler calls a module that exists', () => {
  const body = dispatch[1];
  for (const m of body.matchAll(/window\.(WA[A-Z]+)\s*&&\s*\1\.([A-Za-z]+)\(/g)) {
    const file = {
      WADIG: 'wa-digest', WACRM: 'wa-crm', WATR: 'wa-translate', WRADAR: 'wa-radar',
      WAPRO: 'wa-pro', WALBL: 'wa-labels', WAGAL: 'wa-gallery', WACON: 'wa-contacts',
      WAGRP: 'wa-groups', WASTAT: 'wa-status', WACHAN: 'wa-channels', WAAUTO: 'wa-auto',
      WAX: 'wa-extras', WAACC: 'wa-accounts',
    }[m[1]];
    assert.ok(file, 'unknown module ' + m[1]);
    const src = read('public/js/' + file + '.js');
    assert.ok(new RegExp('\\b' + m[2] + '\\b').test(src), m[1] + '.' + m[2] + ' not found in ' + file + '.js');
  }
});

ok('the deep link is stripped from the hash after it runs', () => {
  assert.ok(/history\.replaceState/.test(appjs));
  assert.ok(/\[\?&\]tool=\(\[\^&\]\+\)/.test(appjs));
});

/* ---- the look must differ from the website ---- */
ok('the website nav is replaced, not duplicated', () => {
  assert.ok(/html\[data-app="1"\] \.nav \{ display: none; \}/.test(css), 'nav not hidden in app mode');
});

ok('the app shell has its own styles', () => {
  for (const sel of ['.appbar', '.apptabs', '.apptab', '.appsheet', '.appsheet-card', '.appsheet-grid', '.apptile', '.appbar-btn', '.appbar-dot']) {
    assert.ok(css.includes(sel + ' {') || css.includes(sel + ' {'), 'missing style ' + sel);
  }
  assert.ok(/\.appbar \{[\s\S]*?position: fixed/.test(css), 'app bar is not fixed');
  assert.ok(/\.apptabs \{[\s\S]*?position: fixed/.test(css), 'tab bar is not fixed');
  assert.ok(/linear-gradient/.test(/\.appbar \{[\s\S]*?\}/.exec(css)[0]), 'app bar has no gradient');
});

ok('body padding only applies when the app chrome is showing', () => {
  assert.ok(/html\[data-app-chrome="1"\] body \{/.test(css));
  assert.ok(/data-app-chrome/.test(appmode), 'appmode never sets the chrome flag');
});

ok('the console is full-bleed, so the chrome steps aside', () => {
  assert.ok(/var chrome = authed && p !== '\/web';/.test(appmode));
});

ok('the sheet closes on Escape and on navigation', () => {
  assert.ok(/e\.key === 'Escape'\) close\(\)/.test(appmode));
  assert.ok(/addEventListener\('hashchange', close\)/.test(appmode));
});

ok('search in the app bar reuses the command palette', () => {
  assert.ok(/LBPAL\.open\(\)/.test(appmode));
});

ok('the bell badge mirrors the website unread count', () => {
  assert.ok(/navActN/.test(appmode));
});

ok('the website build is untouched when not in app mode', () => {
  assert.ok(/window\.LBAPP = \{ on: false, open: function \(\) \{\}, close: function \(\) \{\}, refresh: function \(\) \{\} \};/.test(appmode));
});

console.log('\n' + pass + ' passed, 0 failed');
