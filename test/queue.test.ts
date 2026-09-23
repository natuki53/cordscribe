import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.js';
import { AudioBudget, SttQueue, type SttClient } from '../src/stt.js';

test('STT jobs run serially and a failed job does not strand the queue', async () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u', title: null, config_snapshot_json: '{}' });
    store.join(meeting.id, 'u', 'Speaker');
    const first = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u', chain_id: 'a', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
    const second = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u', chain_id: 'b', chain_index: 0, started_offset_ms: 1000, ended_offset_ms: 2000 });
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const client = { transcribe: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      if (++calls === 1) throw new Error('STT_400');
      return { text: '確認します', language: 'ja', languageProbability: 1, durationMs: 1000 };
    } } as SttClient;
    const budget = new AudioBudget(() => {});
    const queue = new SttQueue(store, client, budget);
    const pcm = Buffer.alloc(32_000);
    budget.add(pcm.length * 2);
    queue.enqueue({ utteranceId: first.id, meetingId: meeting.id, audio: pcm, enqueuedAtMs: Date.now() });
    queue.enqueue({ utteranceId: second.id, meetingId: meeting.id, audio: pcm, enqueuedAtMs: Date.now() });
    await queue.drain(meeting.id);
    assert.equal(maxActive, 1);
    assert.equal(calls, 2);
    assert.equal(store.getUtterance(first.id)?.status, 'FAILED');
    assert.equal(store.getUtterance(second.id)?.status, 'TRANSCRIBED');
    assert.equal(budget.bytes, 0);
  } finally { store.close(); }
});

test('a transient STT connection error retries and saves the utterance', async () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u', title: null, config_snapshot_json: '{}' });
    store.join(meeting.id, 'u', 'Speaker');
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u', chain_id: 'a', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
    let calls = 0;
    const client = { transcribe: async () => {
      if (++calls === 1) throw new TypeError('connection reset');
      return { text: '再試行成功', language: 'ja', languageProbability: 1, durationMs: 1000 };
    } } as SttClient;
    const budget = new AudioBudget(() => {});
    const audio = Buffer.alloc(32_000);
    budget.add(audio.length);
    const queue = new SttQueue(store, client, budget);
    queue.enqueue({ utteranceId: utterance.id, meetingId: meeting.id, audio, enqueuedAtMs: Date.now() });
    await queue.drain(meeting.id);
    assert.equal(calls, 2);
    assert.equal(store.getUtterance(utterance.id)?.status, 'TRANSCRIBED');
    assert.equal(store.getUtterance(utterance.id)?.stt_attempts, 2);
    assert.equal(budget.bytes, 0);
  } finally { store.close(); }
});
