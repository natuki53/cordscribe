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
