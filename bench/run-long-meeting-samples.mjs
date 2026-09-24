import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSummary } from '../dist/summary.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const model = process.argv[2];
if (!model) throw new Error('Usage: node bench/run-long-meeting-samples.mjs MODEL');
const fixtureFilter = process.argv[3] ?? null;
const samples = JSON.parse(readFileSync(join(root, '..', 'runtime', 'long-meeting-samples.json'), 'utf8'));
const output = [];
const expectedPhrase = { 'release-planning': '10月12', 'product-roadmap': '次々期' };

for (const sample of samples.filter((item) => !fixtureFilter || item.id === fixtureFilter)) {
  const fixture = JSON.parse(readFileSync(join(root, 'fixtures', `${sample.id}.json`), 'utf8'));
  const selectedIds = new Set(sample.request.format.properties.topics.items.properties.evidenceUtteranceIds.items.enum);
  const utterances = fixture.utterances.filter((item) => selectedIds.has(item.publicId))
    .map((item) => ({ public_id: item.publicId, status: 'TRANSCRIBED' }));
  const participants = fixture.speakers.map((speaker) => ({ user_id: speaker.userId, display_name_snapshot: speaker.displayName }));
  const anchorSpeaker = fixture.utterances.find((item) => item.publicId === sample.anchor.publicId)?.speakerUserId;
  const request = structuredClone(sample.request);
  request.model = model;
  let correction = '';
  let validated;
  let error = null;
  let attempts = 0;
  let promptTokens = null;
  let generatedTokens = null;
  const started = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    request.messages[1].content = `${sample.request.messages[1].content}\n${correction}`;
    try {
      const response = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request), signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok) throw new Error(`OLLAMA_${response.status}`);
      const body = await response.json();
      promptTokens = body.prompt_eval_count ?? null;
      generatedTokens = body.eval_count ?? null;
      validated = validateSummary(JSON.parse(body.message?.content ?? ''), utterances, participants);
      error = null;
      break;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      correction = `前回の出力は不正でした: ${error}。根拠がない項目は配列から除き、提示された発言IDだけを使って再出力してください。`;
    }
  }
  const cites = (item) => item.evidenceUtteranceIds.includes(sample.anchor.publicId);
  const linked = validated ? {
    topics: validated.topics.filter(cites),
    decisions: validated.decisions.filter(cites),
    actionItems: validated.actionItems.filter(cites),
    openQuestions: validated.openQuestions.filter(cites),
  } : null;
  let anchorPassed = false;
  if (linked) {
    if (sample.anchor.kind === 'revision') anchorPassed = linked.decisions.some((item) => item.text.includes(expectedPhrase[sample.id]));
    if (sample.anchor.kind === 'proposal') anchorPassed = (linked.topics.length + linked.openQuestions.length > 0) && linked.decisions.length === 0 && linked.actionItems.length === 0;
    if (sample.anchor.kind === 'action') anchorPassed = linked.actionItems.some((item) => item.assigneeUserId === anchorSpeaker);
    if (sample.anchor.kind === 'openQuestion') anchorPassed = linked.openQuestions.length > 0;
  }
  const result = {
    id: sample.id, model, anchorId: sample.anchor.publicId, anchorKind: sample.anchor.kind,
    seconds: Math.round((Date.now() - started) / 1000), attempts, promptTokens, generatedTokens,
    validated: Boolean(validated), anchorPassed, error, linked,
    summary: validated ?? null,
  };
  output.push(result);
  const suffix = fixtureFilter ? `-${fixtureFilter}` : '';
  writeFileSync(join(root, 'results', `long-meeting-live-${model.replaceAll(':', '-')}${suffix}.json`), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ id: result.id, model, anchorId: result.anchorId, anchorKind: result.anchorKind, seconds: result.seconds, attempts, promptTokens, generatedTokens, validated: result.validated, anchorPassed, error }));
}
