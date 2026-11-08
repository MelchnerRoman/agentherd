import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs web/index.html's script against a recording stub DOM and feeds it one state.
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

test('render() shows counts, cards, blocked list and task notes', () => {
  const els = {};
  const mkEl = () => ({ hidden: false, disabled: false, textContent: '', className: '', value: '', children: [],
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, style: {} });
  let es;
  const ctx = vm.createContext({
    document: { getElementById: (id) => (els[id] ??= mkEl()), createElement: mkEl, querySelectorAll: () => [] },
    Option: function () {}, EventSource: function () { es = this; }, fetch: () => new Promise(() => {}),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, location: {}, confirm: () => false, console,
  });
  vm.runInContext(script, ctx);

  const t = (id, status, extra = {}) => ({ id, title: `t${id}`, role: 'qa', status, attempts: 1, reviewRounds: 0, notes: [], ...extra });
  es.onmessage({ data: JSON.stringify({
    goal: 'g', folder: '/f', status: 'running', maxAgents: 3, agents: {}, activity: [],
    counts: { backlog: 1, in_progress: 0, review: 0, done: 1, blocked: 1 },
    tasks: [t(1, 'backlog'), t(2, 'done'), t(3, 'blocked', { notes: ['why stuck'] })],
  }) });

  const text = (e) => [e.textContent, ...e.children.map((c) => (typeof c === 'string' ? c : text(c)))].join('|');
  const cols = els.board.children.map(text);
  assert.equal(cols.length, 4);
  assert.match(cols[0], /Backlog\|1.*#1 t1/);
  assert.match(cols[1], /In progress\|0.*Nothing here/);
  assert.match(cols[3], /Done\|1.*#2 t2/);
  assert.match(text(els.blocked), /Blocked\|1.*#3 t3/);

  els.blocked.children[1].children[0].onclick(); // select blocked card
  assert.match(text(els.detail), /Notes.*why stuck/);
});
