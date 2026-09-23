import { AttachmentBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, type TextChannel } from 'discord.js';
import type { Store, Delivery } from './db.js';
import type { Meeting } from './types.js';

const MENTIONS = { parse: [] as [] };

function splitByLines(text: string, maxChars: number): string[] {
  const result: string[] = [];
  let part = '';
  for (const line of text.split('\n')) {
    if (part.length + line.length + 1 > maxChars && part) { result.push(part); part = ''; }
    if (line.length > maxChars) {
      for (let i = 0; i < line.length; i += maxChars) result.push(line.slice(i, i + maxChars));
    } else part += `${line}\n`;
  }
  if (part) result.push(part);
  return result;
}

function splitUtf8(text: string, maxBytes: number): Buffer[] {
  const chunks: Buffer[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => { if (current.length) { chunks.push(Buffer.from(current.join(''), 'utf8')); current = []; size = 0; } };
  for (const line of text.split('\n')) {
    for (const char of `${line}\n`) {
      const bytes = Buffer.byteLength(char, 'utf8');
      if (size + bytes > maxBytes) flush();
      current.push(char);
      size += bytes;
    }
  }
  flush();
  return chunks;
}

export class Publisher {
  constructor(readonly store: Store, readonly channel: TextChannel) {}

  private async existing(delivery: Delivery): Promise<string | undefined> {
    if (delivery.message_id) {
      const message = await this.channel.messages.fetch(delivery.message_id).catch(() => null);
      if (message) return message.id;
    }
    const recent = await this.channel.messages.fetch({ limit: 100 });
    return recent.find((message) => message.author.id === this.channel.client.user?.id && message.content.includes(delivery.marker))?.id;
  }

  private async send(delivery: Delivery, content: string, file?: Buffer, components?: ActionRowBuilder<ButtonBuilder>[]): Promise<void> {
    const existing = await this.existing(delivery);
    if (existing) { this.store.delivered(delivery.id, existing); return; }
    const attachment = file ? [new AttachmentBuilder(file, { name: `cordscribe-${delivery.meeting_id}-${delivery.part}.txt` })] : [];
    const sent = await this.channel.send({ content: `${content}\n-# ${delivery.marker}`, files: attachment, components, allowedMentions: MENTIONS });
    this.store.delivered(delivery.id, sent.id);
  }

  async notice(meeting: Meeting): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`consent:${meeting.id}:ACCEPTED`).setLabel('録音・文字起こしに同意').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`consent:${meeting.id}:DECLINED`).setLabel('同意しない').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`consent:${meeting.id}:REVOKED`).setLabel('同意を撤回').setStyle(ButtonStyle.Danger),
    );
    await this.send(this.store.delivery(meeting.id, 'NOTICE', 1, 0),
      `🔴 会議記録を開始しました。VC参加者は自分の意思で同意してください。同意前と撤回後の音声は取得しません。全文と要約はこのチャンネルに投稿され、Discord上に残ります。Bot側の本文は30日後に削除します。会議ID: ${meeting.id}`, undefined, [row]);
  }

  async transcript(meeting: Meeting, text: string): Promise<void> {
    const parts = splitUtf8(text, 7 * 1024 * 1024);
    for (let i = 0; i < parts.length; i++) {
      await this.send(this.store.delivery(meeting.id, 'TRANSCRIPT', 1, i), `📄 全文 ${i + 1}/${parts.length}（${meeting.transcription_result === 'PARTIAL' ? '一部欠損' : '完了'}）`, parts[i]);
    }
  }

  async summary(meeting: Meeting, markdown: string, version: number): Promise<void> {
    const parts = splitByLines(markdown, 1750);
    for (let i = 0; i < parts.length; i++) {
      await this.send(this.store.delivery(meeting.id, 'SUMMARY', version, i), `**議事録 v${version} (${i + 1}/${parts.length})**\n${parts[i]}`);
    }
  }

  async warning(meeting: Meeting, message: string): Promise<void> {
    await this.send(this.store.delivery(meeting.id, 'WARNING', Date.now(), 0), `⚠️ ${message}`);
  }

  async deletePosts(meetingId: string): Promise<void> {
    for (const delivery of this.store.deliveries(meetingId)) {
      if (!delivery.message_id) continue;
      const message = await this.channel.messages.fetch(delivery.message_id).catch(() => null);
      if (message) await message.delete();
    }
  }
}
