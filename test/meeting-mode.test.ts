import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType, type Client, type Guild, type VoiceChannel } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { MeetingService } from '../src/meeting.js';
import type { MeetingOutputChannel, Publisher } from '../src/publish.js';
import { renderTranscript } from '../src/summary.js';
import type { Meeting } from '../src/types.js';

const required = {
  DISCORD_TOKEN: 'test-token', DISCORD_APPLICATION_ID: 'app', DISCORD_GUILD_ID: 'guild',
};

test('default mode ignores Ollama settings and makes no Ollama request', async () => {
  const config = loadConfig({ ...required, OLLAMA_BASE_URL: 'https://unused.example' });
  assert.equal(config.summaryMode, 'off');
  assert.equal(config.ollamaBaseUrl, '');
  const store = new Store(':memory:');
  const service = new MeetingService(config, store, {} as Client);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected network request'); };
  try {
    service.stt.ready = async () => true;
    await (service as unknown as { ensureSttReady(): Promise<void> }).ensureSttReady();
    assert.equal(calls, 0);
    await assert.rejects(service.regenerate('missing'), /LLM要約は無効/);
  } finally {
    globalThis.fetch = originalFetch;
    await service.shutdown();
    store.close();
  }
});

test('transcript-only publication completes without invoking a summarizer', async () => {
  const store = new Store(':memory:');
  const service = new MeetingService(loadConfig(required), store, {} as Client);
  try {
    const meeting = store.createMeeting({ guild_id: 'guild', voice_channel_id: 'voice', output_channel_id: 'text', started_by_user_id: 'user', title: '記録', config_snapshot_json: '{}' });
    store.setStatus(meeting.id, ['STARTING'], 'RECORDING');
    store.setStatus(meeting.id, ['RECORDING'], 'DRAINING');
    store.finalizeTranscription(meeting.id);
    let posted = '';
    const publisher = {
      transcript: async (_meeting: Meeting, text: string) => { posted = text; },
      summary: async () => { throw new Error('Summary must stay disabled'); },
    } as unknown as Publisher;
    await (service as unknown as { publishResults(meeting: Meeting, publisher: Publisher): Promise<void> })
      .publishResults(store.getMeeting(meeting.id)!, publisher);
    assert.match(posted, /会議記録データ/);
    assert.equal(store.getMeeting(meeting.id)?.status, 'COMPLETED');
    assert.deepEqual(store.completedSummaries(meeting.id), []);
  } finally {
    await service.shutdown();
    store.close();
  }
});

test('Markdown transcript keeps evidence IDs, three-hour offsets, and gaps', () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting({ guild_id: 'guild', voice_channel_id: 'voice', output_channel_id: 'text', started_by_user_id: 'user', title: '長時間会議', config_snapshot_json: '{}' });
    store.join(meeting.id, 'user', '話者A');
    const first = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'user', chain_id: 'a', chain_index: 0, started_offset_ms: 3 * 3_600_000 + 5_023, ended_offset_ms: 3 * 3_600_000 + 8_000 });
    store.setUtterance(first.id, 'TRANSCRIBED', { text: '再訪した話題' });
    const second = store.createUtterance({ meeting_id: meeting.id, speaker_user_id: 'user', chain_id: 'b', chain_index: 0, started_offset_ms: 3 * 3_600_000 + 9_000, ended_offset_ms: 3 * 3_600_000 + 12_000 });
    store.setUtterance(second.id, 'LOST');
    store.setStatus(meeting.id, ['STARTING'], 'RECORDING');
    store.setStatus(meeting.id, ['RECORDING'], 'DRAINING');
    store.finalizeTranscription(meeting.id);
    const text = renderTranscript(store.getMeeting(meeting.id)!, store.participants(meeting.id), store.utterances(meeting.id));
    assert.match(text, /一部欠損 \(1件\)/);
    assert.match(text, /\[U000001\] 03:00:05\.023 P01 話者A: 再訪した話題/);
    assert.match(text, /\[U000002\] 03:00:09\.000 P01 話者A: （文字起こし欠損: LOST）/);
    assert.doesNotMatch(text, /Discord ID:/);
  } finally { store.close(); }
});

test('Ollama mode requires an explicit switch and loopback endpoint', () => {
  assert.throws(() => loadConfig({ ...required, SUMMARY_MODE: 'ollama', OLLAMA_BASE_URL: 'https://example.com' }), /local HTTP/);
  assert.equal(loadConfig({ ...required, SUMMARY_MODE: 'ollama' }).summaryMode, 'ollama');
});

test('a VC chat can retain the consent notice and transcript as the meeting output', async () => {
  const store = new Store(':memory:');
  const sent: { files: { name: string }[]; embeds: unknown[] }[] = [];
  const channel = {
    id: 'voice', guildId: 'guild', type: ChannelType.GuildVoice,
    client: { user: { id: 'bot' } },
    messages: { fetch: async () => ({ find: () => undefined }) },
    send: async (payload: typeof sent[number]) => { sent.push(payload); return { id: `message-${sent.length}` }; },
  } as unknown as VoiceChannel;
  const client = { channels: { fetch: async (id: string) => id === 'voice' ? channel : null } } as unknown as Client;
  const service = new MeetingService(loadConfig(required), store, client);
  try {
    const meeting = store.createMeeting({ guild_id: 'guild', voice_channel_id: 'voice', output_channel_id: 'voice', started_by_user_id: 'user', title: 'VCチャット試験', config_snapshot_json: '{}' });
    const publisher = await service.publisherFor(meeting);
    await publisher.notice(meeting);
    await publisher.transcript(meeting, '# 会議記録データ');
    assert.equal(sent.length, 2);
    assert.equal(sent[0]?.embeds.length, 1);
    assert.match(sent[1]?.files[0]?.name ?? '', /\.md$/);
  } finally {
    await service.shutdown();
    store.close();
  }
});

test('music and read-aloud bots do not need consent notice access to start', async () => {
  const store = new Store(':memory:');
  const service = new MeetingService(loadConfig(required), store, {} as Client);
  const human = { id: 'user', displayName: 'Person', user: { bot: false } };
  const bot = { id: 'music', displayName: 'Music', user: { bot: true } };
  const voice = { id: 'voice', type: ChannelType.GuildVoice, permissionsFor: () => ({ has: () => true }) };
  const output = {
    id: 'text', guildId: 'guild', permissionsFor: (member: { user?: { bot: boolean } }) => ({ has: () => member.user?.bot !== true }),
  } as unknown as MeetingOutputChannel;
  const humanState = { id: human.id, channelId: 'voice', member: human };
  const botState = { id: bot.id, channelId: 'voice', member: null };
  const guild = {
    id: 'guild', client: { user: { id: 'cordscribe' } },
    channels: { cache: new Map([['voice', voice]]) },
    members: { me: { id: 'cordscribe' }, fetch: async (id: string) => id === bot.id ? bot : human },
    voiceStates: { cache: { get: (id: string) => id === human.id ? humanState : botState, values: () => [humanState, botState] } },
  } as unknown as Guild;
  try {
    (service as unknown as { ensureSttReady(): Promise<void> }).ensureSttReady = async () => { throw new Error('READY_MARKER'); };
    await assert.rejects(service.start(guild, 'voice', human.id, null, output), /READY_MARKER/);
  } finally {
    await service.shutdown();
    store.close();
  }
});
