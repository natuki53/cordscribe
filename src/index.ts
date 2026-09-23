import { existsSync } from 'node:fs';
import { Client, GatewayIntentBits, GuildMember, MessageFlags, REST, Routes, SlashCommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction, type TextChannel } from 'discord.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { MeetingService } from './meeting.js';
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

async function authorized(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (interaction.guildId !== config.guildId) return false;
  const member = interaction.member instanceof GuildMember ? interaction.member : await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  return member?.roles.cache.has(config.operatorRoleId) ?? false;
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!service || !await authorized(interaction)) { await interaction.editReply('この操作は対象サーバーの指定ロールだけが使えます。'); return; }
  const sub = interaction.options.getSubcommand();
  const latest = store.latestMeeting(config.guildId);
  try {
    if (sub === 'start') {
      if (interaction.channelId !== config.meetingChannelId) throw new Error('設定された会議チャンネルで実行してください');
      const state = interaction.guild!.voiceStates.cache.get(interaction.user.id);
      if (!state?.channelId) throw new Error('先にVCへ参加してください');
      const meeting = await service.start(interaction.guild!, state.channelId, interaction.user.id, interaction.options.getString('title'));
      await interaction.editReply(`会議を開始しました。ID: ${meeting.id}。参加者は案内のボタンで同意できます。`);
    } else if (sub === 'stop') {
      if (!store.activeMeeting(config.guildId)) throw new Error('進行中の会議はありません');
      const pending = service.stop();
      void pending.catch((error) => console.error('MEETING_STOP_FAILED', error instanceof Error ? error.message : String(error)));
      await interaction.editReply('録音を止め、文字起こし・全文投稿・要約を進めています。結果は会議チャンネルに投稿します。');
    } else if (sub === 'status') {
      await interaction.editReply(service.status());
    } else if (sub === 'transcript') {
      const id = interaction.options.getString('id') ?? latest?.id;
      if (!id) throw new Error('会議が見つかりません');
      await service.transcript(id);
      await interaction.editReply(`会議 ${id} の全文を確認しました。未投稿なら会議チャンネルに投稿しました。`);
    } else if (sub === 'regenerate' || sub === 'finalize') {
      const id = interaction.options.getString('id', true);
      const pending = sub === 'regenerate' ? service.regenerate(id) : service.finalize(id);
      void pending.catch((error) => console.error(`MEETING_${sub.toUpperCase()}_FAILED`, error instanceof Error ? error.message : String(error)));
      await interaction.editReply(`会議 ${id} の${sub === 'regenerate' ? '要約再生成' : '部分確定'}を開始しました。`);
    } else if (sub === 'delete') {
      const id = interaction.options.getString('id', true);
      await service.delete(id);
      await interaction.editReply(`会議 ${id} のDBデータとBotの投稿を削除しました。`);
    }
  } catch (error) {
    await interaction.editReply(`処理できませんでした: ${error instanceof Error ? error.message : '不明なエラー'}`);
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const match = /^consent:([0-9a-f-]{36}):(ACCEPTED|DECLINED|REVOKED)$/.exec(interaction.customId);
  if (!match) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.guildId !== config.guildId || !service) { await interaction.editReply('この会議は操作できません。'); return; }
  try {
    const result = await service.consent(match[1]!, interaction.user.id, match[2]! as ConsentStatus);
    await interaction.editReply(result);
  } catch (error) {
    await interaction.editReply(`処理できませんでした: ${error instanceof Error ? error.message : '不明なエラー'}`);
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
      if (meeting.guild_id === config.guildId) await (channel as TextChannel).send({ content: `⚠️ 会議 ${meeting.id} はBot再起動で中断しました。未処理音声は欠損として記録しました。操作ロールの方は /meeting finalize で部分議事録を確定できます。`, allowedMentions: { parse: [] } });
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
