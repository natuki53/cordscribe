import assert from 'node:assert/strict';
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
