// Run inside the built Linux image with this file mounted at /app/audio-smoke.mjs.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import OpusScript from 'opusscript';
import { AudioReceiver } from './dist/audio.js';
import { Store } from './dist/db.js';
import { AudioBudget } from './dist/stt.js';

const store = new Store(':memory:');
const meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u', title: null, config_snapshot_json: '{}' });
store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
store.join(meeting.id, 'u', 'Speaker');
let subscriptions = 0;
let stream;
const receiver = { subscribe: () => { subscriptions++; stream = new PassThrough(); return stream; } };
const jobs = [];
const queue = { enqueue: (job) => jobs.push(job) };
const budget = new AudioBudget(() => {});
const audio = new AudioReceiver(receiver, meeting.id, Date.now(), store, queue, budget, (reason) => { throw new Error(reason); });
assert.equal(subscriptions, 0, 'no audio subscription before consent');
audio.subscribe('u');
const opus = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
const tone = Buffer.alloc(960 * 2 * 2);
for (let i = 0; i < 960; i++) {
  const sample = Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 4000);
  tone.writeInt16LE(sample, i * 4);
  tone.writeInt16LE(sample, i * 4 + 2);
}
for (let i = 0; i < 50; i++) stream.write(opus.encode(tone, 960));
await new Promise((resolve) => setTimeout(resolve, 200));
await audio.stop();
assert.equal(subscriptions, 1);
assert.equal(jobs.length, 1);
assert.ok(jobs[0].audio.length >= 30_000 && jobs[0].audio.length <= 34_000, `unexpected PCM length ${jobs[0].audio.length}`);
assert.equal(store.utterances(meeting.id).length, 1);
const beforeRevoke = jobs.length;
const second = new AudioReceiver(receiver, meeting.id, Date.now(), store, queue, budget, (reason) => { throw new Error(reason); });
second.subscribe('u');
for (let i = 0; i < 10; i++) stream.write(opus.encode(tone, 960));
await new Promise((resolve) => setTimeout(resolve, 200));
await second.unsubscribe('u', true);
await second.stop();
assert.equal(jobs.length, beforeRevoke, 'revoked active PCM must not be queued');
store.close();
console.log('Opus decode, resample, consent, and revoke smoke test passed');
