// Run inside the built Linux image with this file mounted at /app/ollama-smoke.mjs.
import assert from 'node:assert/strict';
import { Store } from './dist/db.js';
import { OllamaSummarizer } from './dist/summary.js';

const store = new Store(':memory:');
try {
  let meeting = store.createMeeting({ guild_id: 'test-guild', voice_channel_id: 'test-voice', output_channel_id: 'test-output', started_by_user_id: 'test-user', title: '検証会議', config_snapshot_json: '{}' });
  meeting = store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
  store.join(meeting.id, 'test-user', '検証話者');
  const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'test-user', chain_id: 'test-chain', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
  store.setUtterance(utterance.id, 'TRANSCRIBED', { text: '次回から毎週金曜日に会議を開くことに決まりました。担当は後で決めます。' });
  store.setStatus(meeting.id, ['RECORDING'], 'DRAINING', { stoppedAt: Date.now() });
  store.finalizeTranscription(meeting.id);
  const started = Date.now();
  const result = await new OllamaSummarizer(store, 'http://127.0.0.1:11434', process.env.OLLAMA_MODEL ?? 'qwen3.5:9b', 'Asia/Tokyo').summarize(store.getMeeting(meeting.id));
  assert.equal(store.getMeeting(meeting.id).status, 'COMPLETED');
  assert.ok(result.markdown.includes('U000001'));
  console.log(JSON.stringify({ model: process.env.OLLAMA_MODEL ?? 'qwen3.5:9b', seconds: Math.round((Date.now() - started) / 1000), evidenceId: 'U000001', summaryVersion: result.version }));
} finally { store.close(); }
