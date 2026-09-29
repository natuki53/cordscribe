import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../src/db.js';

const input = { guild_id: 'g1', voice_channel_id: 'v1', output_channel_id: 'c1', started_by_user_id: 'u1', title: 'Test', config_snapshot_json: '{}' };

test('one active meeting, consent history, and crash recovery preserve loss markers', () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting(input);
    assert.throws(() => store.createMeeting(input));
    store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
    store.join(meeting.id, 'u1', 'Alice', 1000);
    store.setConsent(meeting.id, 'u1', 'ACCEPTED');
    store.leave(meeting.id, 'u1', 2000);
    assert.equal(store.join(meeting.id, 'u1', 'Changed', 3000).display_name_snapshot, 'Alice');
    assert.equal(store.getParticipant(meeting.id, 'u1')?.consent_status, 'ACCEPTED');
    const utterance = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'u1', chain_id: 'chain', chain_index: 0, started_offset_ms: 0, ended_offset_ms: 1000 });
    assert.equal(utterance.public_id, 'U000001');
    store.recover();
    assert.equal(store.getMeeting(meeting.id)?.status, 'INTERRUPTED');
    assert.equal(store.getUtterance(utterance.id)?.status, 'LOST');
    assert.equal(store.finalizeTranscription(meeting.id), 'PARTIAL');
    assert.equal(store.getMeeting(meeting.id)?.status, 'TRANSCRIBED');
    assert.ok(store.createMeeting(input));
  } finally { store.close(); }
});

test('retention deletes local data after 30 days', () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting(input);
    store.setStatus(meeting.id, ['STARTING'], 'FAILED');
    assert.equal(store.expired(meeting.purge_at_ms - 1).length, 0);
    assert.equal(store.expired(meeting.purge_at_ms).length, 1);
    store.deleteMeeting(meeting.id);
    assert.equal(store.getMeeting(meeting.id), undefined);
  } finally { store.close(); }
});

test('opening an existing database adds ASR quality columns without dropping rows', () => {
  const path = join(tmpdir(), `cordscribe-migration-${randomUUID()}.sqlite`);
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE utterances (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker_user_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, public_id TEXT NOT NULL, chain_id TEXT NOT NULL, chain_index INTEGER NOT NULL,
    started_offset_ms INTEGER NOT NULL, ended_offset_ms INTEGER NOT NULL, status TEXT NOT NULL,
    text TEXT, language TEXT, language_probability REAL, stt_attempts INTEGER NOT NULL DEFAULT 0,
    stt_latency_ms INTEGER, error_code TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    UNIQUE(meeting_id,sequence), UNIQUE(meeting_id,public_id)
  );
  INSERT INTO utterances VALUES (
    'legacy-u','legacy-m','legacy-s',1,'U000001','legacy-chain',0,0,1000,'TRANSCRIBED',
    '既存の発言','ja',0.9,1,250,NULL,1,1
  );`);
  legacy.close();

  const store = new Store(path);
  try {
    const columns = new Set((store.db.prepare('PRAGMA table_info(utterances)').all() as { name: string }[]).map((column) => column.name));
    assert.ok(columns.has('asr_avg_logprob'));
    assert.ok(columns.has('suspected_hallucination'));
    assert.equal(store.getUtterance('legacy-u')?.text, '既存の発言');
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${path}${suffix}`;
      if (existsSync(target)) unlinkSync(target);
    }
  }
});
