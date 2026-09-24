import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TextChannel } from 'discord.js';
import { Store } from '../src/db.js';
import { Publisher } from '../src/publish.js';

test('a pending Discord delivery is reconciled by marker without duplicate send', async () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u', title: null, config_snapshot_json: '{}' });
    const pending = store.delivery(meeting.id, 'TRANSCRIPT', 1, 0);
    let sends = 0;
    const messages = [{ id: 'discord-message-1', content: `全文\n-# ${pending.marker}`, author: { id: 'bot' } }];
    const channel = {
      client: { user: { id: 'bot' } },
      messages: { fetch: async (key: string | object) => typeof key === 'string' ? messages.find((message) => message.id === key) ?? null : { find: (predicate: (message: typeof messages[number]) => boolean) => messages.find(predicate) } },
      send: async () => { sends++; throw new Error('duplicate send'); },
    } as unknown as TextChannel;
    const publisher = new Publisher(store, channel);
    await publisher.transcript(meeting, 'short transcript');
    await publisher.transcript(meeting, 'short transcript');
    assert.equal(sends, 0);
    assert.equal(store.delivery(meeting.id, 'TRANSCRIPT', 1, 0).status, 'SENT');
  } finally { store.close(); }
});

test('consent and long minutes are sent as readable cards without mentions', async () => {
  const store = new Store(':memory:');
  try {
    const meeting = store.createMeeting({ guild_id: 'g', voice_channel_id: 'v', output_channel_id: 'c', started_by_user_id: 'u', title: '公開計画', config_snapshot_json: '{}' });
    const sent: { content: string; embeds: { toJSON: () => { title?: string; description?: string; fields?: { name: string; value: string }[] } }[]; components?: { toJSON: () => { components: { custom_id?: string }[] } }[]; allowedMentions: { parse: string[] } }[] = [];
    const edits: { content: string; embeds: { toJSON: () => { title?: string } }[]; components: { toJSON: () => { components: { disabled?: boolean }[] } }[] }[] = [];
    const channel = {
      client: { user: { id: 'bot' } },
      messages: { fetch: async (key: string | object) => typeof key === 'string'
        ? { edit: async (payload: typeof edits[number]) => { edits.push(payload); } }
        : { find: () => undefined } },
      send: async (payload: typeof sent[number]) => { sent.push(payload); return { id: `message-${sent.length}` }; },
    } as unknown as TextChannel;
    const publisher = new Publisher(store, channel);
    await publisher.notice(meeting);
    const notice = sent[0]!;
    assert.match(notice.content, /CS:.*:NOTICE:1:0/);
    assert.match(notice.embeds[0]!.toJSON().fields?.map((field) => field.value).join(' ') ?? '', /同意前は取得しません/);
    assert.equal(notice.components?.[0]?.toJSON().components.length, 3);
    assert.deepEqual(notice.allowedMentions.parse, []);
    await publisher.closeNotice(meeting);
    assert.match(edits[0]?.embeds[0]?.toJSON().title ?? '', /終了しました/);
    assert.match(edits[0]?.content ?? '', /CS:.*:NOTICE:1:0/);
    assert.ok(edits[0]?.components[0]?.toJSON().components.every((button) => button.disabled));
    await publisher.summary(meeting, `**議題**\n${'あ'.repeat(7000)}`, 1);
    assert.ok(sent.length > 2);
    for (const page of sent.slice(1)) {
      const embed = page.embeds[0]!.toJSON();
      assert.match(embed.title ?? '', /議事録 v1/);
      assert.ok((embed.description?.length ?? 0) <= 3300);
      assert.deepEqual(page.allowedMentions.parse, []);
    }
  } finally { store.close(); }
});
