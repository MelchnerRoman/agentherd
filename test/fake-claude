#!/usr/bin/env node
if (process.env.FAKE_MODE === 'hang') setTimeout(() => {}, 30000);
else {
const assistant = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.js' } }] } };
console.log(JSON.stringify(assistant));
const limit = process.env.FAKE_MODE === 'limit';
console.log(JSON.stringify(limit
  ? { type: 'result', subtype: 'error', is_error: true, result: 'Claude usage limit reached' }
  : { type: 'result', subtype: 'success', is_error: false, result: 'ok', structured_output: { status: 'done', summary: 'ok', newTasks: [] } }));
}
