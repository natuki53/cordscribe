import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Segmenter } from '../src/audio.js';
import { Store } from '../src/db.js';
import { AudioBudget, type SttQueue } from '../src/stt.js';

function setup() {
  const store = new Store(':memory:');
  const meeting = store.createMeeting({ guild_id: 'g1', voice_channel_id: 'v1', output_channel_id: 'c1', started_by_user_id: 'u1', title: null, config_snapshot_json: '{}' });
  store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: 1000 });
  store.join(meeting.id, 'u1', 'Alice');
  const jobs: { audio: Buffer; utteranceId: string }[] = [];
  const queue = { enqueue: (job: { audio: Buffer; utteranceId: string }) => jobs.push(job) } as unknown as SttQueue;
  const budget = new AudioBudget(() => {});
  const segmenter = new Segmenter(meeting.id, 'u1', 1000, store, queue, budget);
  return { store, meeting, jobs, budget, segmenter };
}

test('short click is ignored and memory is released', () => {
  const { store, meeting, jobs, budget, segmenter } = setup();
  try {
    segmenter.push(Buffer.alloc(200 * 32), 1000);
    segmenter.tick(1901);
    assert.equal(jobs.length, 0);
    assert.equal(store.utterances(meeting.id).length, 0);
    assert.equal(budget.bytes, 0);
  } finally { store.close(); }
});

test('long audio splits at exactly 28 seconds with one chain', () => {
  const { store, meeting, jobs, segmenter } = setup();
  try {
    segmenter.push(Buffer.alloc(29_000 * 32), 1000);
    segmenter.finalize();
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0]?.audio.length, 28_000 * 32);
    assert.equal(jobs[1]?.audio.length, 1000 * 32);
    const utterances = store.utterances(meeting.id);
    assert.equal(utterances[0]?.chain_id, utterances[1]?.chain_id);
    assert.deepEqual(utterances.map((u) => u.chain_index), [0, 1]);
  } finally { store.close(); }
});

test('budget signals near limit and rejects overflow', async () => {
  let warnings = 0;
  const budget = new AudioBudget(() => { warnings++; }, 9 * 1024 * 1024);
  budget.add(1024 * 1024);
  await Promise.resolve();
  assert.equal(warnings, 1);
  assert.throws(() => budget.add(9 * 1024 * 1024), /AUDIO_MEMORY_HARD_LIMIT/);
});

test('revoke discards active PCM but retains already queued utterances', () => {
  const { store, meeting, jobs, budget, segmenter } = setup();
  try {
    segmenter.push(Buffer.alloc(500 * 32), 1000);
    segmenter.finalize();
    segmenter.push(Buffer.alloc(700 * 32), 2000);
    segmenter.drop();
    assert.equal(jobs.length, 1);
    assert.equal(store.utterances(meeting.id).length, 1);
    assert.equal(budget.bytes, 500 * 32);
  } finally { store.close(); }
});

test('900 ms of PCM silence splits utterances', () => {
  const { store, meeting, jobs, segmenter } = setup();
  try {
    segmenter.push(Buffer.alloc(500 * 32), 1000, true);
    segmenter.push(Buffer.alloc(400 * 32), 1500, false);
    segmenter.push(Buffer.alloc(400 * 32), 2000, false);
    segmenter.push(Buffer.alloc(500 * 32), 2500, true);
    segmenter.finalize();
    assert.equal(jobs.length, 2);
    assert.equal(store.utterances(meeting.id).length, 2);
  } finally { store.close(); }
});
