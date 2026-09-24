import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const resultDir = join(root, 'results');
const expectedPhrase = { 'release-planning': '10月12', 'product-roadmap': '次々期' };
const models = ['qwen3.5-9b', 'gemma4-e4b-it-qat'];
const results = [];
for (const model of models) {
  const path = join(resultDir, `long-meeting-live-${model}.json`);
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  for (const entry of entries) {
    const fixture = JSON.parse(readFileSync(join(root, 'fixtures', `${entry.id}.json`), 'utf8'));
    const anchorSpeaker = fixture.utterances.find((item) => item.publicId === entry.anchorId)?.speakerUserId;
    const linked = entry.linked;
    const linkedCount = linked ? Object.values(linked).reduce((sum, items) => sum + items.length, 0) : 0;
    let anchorPassed = false;
    if (linked) {
      if (entry.anchorKind === 'revision') anchorPassed = linked.decisions.some((item) => item.text.includes(expectedPhrase[entry.id]));
      if (entry.anchorKind === 'proposal') anchorPassed = (linked.topics.length + linked.openQuestions.length > 0) && linked.decisions.length === 0 && linked.actionItems.length === 0;
      if (entry.anchorKind === 'action') anchorPassed = linked.actionItems.some((item) => item.assigneeUserId === anchorSpeaker);
      if (entry.anchorKind === 'openQuestion') anchorPassed = linked.openQuestions.length > 0;
    }
    const score = {
      fixtureId: entry.id, model: entry.model, seconds: entry.seconds, attempts: entry.attempts,
      promptTokens: entry.promptTokens, generatedTokens: entry.generatedTokens,
      schemaValid: entry.validated, anchorLinked: linkedCount > 0, anchorPassed,
      overviewInformative: Boolean(entry.summary?.overview.trim() && entry.summary.overview.trim() !== '会議の概要'),
    };
    results.push(score);
  }
}
writeFileSync(join(resultDir, 'scorecard.json'), `${JSON.stringify(results, null, 2)}\n`);
for (const score of results) console.log(JSON.stringify(score));
