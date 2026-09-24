import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../dist/db.js';
import { OllamaSummarizer, renderTranscript } from '../dist/summary.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const fixturesDir = join(root, 'fixtures');
const resultsDir = join(root, 'results');
const runtimeDir = join(root, '..', 'runtime');
mkdirSync(resultsDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

const sampleKind = {
  'release-planning': 'revision',
  'incident-review': 'proposal',
  'product-roadmap': 'revision',
  'operations-handoff': 'action',
  'dense-workshop': 'openQuestion',
};

function createStore(fixture) {
  const store = new Store(':memory:');
  let meeting = store.createMeeting({ guild_id: fixture.id, voice_channel_id: 'benchmark-voice', output_channel_id: 'benchmark-text', started_by_user_id: fixture.speakers[0].userId, title: fixture.title, config_snapshot_json: '{}' });
  meeting = store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.UTC(2026, 8, 24) });
  for (const speaker of fixture.speakers) store.join(meeting.id, speaker.userId, speaker.displayName);
  for (const item of fixture.utterances) {
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: item.speakerUserId, chain_id: item.publicId, chain_index: 0, started_offset_ms: item.startMs, ended_offset_ms: item.endMs });
    if (utterance.public_id !== item.publicId) throw new Error(`Unexpected ID in ${fixture.id}: ${utterance.public_id}`);
    store.setUtterance(utterance.id, 'TRANSCRIBED', { text: item.text });
  }
  store.setStatus(meeting.id, ['RECORDING'], 'DRAINING', { stoppedAt: Date.UTC(2026, 8, 24) + fixture.durationMinutes * 60_000 });
  store.finalizeTranscription(meeting.id);
  return { store, meeting: store.getMeeting(meeting.id) };
}

async function simulate(fixture, overviewLength, sampleAnchor) {
  const { store, meeting } = createStore(fixture);
  const originalFetch = globalThis.fetch;
  let firstPassCalls = 0;
  let totalCalls = 0;
  let maxPromptCharacters = 0;
  let maxEvidenceChoices = 0;
  let sampleRequest;
  let maxRequest;
  try {
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init.body));
      totalCalls++;
      const prompt = request.messages[1].content;
      const ids = request.format.properties.topics.items.properties.evidenceUtteranceIds.items.enum;
      if (prompt.length > maxPromptCharacters) {
        maxPromptCharacters = prompt.length;
        maxRequest = request;
      }
      maxEvidenceChoices = Math.max(maxEvidenceChoices, ids.length);
      if (prompt.includes('次の発言から事実')) {
        firstPassCalls++;
        if (ids.includes(sampleAnchor.publicId)) sampleRequest = request;
      }
      const summary = {
        schemaVersion: '1', title: fixture.title, overview: '確認'.repeat(overviewLength),
        topics: [{ title: '議題', summary: '確認済み', evidenceUtteranceIds: [ids[0]] }],
        decisions: [], actionItems: [], openQuestions: [],
      };
      return new Response(JSON.stringify({ message: { content: JSON.stringify(summary) } }), { status: 200 });
    };
    const summarizer = new OllamaSummarizer(store, 'http://127.0.0.1:11434', 'mock', 'Asia/Tokyo');
    await summarizer.summarize(meeting);
    return { firstPassCalls, totalCalls, maxPromptCharacters, maxEvidenceChoices, sampleRequest, maxRequest };
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
}

const report = [];
const samples = [];
let longestRequest;
for (const filename of readdirSync(fixturesDir).filter((name) => name.endsWith('.json')).sort()) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, filename), 'utf8'));
  const sampleAnchor = fixture.anchors.find((anchor) => anchor.kind === sampleKind[fixture.id]);
  if (!sampleAnchor) throw new Error(`Missing sample anchor: ${fixture.id}`);
  const topics = fixture.utterances.map((item) => item.topic);
  const switches = topics.filter((topic, index) => index > 0 && topic !== topics[index - 1]).length;
  const seen = new Set();
  let prior = null;
  let revisits = 0;
  for (const topic of topics) {
    if (topic !== prior) {
      if (seen.has(topic)) revisits++;
      seen.add(topic);
      prior = topic;
    }
  }
  const { store, meeting } = createStore(fixture);
  const transcriptBytes = Buffer.byteLength(renderTranscript(meeting, store.participants(meeting.id), store.utterances(meeting.id)), 'utf8');
  store.close();
  const lean = await simulate(fixture, 120, sampleAnchor);
  const verbose = await simulate(fixture, 1000, sampleAnchor);
  if (!longestRequest || verbose.maxPromptCharacters > longestRequest.messages[1].content.length) longestRequest = verbose.maxRequest;
  if (lean.firstPassCalls !== verbose.firstPassCalls || !lean.sampleRequest) throw new Error(`Sample capture failed: ${fixture.id}`);
  samples.push({ id: fixture.id, anchor: sampleAnchor, request: lean.sampleRequest });
  const entry = {
    id: fixture.id, title: fixture.title, durationMinutes: fixture.durationMinutes,
    speakers: fixture.speakers.length, utterances: fixture.utterances.length,
    transcriptBytes, topicSwitches: switches, topicRevisits: revisits,
    anchors: fixture.anchors.map(({ kind, publicId }) => ({ kind, publicId })),
    firstPassCalls: lean.firstPassCalls,
    leanTotalCalls: lean.totalCalls, verboseTotalCalls: verbose.totalCalls,
    maxPromptCharacters: Math.max(lean.maxPromptCharacters, verbose.maxPromptCharacters),
    maxEvidenceChoices: Math.max(lean.maxEvidenceChoices, verbose.maxEvidenceChoices),
    sampleAnchor: sampleAnchor.publicId,
  };
  report.push(entry);
  console.log(JSON.stringify(entry));
}
writeFileSync(join(resultsDir, 'structural.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(runtimeDir, 'long-meeting-samples.json'), `${JSON.stringify(samples, null, 2)}\n`);
writeFileSync(join(runtimeDir, 'long-meeting-max-request.json'), `${JSON.stringify(longestRequest, null, 2)}\n`);
