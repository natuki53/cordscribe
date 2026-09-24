import { existsSync } from 'node:fs';
import { Client, EmbedBuilder, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction, type TextChannel } from 'discord.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { MeetingService } from './meeting.js';
import { Publisher } from './publish.js';
import type { ConsentStatus } from './types.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const store = new Store(config.dbPath);
const recovered = store.recover();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let service: MeetingService | null = null;

const commands = [new SlashCommandBuilder().setName('meeting').setDescription('VC議事録')
  .addSubcommand((sub) => sub.setName('start').setDescription('参加中のVCで議事録を開始').addStringOption((option) => option.setName('title').setDescription('会議名').setMaxLength(100)))
  .addSubcommand((sub) => sub.setName('stop').setDescription('会議を停止して文字起こしを確定'))
  .addSubcommand((sub) => sub.setName('status').setDescription('会議の状態を表示'))
  .addSubcommand((sub) => sub.setName('transcript').setDescription('全文を投稿').addStringOption((option) => option.setName('id').setDescription('会議ID')))
  .addSubcommand((sub) => sub.setName('regenerate').setDescription('要約を再生成').addStringOption((option) => option.setName('id').setDescription('会議ID').setRequired(true)))
  .addSubcommand((sub) => sub.setName('finalize').setDescription('中断した会議を部分確定').addStringOption((option) => option.setName('id').setDescription('会議ID').setRequired(true)))
  .addSubcommand((sub) => sub.setName('delete').setDescription('会議データとBot投稿を削除').addStringOption((option) => option.setName('id').setDescription('会議ID').setRequired(true)))
  .toJSON()];

async function replyCard(interaction: ChatInputCommandInteraction | ButtonInteraction, title: string, description: string, color: number): Promise<void> {
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.replaceAll('@', '@\u200b'));
  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!service || interaction.guildId !== config.guildId || interaction.channelId !== config.meetingChannelId) {
    await replyCard(interaction, '会議チャンネルで操作してください', '設定されたサーバーの会議チャンネルから実行できます。', 0xe5a84b);
    return;
  }
  const sub = interaction.options.getSubcommand();
  const latest = store.latestMeeting(config.guildId);
  try {
    if (sub === 'start') {
      const state = interaction.guild!.voiceStates.cache.get(interaction.user.id);
      if (!state?.channelId) throw new Error('先にVCへ参加してください');
      const meeting = await service.start(interaction.guild!, state.channelId, interaction.user.id, interaction.options.getString('title'));
      await replyCard(interaction, '会議を開始しました', `会議ID: \`${meeting.id}\`\n参加者はチャンネルに投稿された案内から同意を選べます。`, 0x22a699);
    } else if (sub === 'stop') {
      if (!store.activeMeeting(config.guildId)) throw new Error('進行中の会議はありません');
      const pending = service.stop();
      void pending.catch((error) => console.error('MEETING_STOP_FAILED', error instanceof Error ? error.message : String(error)));
      await replyCard(interaction, '録音を停止しました', '文字起こしの完了後、全文と議事録をこのチャンネルに投稿します。', 0x568be3);
    } else if (sub === 'status') {
      await replyCard(interaction, '会議の状態', service.status(), 0x568be3);
    } else if (sub === 'transcript') {
      const id = interaction.options.getString('id') ?? latest?.id;
      if (!id) throw new Error('会議が見つかりません');
      await service.transcript(id);
      await replyCard(interaction, '全文を確認しました', `会議ID: \`${id}\`\n未投稿の場合はこのチャンネルに添付しました。`, 0x568be3);
    } else if (sub === 'regenerate' || sub === 'finalize') {
      const id = interaction.options.getString('id', true);
      const pending = sub === 'regenerate' ? service.regenerate(id) : service.finalize(id);
      void pending.catch((error) => console.error(`MEETING_${sub.toUpperCase()}_FAILED`, error instanceof Error ? error.message : String(error)));
      await replyCard(interaction, sub === 'regenerate' ? '議事録を再生成しています' : '部分議事録を作成しています', `会議ID: \`${id}\`\n完了後にこのチャンネルへ投稿します。`, 0x568be3);
    } else if (sub === 'delete') {
      const id = interaction.options.getString('id', true);
      await service.delete(id);
      await replyCard(interaction, '会議記録を削除しました', `会議ID: \`${id}\`\nBotに保存したデータとBotの投稿を削除しました。`, 0xe5a84b);
    }
  } catch (error) {
    await replyCard(interaction, '処理できませんでした', error instanceof Error ? error.message : '不明なエラー', 0xe55b6b);
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const match = /^consent:([0-9a-f-]{36}):(ACCEPTED|DECLINED|REVOKED)$/.exec(interaction.customId);
  if (!match) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.guildId !== config.guildId || !service) { await replyCard(interaction, '操作できません', 'この会議は操作できません。', 0xe5a84b); return; }
  try {
    const result = await service.consent(match[1]!, interaction.user.id, match[2]! as ConsentStatus);
    const status = match[2]! as ConsentStatus;
    await replyCard(interaction, status === 'ACCEPTED' ? '✅ 同意を受け付けました' : status === 'REVOKED' ? '↩️ 同意を撤回しました' : '🚫 同意しない設定にしました', result, status === 'ACCEPTED' ? 0x22a699 : 0x568be3);
  } catch (error) {
    await replyCard(interaction, '処理できませんでした', error instanceof Error ? error.message : '不明なエラー', 0xe55b6b);
  }
}

client.on('interactionCreate', (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'meeting') void handleCommand(interaction);
  if (interaction.isButton() && interaction.customId.startsWith('consent:')) void handleButton(interaction);
});
client.on('voiceStateUpdate', (oldState, newState) => {
  void service?.voiceState(oldState, newState).catch((error) => console.error('VOICE_STATE_FAILED', error instanceof Error ? error.message : String(error)));
});
client.once('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await guild.channels.fetch(config.meetingChannelId);
    if (!channel?.isTextBased() || !('send' in channel)) throw new Error('MEETING_CHANNEL_ID must be a text channel');
    service = new MeetingService(config, store, channel as TextChannel);
    const rest = new REST().setToken(config.discordToken);
    await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: commands });
    await service.reconcilePublications();
    for (const meeting of recovered) {
      if (meeting.guild_id !== config.guildId) continue;
      const publisher = new Publisher(store, channel as TextChannel);
      await publisher.closeNotice(meeting).catch((error) => console.error('NOTICE_CLOSE_FAILED', error instanceof Error ? error.message : String(error)));
      await publisher.warning(meeting, `会議 ${meeting.id} はBot再起動で中断しました。未処理音声は欠損として記録しました。会議チャンネルで /meeting finalize を実行すると部分議事録を確定できます。`);
    }
    console.info('CORDSCRIBE_READY');
  } catch (error) {
    console.error('CORDSCRIBE_START_FAILED', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    await shutdown();
  }
});

let shuttingDown = false;
const retentionTimer = setInterval(() => {
  for (const meeting of store.expired()) {
    store.deleteMeeting(meeting.id);
    console.info('MEETING_RETENTION_PURGED', meeting.id);
  }
}, 60 * 60 * 1000);
for (const meeting of store.expired()) store.deleteMeeting(meeting.id);
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await service?.shutdown(); }
  finally { clearInterval(retentionTimer); client.destroy(); store.close(); }
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
client.login(config.discordToken).catch((error) => { console.error('DISCORD_LOGIN_FAILED', error instanceof Error ? error.message : String(error)); process.exitCode = 1; void shutdown(); });
