import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const ids = ['release-planning', 'incident-review', 'product-roadmap', 'operations-handoff', 'dense-workshop'];
const models = ['gemma4:e4b-it-qat', 'qwen3.5:9b'];
const rows = [];
for (const model of models) {
  for (const id of ids) {
    const fixture = JSON.parse(readFileSync(join(root, 'fixtures', `${id}.json`), 'utf8'));
    const result = JSON.parse(readFileSync(join(root, 'results', `full-${id}-${model.replaceAll(':', '-')}.json`), 'utf8'));
    const summary = result.summary;
    const revisitedLabels = [...new Set(fixture.utterances.map((item) => item.topic))].filter((topic) => {
      const hours = new Set(summary?.topics.filter((item) => `${item.title} ${item.summary}`.includes(topic)).map((item) => item.title.slice(0, 2)) ?? []);
      return hours.size >= 2;
    });
    const evidence = (field) => new Set((summary?.[field] ?? []).flatMap((item) => item.evidenceUtteranceIds));
    const decisions = evidence('decisions');
    const actions = evidence('actionItems');
    const questions = evidence('openQuestions');
    const anchorChecks = fixture.anchors.map((anchor) => {
      const speaker = fixture.utterances.find((item) => item.publicId === anchor.publicId)?.speakerUserId;
      const action = summary?.actionItems.find((item) => item.evidenceUtteranceIds.includes(anchor.publicId));
      const superseded = anchor.kind === 'decision' && ['release-planning', 'dense-workshop'].includes(id);
      const passed = anchor.kind === 'decision' ? (superseded ? !decisions.has(anchor.publicId) : decisions.has(anchor.publicId))
        : anchor.kind === 'revision' ? decisions.has(anchor.publicId)
        : anchor.kind === 'action' ? action?.assigneeUserId === speaker && /^2026-10-\d{2}$/.test(action.dueDate ?? '')
        : anchor.kind === 'proposal' ? questions.has(anchor.publicId) && !decisions.has(anchor.publicId) && !actions.has(anchor.publicId)
        : questions.has(anchor.publicId);
      return { kind: anchor.kind, id: anchor.publicId, passed: Boolean(passed) };
    });
    rows.push({ fixtureId: id, model, durationMinutes: fixture.durationMinutes, utterances: fixture.utterances.length,
      seconds: result.seconds, calls: result.calls.length, completed: result.status === 'COMPLETED',
      decisions: summary?.decisions.length ?? 0, actions: summary?.actionItems.length ?? 0,
      questions: summary?.openQuestions.length ?? 0, topics: summary?.topics.length ?? 0,
      windows: new Set(summary?.topics.map((item) => item.title.slice(0, 2)) ?? []).size,
      revisitedLabels,
      anchorsPassed: anchorChecks.filter((item) => item.passed).length, anchorsTotal: anchorChecks.length,
      anchorChecks, error: result.error });
  }
}
writeFileSync(join(root, 'results', 'full-scorecard-v2.json'), `${JSON.stringify(rows, null, 2)}\n`);
for (const row of rows) console.log(JSON.stringify({ fixtureId: row.fixtureId, model: row.model,
  seconds: row.seconds, calls: row.calls, completed: row.completed,
  anchors: `${row.anchorsPassed}/${row.anchorsTotal}`, topics: row.topics, windows: row.windows,
  revisitedLabels: row.revisitedLabels.length }));
