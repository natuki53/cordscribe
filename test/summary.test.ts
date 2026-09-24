import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Store } from '../src/db.js';
import { extractExplicitRecords, OllamaSummarizer, validateSummary } from '../src/summary.js';
import type { Participant, Utterance } from '../src/types.js';

test('summary rejects invented evidence and assignee', () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting({ guild_id: 'g1', voice_channel_id: 'v1', output_channel_id: 'c1', started_by_user_id: 'u1', title: null, config_snapshot_json: '{}' });
    store.join(meeting.id, 'u1', 'Alice');
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u1', chain_id: 'c', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
    store.setUtterance(utterance.id, 'TRANSCRIBED', { text: '金曜に公開することで合意します' });
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
    store.setUtterance(utterance.id, 'TRANSCRIBED', { text: '金曜に公開することで合意します' });
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
    assert.equal(result.summary.decisions[0]?.text, '金曜に公開することで合意します');
    assert.equal(store.getMeeting(meeting.id)?.status, 'COMPLETED');
  } finally { globalThis.fetch = originalFetch; store.close(); }
});

test('a very long transcript sends a bounded sample in one model call', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    let meeting = store.createMeeting({ guild_id: 'long', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u1', title: '長時間会議', config_snapshot_json: '{}' });
    meeting = store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
    store.join(meeting.id, 'u1', '話者');
    for (let i = 0; i < 270; i++) {
      const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u1', chain_id: `chain-${i}`, chain_index: 0, started_offset_ms: i * 1000, ended_offset_ms: i * 1000 + 900 });
      store.setUtterance(utterance.id, 'TRANSCRIBED', { text: `議題${i} ${'説明'.repeat(2100)}` });
    }
    store.setStatus(meeting.id, ['RECORDING'], 'DRAINING', { stoppedAt: Date.now() });
    store.finalizeTranscription(meeting.id);
    globalThis.fetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body)) as { messages: { content: string }[]; format: { properties: { topics: { items: { properties: { evidenceUtteranceIds: { items: { enum: string[] } } } } } } } };
      const ids = request.format.properties.topics.items.properties.evidenceUtteranceIds.items.enum;
      assert.ok(request.messages[1]?.content.length < 20_000);
      assert.ok(ids.length <= 50);
      return new Response(JSON.stringify({ message: { content: JSON.stringify({
        schemaVersion: '1', title: '長時間会議', overview: '議題について説明があった。',
        topics: [{ title: '議題', summary: '記録', evidenceUtteranceIds: [ids[0]] }],
        decisions: [], actionItems: [], openQuestions: [],
      }) } }), { status: 200 });
    };
    const result = await new OllamaSummarizer(store, 'http://127.0.0.1:11434', 'test-model', 'Asia/Tokyo').summarize(store.getMeeting(meeting.id)!);
    assert.equal(store.getMeeting(meeting.id)?.status, 'COMPLETED');
    assert.equal(calls, 1);
    assert.ok(result.summary.topics[0]?.evidenceUtteranceIds[0]?.startsWith('U'));
  } finally { globalThis.fetch = originalFetch; store.close(); }
});

test('five long-meeting fixtures retain explicit facts and later corrections', () => {
  for (const id of ['release-planning', 'incident-review', 'product-roadmap', 'operations-handoff', 'dense-workshop']) {
    const fixture = JSON.parse(readFileSync(new URL(`../bench/fixtures/${id}.json`, import.meta.url), 'utf8')) as {
      speakers: { userId: string; displayName: string }[];
      utterances: { publicId: string; speakerUserId: string; text: string }[];
      anchors: { kind: string; publicId: string }[];
    };
    const participants = fixture.speakers.map((speaker) => ({ user_id: speaker.userId, display_name_snapshot: speaker.displayName })) as Participant[];
    const utterances = fixture.utterances.map((item) => ({ public_id: item.publicId, speaker_user_id: item.speakerUserId, text: item.text, status: 'TRANSCRIBED' })) as Utterance[];
    const records = extractExplicitRecords(utterances, participants);
    const ids = (kind: keyof typeof records) => new Set(records[kind].flatMap((item) => item.evidenceUtteranceIds));
    for (const anchor of fixture.anchors) {
      if (anchor.kind === 'action') {
        const action = records.actionItems.find((item) => item.evidenceUtteranceIds.includes(anchor.publicId));
        assert.ok(action, `${id}: missing action ${anchor.publicId}`);
        assert.equal(action.assigneeUserId, fixture.utterances.find((item) => item.publicId === anchor.publicId)?.speakerUserId);
        assert.match(action.dueDate ?? '', /^2026-10-\d{2}$/);
      }
      if (anchor.kind === 'revision') assert.ok(ids('decisions').has(anchor.publicId), `${id}: missing revision`);
      if (anchor.kind === 'openQuestion' || anchor.kind === 'proposal') assert.ok(ids('openQuestions').has(anchor.publicId), `${id}: missing unresolved item`);
      if (anchor.kind === 'proposal') {
        assert.ok(!ids('decisions').has(anchor.publicId), `${id}: proposal became decision`);
        assert.ok(!ids('actionItems').has(anchor.publicId), `${id}: proposal became action`);
      }
    }
    if (id === 'release-planning' || id === 'dense-workshop') {
      assert.ok(!ids('decisions').has(fixture.anchors[0]!.publicId), `${id}: superseded decision remained current`);
    }
  }
});

test('tentative and negative statements do not become decisions or assigned work', () => {
  const participants = [{ user_id: 'u1', display_name_snapshot: '田中' }] as Participant[];
  const lines = [
    'この案には合意していません。',
    '公開日を決定しましたか？',
    '私が金曜までに対応する案です。',
    '料金は未決定です。ただし検索の改善は最優先にすることで合意しました。',
    '2026年10月5日を候補にし、資料を2026年10月12日までに私が作成します。',
    '議事録は私が来週金曜までにまとめます。',
  ];
  const utterances = lines.map((text, index) => ({ public_id: `U${String(index + 1).padStart(6, '0')}`, speaker_user_id: 'u1', text, status: 'TRANSCRIBED' })) as Utterance[];
  const records = extractExplicitRecords(utterances, participants);
  assert.deepEqual(records.decisions.map((item) => item.evidenceUtteranceIds[0]), ['U000004']);
  assert.deepEqual(records.actionItems.map((item) => item.evidenceUtteranceIds[0]), ['U000005', 'U000006']);
  assert.equal(records.actionItems[0]?.dueDate, '2026-10-12');
  assert.equal(records.actionItems[1]?.dueText, '来週金曜');
  assert.deepEqual(records.openQuestions.map((item) => item.evidenceUtteranceIds[0]), ['U000001', 'U000004']);
});

test('a generic model overview is replaced with cited source facts without a retry', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    let meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u1', title: '公開会議', config_snapshot_json: '{}' });
    meeting = store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
    store.join(meeting.id, 'u1', '田中');
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u1', chain_id: 'c', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
    store.setUtterance(utterance.id, 'TRANSCRIBED', { text: '公開を来週に変更します。' });
    store.setStatus(meeting.id, ['RECORDING'], 'DRAINING', { stoppedAt: Date.now() });
    store.finalizeTranscription(meeting.id);
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ message: { content: JSON.stringify({
        schemaVersion: '1', title: '公開会議', overview: '会議の概要', topics: [], decisions: [], actionItems: [], openQuestions: [],
      }) } }), { status: 200 });
    };
    const result = await new OllamaSummarizer(store, 'http://127.0.0.1:11434', 'test-model', 'Asia/Tokyo').summarize(store.getMeeting(meeting.id)!);
    assert.equal(calls, 1);
    assert.match(result.summary.overview, /公開を来週に変更します/);
    assert.deepEqual(result.summary.decisions[0]?.evidenceUtteranceIds, ['U000001']);
  } finally { globalThis.fetch = originalFetch; store.close(); }
});

test('an invalid model reply still publishes explicit source facts', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    let meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u1', title: '公開会議', config_snapshot_json: '{}' });
    meeting = store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
    store.join(meeting.id, 'u1', '田中');
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u1', chain_id: 'c', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
    store.setUtterance(utterance.id, 'TRANSCRIBED', { text: '公開を来週に変更します。' });
    store.setStatus(meeting.id, ['RECORDING'], 'DRAINING', { stoppedAt: Date.now() });
    store.finalizeTranscription(meeting.id);
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ message: { content: '{' } }), { status: 200 });
    };
    const result = await new OllamaSummarizer(store, 'http://127.0.0.1:11434', 'test-model', 'Asia/Tokyo').summarize(store.getMeeting(meeting.id)!);
    assert.equal(calls, 2);
    assert.equal(store.getMeeting(meeting.id)?.status, 'COMPLETED');
    assert.deepEqual(result.summary.decisions[0]?.evidenceUtteranceIds, ['U000001']);
    assert.match(result.summary.overview, /議題の自動整理に失敗/);
  } finally { globalThis.fetch = originalFetch; store.close(); }
});

test('topics from a returning subject remain in chronological hour windows', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    let meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u1', title: '話題の往復', config_snapshot_json: '{}' });
    meeting = store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
    store.join(meeting.id, 'u1', '田中');
    for (const [index, text] of ['検索の検討', '料金の検討', '検索に戻って検討'].entries()) {
      const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u1', chain_id: `c${index}`, chain_index: 0, started_offset_ms: index * 3_600_000, ended_offset_ms: index * 3_600_000 + 1000 });
      store.setUtterance(utterance.id, 'TRANSCRIBED', { text });
    }
    store.setStatus(meeting.id, ['RECORDING'], 'DRAINING', { stoppedAt: Date.now() });
    store.finalizeTranscription(meeting.id);
    globalThis.fetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      const id = request.format.properties.topics.items.properties.evidenceUtteranceIds.items.enum[0];
      const topic = calls === 2 ? '料金' : '検索';
      return new Response(JSON.stringify({ message: { content: JSON.stringify({
        schemaVersion: '1', title: '話題の往復', overview: `${topic}について議論した。`,
        topics: [{ title: topic, summary: `${topic}について確認した。`, evidenceUtteranceIds: [id] }],
        decisions: [], actionItems: [], openQuestions: [],
      }) } }), { status: 200 });
    };
    const result = await new OllamaSummarizer(store, 'http://127.0.0.1:11434', 'test-model', 'Asia/Tokyo').summarize(store.getMeeting(meeting.id)!);
    assert.equal(calls, 3);
    assert.deepEqual(result.summary.topics.map((topic) => topic.title), ['00:00–01:00 検索', '01:00–02:00 料金', '02:00–03:00 検索']);
    assert.deepEqual(result.summary.topics.map((topic) => topic.evidenceUtteranceIds[0]), ['U000001', 'U000002', 'U000003']);
  } finally { globalThis.fetch = originalFetch; store.close(); }
});

test('an unavailable model is not called again for later hours when explicit facts exist', async () => {
  const store = new Store(':memory:');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    let meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u1', title: '長い会議', config_snapshot_json: '{}' });
    meeting = store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
    store.join(meeting.id, 'u1', '田中');
    for (const [index, text] of ['公開を来週に変更します。', '検索について話します。'].entries()) {
      const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u1', chain_id: `c${index}`, chain_index: 0, started_offset_ms: index * 3_600_000, ended_offset_ms: index * 3_600_000 + 1000 });
      store.setUtterance(utterance.id, 'TRANSCRIBED', { text });
    }
    store.setStatus(meeting.id, ['RECORDING'], 'DRAINING', { stoppedAt: Date.now() });
    store.finalizeTranscription(meeting.id);
    globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
    const result = await new OllamaSummarizer(store, 'http://127.0.0.1:11434', 'test-model', 'Asia/Tokyo').summarize(store.getMeeting(meeting.id)!);
    assert.equal(calls, 1);
    assert.equal(result.summary.topics.length, 2);
    assert.ok(result.summary.topics.every((topic) => topic.title.includes('要確認')));
    assert.deepEqual(result.summary.decisions[0]?.evidenceUtteranceIds, ['U000001']);
  } finally { globalThis.fetch = originalFetch; store.close(); }
});
