#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { loadState, createState } from '../src/store.js';
import { ensureDaemon, readDaemon, api } from '../src/client.js';
import { startTui, openUrl } from '../src/tui.js';

const folder = process.cwd();
const USAGE = `agentHerd – a team of six Claude agents working on the current folder

Usage:
  agentherd         start (or attach to) the team and watch it live
  agentherd stop    stop the team
  agentherd web     open the web dashboard
  agentherd help    show this text`;

const [cmd] = process.argv.slice(2);

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(USAGE);
} else if (cmd === 'stop') {
  const d = readDaemon(folder);
  if (!d) console.log('not running');
  else { await api(d.port, 'POST', '/api/control', { action: 'stop' }); console.log('Team stopped.'); }
} else if (cmd === 'web') {
  const { port } = await ensureDaemon(folder);
  openUrl(`http://localhost:${port}`);
} else if (cmd) {
  console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
  process.exit(1);
} else {
  if (!loadState(folder)) {
    const existingCode = fs.readdirSync(folder).some((f) => !['.git', '.agentherd', '.DS_Store'].includes(f));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let goal = '';
    while (!goal) {
      goal = (await rl.question('What should the team build? (an idea, a direction, or leave empty to have them study this code and improve it)\n> ')).trim();
      if (!goal && existingCode) goal = 'Understand this codebase and improve it';
    }
    rl.close();
    createState(folder, { goal, existingCode });
  }
  const { port } = await ensureDaemon(folder);
  startTui(port, folder);
}
