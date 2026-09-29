import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType, type Client, type Guild, type VoiceState } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { MeetingService } from '../src/meeting.js';
import type { MeetingOutputChannel } from '../src/publish.js';

const env = { DISCORD_TOKEN: 'test', DISCORD_APPLICATION_ID: 'app', DISCORD_GUILD_IDS: 'g1,g2' };

function guildFixture(id: string) {
  const member = { id: 'user', displayName: 'Person', user: { bot: false } };
  const voice = { id: `voice-${id}`, type: ChannelType.GuildVoice, permissionsFor: () => ({ has: () => true }) };
  const state = { id: member.id, channelId: voice.id, member };
  const guild = {
    id, client: { user: { id: 'bot' } },
    channels: { cache: new Map([[voice.id, voice]]) },
    members: { me: { id: 'bot' } },
    voiceStates: { cache: new Map([[member.id, state]]) },
  } as unknown as Guild;
  const output = { id: `text-${id}`, guildId: id, permissionsFor: () => ({ has: () => true }) } as unknown as MeetingOutputChannel;
  return { guild, voice, output };
}

test('configured Guild list supports existing single-Guild settings and removes duplicate IDs', () => {
  assert.deepEqual(loadConfig(env).guildIds, ['g1', 'g2']);
  assert.deepEqual(loadConfig({ DISCORD_TOKEN: 'test', DISCORD_APPLICATION_ID: 'app', DISCORD_GUILD_ID: 'legacy' }).guildIds, ['legacy']);
  assert.deepEqual(loadConfig({ ...env, DISCORD_GUILD_IDS: ' g1, g2, g1, ' }).guildIds, ['g1', 'g2']);
  assert.throws(() => loadConfig({ ...env, DISCORD_GUILD_IDS: ',' }), /Missing DISCORD_GUILD_IDS/);
});

test('a start waiting for STT reserves the single recording slot across Guilds', async () => {
  const store = new Store(':memory:');
  const service = new MeetingService(loadConfig(env), store, {} as Client);
  const first = guildFixture('g1');
  const second = guildFixture('g2');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  (service as unknown as { ensureSttReady(): Promise<void> }).ensureSttReady = async () => { await gate; throw new Error('STT_TEST_FAILURE'); };
  const pending = service.start(first.guild, first.voice.id, 'user', null, first.output);
  try {
    await assert.rejects(service.start(second.guild, second.voice.id, 'user', null, second.output), /別の会議が録音または処理中/);
    release();
    await assert.rejects(pending, /STT_TEST_FAILURE/);
    await assert.rejects(service.start(second.guild, second.voice.id, 'user', null, second.output), /STT_TEST_FAILURE/);
    assert.equal(store.latestMeeting('g1'), undefined);
    assert.equal(store.latestMeeting('g2'), undefined);
  } finally {
    release();
    await service.shutdown();
    store.close();
  }
});

test('meeting IDs cannot be used to publish, finalize, or delete another Guild meeting', async () => {
  const store = new Store(':memory:');
  let channelRequests = 0;
  const client = { channels: { fetch: async () => { channelRequests++; throw new Error('Must not fetch a foreign channel'); } } } as unknown as Client;
  const service = new MeetingService(loadConfig(env), store, client);
  const meeting = store.createMeeting({ guild_id: 'g1', voice_channel_id: 'v1', output_channel_id: 'c1', started_by_user_id: 'user', title: null, config_snapshot_json: '{}' });
  store.setStatus(meeting.id, ['STARTING'], 'RECORDING');
  store.setStatus(meeting.id, ['RECORDING'], 'DRAINING');
  store.finalizeTranscription(meeting.id);
  try {
    await assert.rejects(service.transcript('g2', meeting.id), /会議が見つかりません/);
    assert.throws(() => service.finalize('g2', meeting.id), /会議が見つかりません/);
    await assert.rejects(service.delete('g2', meeting.id), /会議が見つかりません/);
    assert.equal(service.status('g2'), '会議記録はまだありません。');
    assert.equal(channelRequests, 0);
    assert.equal(store.getMeeting(meeting.id)?.status, 'TRANSCRIBED');
  } finally { await service.shutdown(); store.close(); }
});

test('a Guild cannot stop, consent to, or observe another Guild live recording', async () => {
  const store = new Store(':memory:');
  const service = new MeetingService(loadConfig(env), store, {} as Client);
  const meeting = store.createMeeting({ guild_id: 'g1', voice_channel_id: 'v1', output_channel_id: 'c1', started_by_user_id: 'user', title: null, config_snapshot_json: '{}' });
  const recording = store.setStatus(meeting.id, ['STARTING'], 'RECORDING');
  const second = store.createMeeting({ guild_id: 'g2', voice_channel_id: 'v2', output_channel_id: 'c2', started_by_user_id: 'user', title: null, config_snapshot_json: '{}' });
  store.setStatus(second.id, ['STARTING'], 'INTERRUPTED');
  let unloads = 0;
  service.stt.unload = async () => { unloads++; };
  const internal = service as unknown as { live: unknown };
  internal.live = { meeting: recording, queue: { pendingJobs: 50, oldestJobAgeMs: 120000 }, budget: { bytes: 1048576 } };
  try {
    const status = service.status('g2');
    assert.ok(status.includes(second.id));
    assert.ok(!status.includes(meeting.id));
    assert.match(status, /STT待ち: 0件/);
    assert.throws(() => service.stopForGuild('g2'), /進行中の会議はありません/);
    assert.throws(() => service.finalize('g2', second.id), /別の会議が録音または処理中/);
    await assert.rejects(service.consent('g2', meeting.id, 'user', 'ACCEPTED'), /Meeting is not recording/);
    await service.voiceState({ id: 'user', channelId: 'v1' } as VoiceState, { id: 'user', channelId: null, guild: { id: 'g2' } } as VoiceState);
    assert.equal(store.getMeeting(meeting.id)?.status, 'RECORDING');
    assert.equal(store.getMeeting(second.id)?.status, 'INTERRUPTED');
    assert.equal(unloads, 0);
  } finally { internal.live = null; await service.shutdown(); store.close(); }
});
