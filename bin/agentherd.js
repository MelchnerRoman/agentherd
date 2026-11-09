#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadState, createState } from '../src/store.js';
import { ensureDaemon, readDaemon, api, stopOtherTeams } from '../src/client.js';
import { startTui, openUrl } from '../src/tui.js';

const folder = process.cwd();
const USAGE = `agentHerd – a team of six Claude agents working on the current folder

Usage:
  agentherd         start (or attach to) the team and watch it live
  agentherd stop    stop the team
  agentherd web     open the web dashboard
  agentherd help    show this text`;

const [cmd] = process.argv.slice(2);
const startTeam = async () => {
  for (const f of await stopOtherTeams(folder)) console.log(`Stopped the team in ${f} (only one team runs at a time).`);
  return ensureDaemon(folder);
};

try {

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
  } else if (cmd === 'stop') {
    const d = readDaemon(folder);
    if (!d) console.log('not running');
    else {
      try { await api(d.port, 'POST', '/api/control', { action: 'stop' }); console.log('Team stopped.'); }
      catch { fs.rmSync(path.join(folder, '.agentherd', 'daemon.json'), { force: true }); console.log('not running'); }
    }
  } else if (cmd === 'web') {
    const { port } = await startTeam();
    openUrl(`http://localhost:${port}`);
  } else if (cmd) {
    console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(1);
  } else {
    if (!loadState(folder)) {
      const existingCode = fs.readdirSync(folder).some((f) => !['.git', '.agentherd', '.DS_Store'].includes(f));
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const eof = new Promise((r) => rl.once('close', () => r(null)));
      let goal = '';
      while (!goal) {
        const a = await Promise.race([eof, rl.question('What should the team build? (an idea, a direction, or leave empty to have them study this code and improve it)\n> ')]);
        if (a === null) { console.error('No goal given.'); process.exit(1); }
        goal = a.trim();
        if (!goal && existingCode) goal = 'Understand this codebase and improve it';
      }
      rl.close();
      createState(folder, { goal, existingCode });
    }
    const { port } = await startTeam();
    startTui(port, folder);
  }
} catch (e) {
  console.error(`Could not reach the team's background process: ${e.message}`);
  process.exit(1);
}
