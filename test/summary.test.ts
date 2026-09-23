import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.js';
import { OllamaSummarizer, validateSummary } from '../src/summary.js';

test('summary rejects invented evidence and assignee', () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting({ guild_id: 'g1', voice_channel_id: 'v1', output_channel_id: 'c1', started_by_user_id: 'u1', title: null, config_snapshot_json: '{}' });
    store.join(meeting.id, 'u1', 'Alice');
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u1', chain_id: 'c', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
    store.setUtterance(utterance.id, 'TRANSCRIBED', { text: '金曜に公開します' });
    const sample = { schemaVersion: '1', title: '会議', overview: '公開を決定', topics: [], decisions: [{ text: '金曜に公開', evidenceUtteranceIds: ['U000001'] }], actionItems: [], openQuestions: [] };
    const participants = store.participants(meeting.id);
    const utterances = store.utterances(meeting.id);
    assert.equal(validateSummary(sample, utterances, participants).decisions.length, 1);
    assert.throws(() => validateSummary({ ...sample, decisions: [{ text: '金曜', evidenceUtteranceIds: ['U999999'] }] }, utterances, participants), /evidence/);
    assert.throws(() => validateSummary({ ...sample, actionItems: [{ task: '公開', assigneeUserId: 'someone-else', assigneeDisplayName: 'Bob', dueDate: null, dueText: null, evidenceUtteranceIds: ['U000001'] }] }, utterances, participants), /assignee/);
    assert.throws(() => validateSummary({ ...sample, extra: true }, utterances, participants), /fields/);
    assert.throws(() => validateSummary({ ...sample, actionItems: [{ task: '公開', assigneeUserId: null, assigneeDisplayName: null, dueDate: '2026-02-30', dueText: '2月末', evidenceUtteranceIds: ['U000001'] }] }, utterances, participants), /due date/);
  } finally { store.close(); }
});

test('invalid Ollama evidence is retried once and leaves the transcript intact', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    let meeting = store.createMeeting({ guild_id: 'g1', voice_channel_id: 'v1', output_channel_id: 'c1', started_by_user_id: 'u1', title: null, config_snapshot_json: '{}' });
    meeting = store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
    store.join(meeting.id, 'u1', 'Alice');
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u1', chain_id: 'c', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
    store.setUtterance(utterance.id, 'TRANSCRIBED', { text: '会議を始めます' });
    store.setStatus(meeting.id, ['RECORDING'], 'DRAINING', { stoppedAt: Date.now() });
    store.finalizeTranscription(meeting.id);
    const invalid = { schemaVersion: '1', title: '会議', overview: '概要', topics: [], decisions: [{ text: '決定', evidenceUtteranceIds: ['U999999'] }], actionItems: [], openQuestions: [] };
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ message: { content: JSON.stringify(invalid) } }), { status: 200 }); };
    const summarizer = new OllamaSummarizer(store, 'http://127.0.0.1:11434', 'test-model', 'Asia/Tokyo');
    await assert.rejects(summarizer.summarize(store.getMeeting(meeting.id)!), /SUMMARY_VALIDATION_FAILED/);
    assert.equal(calls, 2);
    assert.equal(store.getMeeting(meeting.id)?.status, 'TRANSCRIBED');
    assert.equal(store.getUtterance(utterance.id)?.text, '会議を始めます');
  } finally { globalThis.fetch = originalFetch; store.close(); }
});

test('Ollama receives nonempty known evidence IDs and a corrected reply completes the summary', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    let meeting = store.createMeeting({ guild_id: 'g1', voice_channel_id: 'v1', output_channel_id: 'c1', started_by_user_id: 'u1', title: null, config_snapshot_json: '{}' });
    meeting = store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
    store.join(meeting.id, 'u1', 'Alice');
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u1', chain_id: 'c', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
    store.setUtterance(utterance.id, 'TRANSCRIBED', { text: '金曜に公開します' });
    store.setStatus(meeting.id, ['RECORDING'], 'DRAINING', { stoppedAt: Date.now() });
    store.finalizeTranscription(meeting.id);
    globalThis.fetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      for (const key of ['topics', 'decisions', 'actionItems', 'openQuestions']) {
        const evidence = request.format.properties[key].items.properties.evidenceUtteranceIds;
        assert.equal(evidence.minItems, 1);
        assert.deepEqual(evidence.items.enum, ['U000001']);
      }
      const response = { schemaVersion: '1', title: '会議', overview: '公開予定', topics: [], decisions: [{ text: '金曜に公開', evidenceUtteranceIds: calls === 1 ? [] : ['U000001'] }], actionItems: [], openQuestions: [] };
      return new Response(JSON.stringify({ message: { content: JSON.stringify(response) } }), { status: 200 });
    };
    const summarizer = new OllamaSummarizer(store, 'http://127.0.0.1:11434', 'test-model', 'Asia/Tokyo');
    const result = await summarizer.summarize(store.getMeeting(meeting.id)!);
    assert.equal(calls, 2);
    assert.deepEqual(result.summary.decisions[0]?.evidenceUtteranceIds, ['U000001']);
    assert.equal(store.getMeeting(meeting.id)?.status, 'COMPLETED');
  } finally { globalThis.fetch = originalFetch; store.close(); }
});
