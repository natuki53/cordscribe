import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.js';
import { AudioBudget, SttQueue, type SttClient, type TranscriptionResult } from '../src/stt.js';

function transcription(text: string, overrides: Partial<TranscriptionResult['asr']> = {}): TranscriptionResult {
  return {
    text, language: 'ja', languageProbability: 1, durationMs: 1000,
    asr: {
      avgLogprob: -0.2, noSpeechProbability: 0.01, compressionRatio: 1.1,
      rmsDbfs: -24, peak: 0.4, clippingRatio: 0, speechDurationMs: 900,
      confidence: 'high', suspectedHallucination: false,
      hallucinationReasons: [], hallucinationPhraseMatch: false, debugAudioId: null,
      ...overrides,
    },
  };
}

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
      return transcription('確認します');
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
      return transcription('再試行成功');
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

test('ASR quality is persisted without rewriting suspected hallucination text', async () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u', title: null, config_snapshot_json: '{}' });
    store.join(meeting.id, 'u', 'Speaker');
    const budget = new AudioBudget(() => {});
    const client = { transcribe: async () => transcription('ご視聴ありがとうございました', {
      avgLogprob: -1.1, noSpeechProbability: 0.8, rmsDbfs: -48,
      speechDurationMs: 300, confidence: 'low', suspectedHallucination: true,
      hallucinationReasons: ['known_hallucination_phrase', 'very_low_rms'], hallucinationPhraseMatch: true,
    }) } as SttClient;
    const queue = new SttQueue(store, client, budget);
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u', chain_id: 'a', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
    const audio = Buffer.alloc(32_000);
    budget.add(audio.length);
    queue.enqueue({ utteranceId: utterance.id, meetingId: meeting.id, publicId: utterance.public_id, audio, enqueuedAtMs: Date.now() });
    await queue.drain(meeting.id);
    const saved = store.getUtterance(utterance.id)!;
    assert.equal(saved.text, 'ご視聴ありがとうございました');
    assert.equal(saved.suspected_hallucination, 1);
    assert.equal(saved.asr_confidence, 'low');
    assert.equal(saved.asr_avg_logprob, -1.1);
    assert.deepEqual(JSON.parse(saved.hallucination_reasons_json ?? '[]'), ['known_hallucination_phrase', 'very_low_rms']);
  } finally { store.close(); }
});

test('three repeated closing phrases add repetition evidence without deleting text', async () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u', title: null, config_snapshot_json: '{}' });
    store.join(meeting.id, 'u', 'Speaker');
    const budget = new AudioBudget(() => {});
    const client = { transcribe: async () => transcription('ありがとうございました', { hallucinationPhraseMatch: true }) } as SttClient;
    const queue = new SttQueue(store, client, budget);
    const utterances = Array.from({ length: 3 }, (_, index) => store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u', chain_id: String(index), chain_index: 0, started_offset_ms: index * 1000, ended_offset_ms: index * 1000 + 500 }));
    const now = Date.now();
    for (const [index, utterance] of utterances.entries()) {
      const audio = Buffer.alloc(16_000);
      budget.add(audio.length);
      queue.enqueue({ utteranceId: utterance.id, meetingId: meeting.id, audio, enqueuedAtMs: now + index * 1000 });
    }
    await queue.drain(meeting.id);
    const saved = store.getUtterance(utterances[2]!.id)!;
    assert.equal(saved.text, 'ありがとうございました');
    assert.equal(saved.suspected_hallucination, 1);
    assert.match(saved.hallucination_reasons_json ?? '', /repeated_phrase/);
  } finally { store.close(); }
});
