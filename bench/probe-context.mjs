import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const model = process.argv[2];
if (!model) throw new Error('Usage: node bench/probe-context.mjs MODEL');
const request = JSON.parse(readFileSync(join(root, '..', 'runtime', 'long-meeting-max-request.json'), 'utf8'));
request.model = model;
request.options.num_predict = 1;
const response = await fetch('http://127.0.0.1:11434/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request), signal: AbortSignal.timeout(600_000),
});
if (!response.ok) throw new Error(`OLLAMA_${response.status}`);
const body = await response.json();
console.log(JSON.stringify({ model, promptCharacters: request.messages[1].content.length,
  promptTokens: body.prompt_eval_count, configuredContextTokens: request.options.num_ctx,
  evidenceChoices: request.format.properties.topics.items.properties.evidenceUtteranceIds.items.enum.length }));
