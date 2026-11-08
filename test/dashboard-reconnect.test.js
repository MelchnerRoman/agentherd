import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs web/index.html's inline script against a stubbed DOM, fetch, EventSource and timers.
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

function load(fetchImpl) {
  const els = {};
  const stub = () => ({ hidden: false, disabled: false, textContent: '', className: '', value: '', children: [],
    append() {}, replaceChildren() {}, style: {} });
  const timers = [];
  const sources = [];
  const fetches = [];
  const ctx = vm.createContext({
    document: { getElementById: (id) => (els[id] ??= stub()), createElement: stub, querySelectorAll: () => [] },
    Option: function () {},
    EventSource: function () { sources.push(this); this.close = () => {}; },
    fetch: (p) => { fetches.push(p); return fetchImpl(fetches.length); },
    setTimeout: (fn, ms) => { if (ms < 8000) timers.push(fn); return 0; }, // ignore flash()'s 8s hide timer
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    location: { reload() {} }, confirm: () => false, console,
  });
  vm.runInContext(script, ctx);
  // fire the next pending timer and let its promise chain settle
  const tick = async () => { timers.shift()(); await new Promise((r) => setImmediate(r)); };
  return { els, sources, fetches, timers, tick };
}

const ok = { ok: true };
const stopped = (els) => els.status?.textContent === 'stopped' || els.banner?.className === 'banner stop';

for (const [name, bad] of [['rejected fetch', () => Promise.reject(new Error('down'))],
                           ['non-OK response', () => Promise.resolve({ ok: false, status: 502 })]]) {
  test(`${name} keeps retrying, no "Team stopped", banner clears on success`, async () => {
    const d = load((n) => (n <= 2 ? bad() : Promise.resolve(ok)));
    assert.equal(d.sources.length, 1);

    d.sources[0].onerror();
    assert.match(d.els.conn.textContent, /Disconnected/);
    assert.equal(d.els.conn.hidden, false);

    await d.tick(); // 1st probe fails
    assert.equal(d.fetches.length, 1);
    assert.equal(d.timers.length, 1, 'retry scheduled');
    assert.ok(!stopped(d.els));

    await d.tick(); // 2nd probe fails
    assert.equal(d.timers.length, 1, 'still retrying');
    assert.ok(!stopped(d.els));
    assert.equal(d.sources.length, 1);

    await d.tick(); // 3rd probe succeeds -> reconnects
    assert.equal(d.sources.length, 2, 'new EventSource opened');
    assert.equal(d.timers.length, 0);
    assert.ok(!stopped(d.els));
    assert.equal(d.els.conn.hidden, false, 'banner stays until the stream is open');

    d.sources[1].onopen();
    assert.equal(d.els.conn.hidden, true, 'Disconnected banner cleared');
  });
}
