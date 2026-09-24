import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../dist/db.js';
import { OllamaSummarizer } from '../dist/summary.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const fixtureId = process.argv[2];
const model = process.argv[3];
if (!fixtureId || !model) throw new Error('Usage: node bench/run-full-long-meeting.mjs FIXTURE MODEL');
const fixture = JSON.parse(readFileSync(join(root, 'fixtures', `${fixtureId}.json`), 'utf8'));
const store = new Store(':memory:');
const originalFetch = globalThis.fetch;
const calls = [];
let meeting;
try {
  meeting = store.createMeeting({ guild_id: fixture.id, voice_channel_id: 'benchmark-voice', output_channel_id: 'benchmark-text', started_by_user_id: fixture.speakers[0].userId, title: fixture.title, config_snapshot_json: '{}' });
  meeting = store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.UTC(2026, 8, 24) });
  for (const speaker of fixture.speakers) store.join(meeting.id, speaker.userId, speaker.displayName);
  for (const item of fixture.utterances) {
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: item.speakerUserId, chain_id: item.publicId, chain_index: 0, started_offset_ms: item.startMs, ended_offset_ms: item.endMs });
    store.setUtterance(utterance.id, 'TRANSCRIBED', { text: item.text });
  }
  store.setStatus(meeting.id, ['RECORDING'], 'DRAINING', { stoppedAt: Date.UTC(2026, 8, 24) + fixture.durationMinutes * 60_000 });
  store.finalizeTranscription(meeting.id);
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(String(init.body));
    const started = Date.now();
    const response = await originalFetch(url, init);
    const body = await response.clone().json().catch(() => ({}));
    const entry = {
      index: calls.length + 1,
      stage: request.messages[1].content.includes('次の発言から事実') ? 'extract' : 'merge',
      seconds: Math.round((Date.now() - started) / 1000), status: response.status,
      promptTokens: body.prompt_eval_count ?? null, generatedTokens: body.eval_count ?? null,
      allowedEvidenceIds: request.format.properties.topics.items.properties.evidenceUtteranceIds.items.enum.length,
    };
    calls.push(entry);
    console.log(JSON.stringify(entry));
    return response;
  };
  const started = Date.now();
  let summary = null;
  let error = null;
  try {
    summary = (await new OllamaSummarizer(store, 'http://127.0.0.1:11434', model, 'Asia/Tokyo').summarize(meeting)).summary;
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const result = { fixtureId, model, seconds: Math.round((Date.now() - started) / 1000),
    status: store.getMeeting(meeting.id).status, calls, summary, error };
  writeFileSync(join(root, 'results', `full-${fixtureId}-${model.replaceAll(':', '-')}.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ completed: true, fixtureId, model, seconds: result.seconds, calls: calls.length, status: result.status, error,
    decisions: summary?.decisions.length ?? null, actions: summary?.actionItems.length ?? null, questions: summary?.openQuestions.length ?? null }));
} finally {
  globalThis.fetch = originalFetch;
  store.close();
}
