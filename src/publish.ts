import { AttachmentBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, type TextChannel } from 'discord.js';
import type { Store, Delivery } from './db.js';
import type { Meeting } from './types.js';

const MENTIONS = { parse: [] as [] };
const COLORS = { recording: 0xe55b6b, summary: 0x22a699, transcript: 0x568be3, warning: 0xe5a84b };
const safe = (value: string) => value.replaceAll('@', '@\u200b').replaceAll('`', 'ˋ');

function consentButtons(meeting: Meeting, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`consent:${meeting.id}:ACCEPTED`).setLabel('録音に同意').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`consent:${meeting.id}:DECLINED`).setLabel('同意しない').setEmoji('🚫').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`consent:${meeting.id}:REVOKED`).setLabel('同意を撤回').setEmoji('↩️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

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

  private async send(delivery: Delivery, content: string, file?: Buffer, components?: ActionRowBuilder<ButtonBuilder>[], embed?: EmbedBuilder): Promise<void> {
    const existing = await this.existing(delivery);
    if (existing) { this.store.delivered(delivery.id, existing); return; }
    const attachment = file ? [new AttachmentBuilder(file, { name: `CordScribe-全文-${delivery.meeting_id}-${delivery.part + 1}.txt` })] : [];
    const sent = await this.channel.send({ content: `${content}\n-# ${delivery.marker}`, files: attachment, components, embeds: embed ? [embed] : [], allowedMentions: MENTIONS });
    this.store.delivered(delivery.id, sent.id);
  }

  async notice(meeting: Meeting): Promise<void> {
    const embed = new EmbedBuilder().setColor(COLORS.recording).setTitle('🔴 会議記録への同意')
      .setDescription(`**${safe(meeting.title ?? '会議')}**\nVCにいる本人が、下のボタンで録音への意思を選んでください。`)
      .addFields(
        { name: '🎙️ 記録する音声', value: '「同意して参加」を押した人の音声だけを取得し、文字起こしします。同意前は取得しません。' },
        { name: '↩️ 途中で撤回する', value: '撤回後の取得を止め、未確定の音声を破棄します。撤回前に確定した発言は議事録に残ります。' },
        { name: '📄 投稿と保存', value: '全文と議事録はこのチャンネルに投稿します。Bot内の本文は30日後に削除します。Discordへの投稿は自動削除しません。' },
      ).setFooter({ text: `会議ID: ${meeting.id}` });
    await this.send(this.store.delivery(meeting.id, 'NOTICE', 1, 0), '会議記録の同意を選んでください。', undefined, [consentButtons(meeting)], embed);
  }

  async closeNotice(meeting: Meeting): Promise<void> {
    const delivery = this.store.delivery(meeting.id, 'NOTICE', 1, 0);
    if (!delivery.message_id) return;
    const message = await this.channel.messages.fetch(delivery.message_id).catch(() => null);
    if (!message) return;
    const embed = new EmbedBuilder().setColor(COLORS.transcript).setTitle('⏹️ 会議記録は終了しました')
      .setDescription(`**${safe(meeting.title ?? '会議')}**\n録音と同意の受付を終了しました。全文と議事録はこのチャンネルに投稿します。`)
      .setFooter({ text: `会議ID: ${meeting.id}` });
    await message.edit({ content: `会議記録を終了しました。\n-# ${delivery.marker}`, embeds: [embed], components: [consentButtons(meeting, true)], allowedMentions: MENTIONS });
  }

  async transcript(meeting: Meeting, text: string): Promise<void> {
    const parts = splitUtf8(text, 7 * 1024 * 1024);
    for (let i = 0; i < parts.length; i++) {
      const partial = meeting.transcription_result === 'PARTIAL';
      const embed = new EmbedBuilder().setColor(COLORS.transcript).setTitle(`📄 文字起こし全文 ${i + 1}/${parts.length}`)
        .setDescription(`${safe(meeting.title ?? '会議')}の発言を、時刻・話者・根拠ID付きのテキストにまとめました。下の添付ファイルから確認できます。`)
        .addFields({ name: '文字起こしの状態', value: partial ? '一部の音声を文字起こしできませんでした。欠損箇所は添付内に表示しています。' : '完了' })
        .setFooter({ text: `会議ID: ${meeting.id}` });
      await this.send(this.store.delivery(meeting.id, 'TRANSCRIPT', 1, i), `全文 ${i + 1}/${parts.length}`, parts[i], undefined, embed);
    }
  }

  async summary(meeting: Meeting, markdown: string, version: number): Promise<void> {
    const parts = splitByLines(markdown, 3300);
    for (let i = 0; i < parts.length; i++) {
      const embed = new EmbedBuilder().setColor(COLORS.summary).setTitle(`📋 議事録 v${version} ・ ${i + 1}/${parts.length}`)
        .setDescription(parts[i]!).setFooter({ text: `会議ID: ${meeting.id} ・ 根拠IDの発言は全文添付で確認できます` });
      await this.send(this.store.delivery(meeting.id, 'SUMMARY', version, i), `議事録 v${version} ${i + 1}/${parts.length}`, undefined, undefined, embed);
    }
  }

  async warning(meeting: Meeting, message: string): Promise<void> {
    const embed = new EmbedBuilder().setColor(COLORS.warning).setTitle('⚠️ 会議記録のお知らせ')
      .setDescription(safe(message)).setFooter({ text: `会議ID: ${meeting.id}` });
    await this.send(this.store.delivery(meeting.id, 'WARNING', Date.now(), 0), '会議記録のお知らせ', undefined, undefined, embed);
  }

  async consentReminder(meeting: Meeting, displayName: string): Promise<void> {
    const embed = new EmbedBuilder().setColor(COLORS.transcript).setTitle('🎙️ 録音への同意を確認してください')
      .setDescription(`${safe(displayName)}さんがVCに参加しました。録音に同意する場合は、上の会議案内から本人がボタンを押してください。同意前の音声は取得しません。`)
      .setFooter({ text: `会議ID: ${meeting.id}` });
    await this.send(this.store.delivery(meeting.id, 'WARNING', Date.now(), 0), '録音への同意案内', undefined, undefined, embed);
  }

  async deletePosts(meetingId: string): Promise<void> {
    for (const delivery of this.store.deliveries(meetingId)) {
      if (!delivery.message_id) continue;
      const message = await this.channel.messages.fetch(delivery.message_id).catch(() => null);
      if (message) await message.delete();
    }
  }
}
