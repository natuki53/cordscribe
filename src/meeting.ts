import { joinVoiceChannel, entersState, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { ChannelType, PermissionFlagsBits, type Guild, type TextChannel, type VoiceState } from 'discord.js';
import type { Config } from './config.js';
import { AudioReceiver } from './audio.js';
import { Store } from './db.js';
import { Publisher } from './publish.js';
import { OllamaSummarizer, renderTranscript } from './summary.js';
import { AudioBudget, SttClient, SttQueue } from './stt.js';
import type { ConsentStatus, Meeting } from './types.js';

interface LiveMeeting {
  meeting: Meeting;
  guild: Guild;
  connection: VoiceConnection;
  audio: AudioReceiver;
  queue: SttQueue;
  budget: AudioBudget;
  publisher: Publisher;
  emptySince: number | null;
  warnedQueue: boolean;
  criticalQueue: boolean;
  lastKeepaliveAtMs: number;
}

export class MeetingService {
  private live: LiveMeeting | null = null;
  private stopping: Promise<void> | null = null;
  private monitor: NodeJS.Timeout;
  readonly stt: SttClient;
  readonly summarizer: OllamaSummarizer;

  constructor(readonly config: Config, readonly store: Store, readonly output: TextChannel) {
    this.stt = new SttClient(config.sttBaseUrl);
    this.summarizer = new OllamaSummarizer(store, config.ollamaBaseUrl, config.ollamaModel, config.timeZone);
    this.monitor = setInterval(() => { void this.monitorMeeting().catch((error) => this.logError('MONITOR_FAILED', error)); }, 5000);
  }

  private logError(code: string, error: unknown): void {
    console.error(code, error instanceof Error ? error.message : String(error));
  }

  private async ensureSttReady(): Promise<void> {
    // An active chat request may be delayed; meetings own the shared GPU first.
    try {
      const response = await fetch(`${this.config.ollamaBaseUrl}/api/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.config.ollamaModel, prompt: '', keep_alive: 0, stream: false }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) this.logError('OLLAMA_UNLOAD_FAILED', `HTTP ${response.status}`);
    } catch (error) { this.logError('OLLAMA_UNLOAD_FAILED', error); }
    if (!(await this.stt.ready())) await this.stt.load();
    if (!(await this.stt.ready())) throw new Error('STT is not ready');
  }

  async start(guild: Guild, voiceChannelId: string, userId: string, title: string | null): Promise<Meeting> {
    if (this.live || this.store.activeMeeting(guild.id)) throw new Error('A meeting is already active');
    const voice = guild.channels.cache.get(voiceChannelId);
    if (!voice || voice.type !== ChannelType.GuildVoice) throw new Error('Join a voice channel before starting');
    if (guild.voiceStates.cache.get(userId)?.channelId !== voice.id) throw new Error('Only a participant in the voice channel may start');
    const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const permissions = botMember && voice.permissionsFor(botMember);
    if (permissions && (!permissions.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.Connect))) {
      throw new Error('Bot needs View Channel and Connect permissions in this voice channel');
    }
    const outputPermissions = botMember && this.output.permissionsFor(botMember);
    if (outputPermissions && [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory]
      .some((permission) => !outputPermissions.has(permission))) {
      throw new Error('Bot needs View Channel, Send Messages, Attach Files, and Read Message History permissions in the meeting channel');
    }
    await this.ensureSttReady();
    let meeting = this.store.createMeeting({
      guild_id: guild.id, voice_channel_id: voice.id, output_channel_id: this.output.id,
      started_by_user_id: userId, title,
      config_snapshot_json: JSON.stringify({ sttModel: 'large-v3-turbo', computeType: 'int8_float16', language: 'ja', beamSize: 1, silenceEndMs: 900, minUtteranceMs: 300, maxUtteranceMs: 28000, summaryModel: this.config.ollamaModel }),
    });
    let connection: VoiceConnection | null = null;
    try {
      connection = joinVoiceChannel({ channelId: voice.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
      connection.on('stateChange', (oldState, newState) => console.info('VOICE_CONNECTION_STATE', oldState.status, newState.status));
      connection.on('error', (error) => this.logError('VOICE_CONNECTION_ERROR', error));
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      meeting = this.store.setStatus(meeting.id, ['STARTING'], 'RECORDING', { startedAt: Date.now() });
      for (const state of guild.voiceStates.cache.values()) {
        if (state.channelId === voice.id && state.id !== guild.client.user?.id && !state.member?.user.bot) {
          this.store.join(meeting.id, state.id, state.member?.displayName ?? state.id);
        }
      }
      const publisher = new Publisher(this.store, this.output);
      const budget = new AudioBudget(() => { void this.stop('AUDIO_MEMORY_LIMIT').catch((error) => this.logError('AUTO_STOP_FAILED', error)); });
      const queue = new SttQueue(this.store, this.stt, budget);
      const audio = new AudioReceiver(connection.receiver, meeting.id, meeting.started_at_ms!, this.store, queue, budget,
        (reason) => { this.store.event(meeting.id, reason, 'ERROR'); void this.stop(reason).catch((error) => this.logError('AUDIO_STOP_FAILED', error)); });
      this.live = { meeting, guild, connection, audio, queue, budget, publisher, emptySince: null, warnedQueue: false, criticalQueue: false, lastKeepaliveAtMs: Date.now() };
      await publisher.notice(meeting);
      connection.on('stateChange', (_old, state) => {
        if (state.status !== VoiceConnectionStatus.Disconnected || !this.live || this.live.meeting.id !== meeting.id) return;
        void entersState(connection!, VoiceConnectionStatus.Ready, 20_000).catch(() => {
          if (this.live?.meeting.id === meeting.id) void this.stop('VOICE_DISCONNECTED').catch((error) => this.logError('VOICE_STOP_FAILED', error));
        });
      });
      return meeting;
    } catch (error) {
      this.logError('MEETING_START_FAILED', error);
      if (this.live?.meeting.id === meeting.id) { await this.live.audio.stop(); await this.live.queue.drain(meeting.id); this.live = null; }
      connection?.destroy();
      this.store.setStatus(meeting.id, ['STARTING', 'RECORDING'], 'FAILED', { stoppedAt: Date.now(), stopReason: 'START_FAILED' });
      throw error;
    }
  }

  async consent(meetingId: string, userId: string, status: ConsentStatus): Promise<string> {
    const live = this.live;
    if (!live || live.meeting.id !== meetingId || live.meeting.status !== 'RECORDING') throw new Error('Meeting is not recording');
    const state = live.guild.voiceStates.cache.get(userId);
    if (state?.channelId !== live.meeting.voice_channel_id) throw new Error('Join the meeting voice channel first');
    if (!this.store.getParticipant(meetingId, userId)) this.store.join(meetingId, userId, state.member?.displayName ?? userId);
    if (status === 'ACCEPTED') {
      const previous = this.store.getParticipant(meetingId, userId)!.consent_status;
      this.store.setConsent(meetingId, userId, status);
      try { live.audio.subscribe(userId); }
      catch (error) { this.store.setConsent(meetingId, userId, previous); throw error; }
      return '同意しました。今から音声を文字起こしします。';
    }
    await live.audio.unsubscribe(userId, true);
    this.store.setConsent(meetingId, userId, status);
    return status === 'REVOKED' ? '同意を撤回しました。以後の音声取得を停止し、未確定の音声を破棄しました。' : '同意しませんでした。音声は取得しません。';
  }

  async voiceState(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const live = this.live;
    if (!live || live.meeting.status !== 'RECORDING') return;
    const id = live.meeting.id;
    const voiceId = live.meeting.voice_channel_id;
    if (oldState.channelId === voiceId && newState.channelId !== voiceId) {
      await live.audio.unsubscribe(oldState.id, false);
      this.store.leave(id, oldState.id);
    }
    if (newState.channelId === voiceId && oldState.channelId !== voiceId && !newState.member?.user.bot) {
      const participant = this.store.join(id, newState.id, newState.member?.displayName ?? newState.id);
      if (participant.consent_status === 'ACCEPTED') live.audio.subscribe(newState.id);
      else await live.publisher.warning(live.meeting, `${participant.display_name_snapshot}さんが参加しました。会議案内のボタンから本人が録音への同意を選んでください。`);
    }
  }

  async stop(reason = 'MANUAL'): Promise<void> {
    if (this.stopping) return this.stopping;
    const live = this.live;
    if (!live) throw new Error('No active meeting');
    this.stopping = this.stopInternal(live, reason).finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async stopInternal(live: LiveMeeting, reason: string): Promise<void> {
    const id = live.meeting.id;
    const stoppedAt = Date.now();
    live.meeting = this.store.setStatus(id, ['RECORDING'], 'DRAINING', { stoppedAt, stopReason: reason });
    await live.audio.stop();
    live.connection.destroy();
    this.store.closePresences(id, stoppedAt);
    await live.queue.drain(id);
    this.live = null;
    this.store.finalizeTranscription(id);
    await this.stt.unload().catch((error) => this.logError('STT_UNLOAD_FAILED', error));
    await this.publishAndSummarize(this.store.getMeeting(id)!, live.publisher);
  }

  private async publishAndSummarize(meeting: Meeting, publisher: Publisher): Promise<void> {
    const utterances = this.store.utterances(meeting.id);
    await publisher.transcript(meeting, renderTranscript(meeting, this.store.participants(meeting.id), utterances));
    try {
      const result = await this.summarizer.summarize(meeting);
      await publisher.summary(this.store.getMeeting(meeting.id)!, result.markdown, result.version);
    } catch (error) {
      await publisher.warning(meeting, `要約に失敗しました。全文は保存済みです。会議チャンネルで /meeting regenerate を実行すると再試行できます。`);
      throw error;
    }
  }

  async finalize(meetingId: string): Promise<void> {
    const meeting = this.store.getMeeting(meetingId);
    if (!meeting || !['INTERRUPTED', 'TRANSCRIBED'].includes(meeting.status)) throw new Error('Meeting is not ready for finalization');
    if (meeting.status === 'INTERRUPTED') this.store.finalizeTranscription(meeting.id);
    await this.stt.unload().catch(() => null);
    await this.publishAndSummarize(this.store.getMeeting(meeting.id)!, new Publisher(this.store, this.output));
  }

  async regenerate(meetingId: string): Promise<void> {
    const meeting = this.store.getMeeting(meetingId);
    if (!meeting) throw new Error('会議データが見つかりません。30日後に削除されたデータは再要約できません。');
    if (!['TRANSCRIBED', 'COMPLETED'].includes(meeting.status)) throw new Error('Meeting is not transcribed');
    const publisher = new Publisher(this.store, this.output);
    const result = await this.summarizer.summarize(meeting);
    await publisher.summary(this.store.getMeeting(meeting.id)!, result.markdown, result.version);
  }

  async transcript(meetingId: string): Promise<void> {
    const meeting = this.store.getMeeting(meetingId);
    if (!meeting || !['TRANSCRIBED', 'SUMMARIZING', 'COMPLETED'].includes(meeting.status)) throw new Error('No transcript is available');
    await new Publisher(this.store, this.output).transcript(meeting, renderTranscript(meeting, this.store.participants(meeting.id), this.store.utterances(meeting.id)));
  }

  async delete(meetingId: string): Promise<void> {
    const meeting = this.store.getMeeting(meetingId);
    if (!meeting || meeting.guild_id !== this.config.guildId) throw new Error('Meeting not found');
    if (['STARTING', 'RECORDING', 'DRAINING', 'SUMMARIZING'].includes(meeting.status)) throw new Error('Stop the meeting first');
    await new Publisher(this.store, this.output).deletePosts(meeting.id);
    this.store.deleteMeeting(meeting.id);
  }

  async reconcilePublications(): Promise<void> {
    const publisher = new Publisher(this.store, this.output);
    for (const meeting of this.store.recentFinished()) {
      try {
        await publisher.transcript(meeting, renderTranscript(meeting, this.store.participants(meeting.id), this.store.utterances(meeting.id)));
        for (const run of this.store.completedSummaries(meeting.id)) await publisher.summary(meeting, run.markdown, run.version);
      } catch (error) { this.logError('PUBLICATION_RETRY_FAILED', error); }
    }
  }

  status(): string {
    const meeting = this.live?.meeting ?? this.store.latestMeeting(this.config.guildId);
    if (!meeting) return '会議記録はまだありません。';
    const live = this.live;
    return `会議ID: ${meeting.id}\n状態: ${this.store.getMeeting(meeting.id)?.status}\n同意済み: ${this.store.participants(meeting.id).filter((p) => p.consent_status === 'ACCEPTED').length}人\nSTT待ち: ${live?.queue.pendingJobs ?? 0}件 / 最古: ${Math.round((live?.queue.oldestJobAgeMs ?? 0) / 1000)}秒 / 音声RAM: ${Math.round((live?.budget.bytes ?? 0) / 1024 / 1024)}MiB`;
  }

  private async monitorMeeting(): Promise<void> {
    const live = this.live;
    if (!live || this.stopping) return;
    const now = Date.now();
    if (now - live.lastKeepaliveAtMs >= 60_000) {
      live.lastKeepaliveAtMs = now;
      await this.stt.keepalive().catch((error) => this.logError('STT_KEEPALIVE_FAILED', error));
    }
    const voice = live.guild.channels.cache.get(live.meeting.voice_channel_id);
    if (!voice || voice.type !== ChannelType.GuildVoice) { await this.stop('VOICE_CHANNEL_REMOVED'); return; }
    const humans = live.guild.voiceStates.cache.filter((state) => state.channelId === voice.id && state.id !== live.guild.client.user?.id && !state.member?.user.bot).size;
    live.emptySince = humans === 0 ? live.emptySince ?? now : null;
    if (live.emptySince !== null && now - live.emptySince >= 300_000) { await this.stop('EMPTY_AUTO_STOP'); return; }
    if (now - (live.meeting.started_at_ms ?? now) >= 14_400_000) { await this.stop('MAX_DURATION'); return; }
    const age = live.queue.oldestJobAgeMs;
    if (age > 60_000 && !live.warnedQueue) {
      live.warnedQueue = true;
      this.store.event(live.meeting.id, 'STT_QUEUE_DELAY_WARNING', 'WARNING', { ageMs: age });
      await live.publisher.warning(live.meeting, `文字起こし処理が約${Math.round(age / 1000)}秒遅延しています。`);
    }
    if (age > 180_000 && !live.criticalQueue) {
      live.criticalQueue = true;
      this.store.event(live.meeting.id, 'STT_QUEUE_DELAY_CRITICAL', 'ERROR', { ageMs: age });
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.monitor);
    if (this.live) await this.stop('BOT_SHUTDOWN');
  }
}
