// Run inside the built Linux image with this file mounted at /app/gpu-handoff-smoke.mjs.
import assert from 'node:assert/strict';

const model = process.env.OLLAMA_MODEL ?? 'qwen3.5:9b';
const ollama = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const stt = process.env.STT_BASE_URL ?? 'http://127.0.0.1:8765';
const unload = await fetch(`${ollama}/api/generate`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model, prompt: '', keep_alive: 0, stream: false }),
});
assert.equal(unload.status, 200);
const loaded = await (await fetch(`${ollama}/api/ps`)).json();
assert.ok(!loaded.models.some((entry) => entry.name === model), 'Ollama model still occupies GPU memory');
const sttLoad = await fetch(`${stt}/admin/load`, { method: 'POST' });
assert.equal(sttLoad.status, 200);
assert.equal((await (await fetch(`${stt}/ready`)).json()).ready, true);
const sttUnload = await fetch(`${stt}/admin/unload`, { method: 'POST' });
assert.equal(sttUnload.status, 200);
assert.equal((await (await fetch(`${stt}/ready`)).json()).ready, false);
console.log('Ollama-to-Whisper GPU handoff and release passed');
