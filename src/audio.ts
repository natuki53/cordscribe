import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { EndBehaviorType, type VoiceReceiver } from '@discordjs/voice';
import prism from 'prism-media';
import type { Store } from './db.js';
import { AudioBudget, SttQueue } from './stt.js';

export const SILENCE_END_MS = 900;
export const MAX_UTTERANCE_MS = 28_000;
export const MIN_UTTERANCE_MS = 300;
export const MAX_CONSENTED_SPEAKERS = 8;
const VOICE_RMS_THRESHOLD = 180;

function voiced(chunk: Buffer): boolean {
  let sum = 0;
  let count = 0;
  for (let offset = 0; offset + 1 < chunk.length; offset += 8) {
    const sample = chunk.readInt16LE(offset);
    sum += sample * sample;
    count++;
  }
  return count > 0 && Math.sqrt(sum / count) >= VOICE_RMS_THRESHOLD;
}

export class Segmenter {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private startedAtMs: number | null = null;
  private lastAudioAtMs: number | null = null;
  private lastVoicedAtMs: number | null = null;
  private chainId: string | null = null;
  private chainIndex = 0;

  constructor(
    readonly meetingId: string,
    readonly userId: string,
    readonly meetingStartedAtMs: number,
    readonly store: Store,
    readonly queue: SttQueue,
    readonly budget: AudioBudget,
  ) {}

  push(chunk: Buffer, atMs = Date.now(), hasVoice = true): void {
    if (!chunk.length) return;
    if (chunk.byteLength % 2) throw new Error('INVALID_PCM_LENGTH');
    if (this.lastVoicedAtMs !== null && atMs - this.lastVoicedAtMs >= SILENCE_END_MS) this.finalize(false);
    if (!hasVoice && this.startedAtMs === null) return;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const partAtMs = atMs + Math.round(offset / 32);
      if (this.startedAtMs !== null && partAtMs - this.startedAtMs >= MAX_UTTERANCE_MS) this.finalize(true);
      if (this.startedAtMs === null) {
        this.startedAtMs = partAtMs;
        this.chainId ??= randomUUID();
      }
      const size = Math.min(chunk.byteLength - offset, MAX_UTTERANCE_MS * 32 - this.bytes);
      const part = chunk.subarray(offset, offset + size);
      this.budget.add(part.byteLength);
      this.chunks.push(part);
      this.bytes += part.byteLength;
      this.lastAudioAtMs = partAtMs;
      if (hasVoice) this.lastVoicedAtMs = partAtMs;
      offset += size;
      if (this.bytes === MAX_UTTERANCE_MS * 32) this.finalize(true);
    }
  }

  tick(now = Date.now()): void {
    if (this.lastVoicedAtMs !== null && now - this.lastVoicedAtMs >= SILENCE_END_MS) this.finalize(false);
  }

  finalize(continued = false): void {
    if (this.startedAtMs === null) return;
    const chunks = this.chunks;
    const bytes = this.bytes;
    const startedAt = this.startedAtMs;
    const lastAt = this.lastAudioAtMs ?? startedAt;
    const chainId = this.chainId ?? randomUUID();
    const chainIndex = this.chainIndex;
    this.chunks = [];
    this.bytes = 0;
    this.startedAtMs = null;
    this.lastAudioAtMs = null;
    this.lastVoicedAtMs = null;
    if (continued) this.chainIndex++;
    else { this.chainId = null; this.chainIndex = 0; }
    if (bytes / 32 < MIN_UTTERANCE_MS) { this.budget.release(bytes); return; }
    try {
      const utterance = this.store.createUtterance({
        meeting_id: this.meetingId, speaker_user_id: this.userId, chain_id: chainId,
        chain_index: chainIndex,
        started_offset_ms: Math.max(0, startedAt - this.meetingStartedAtMs),
        ended_offset_ms: Math.max(0, Math.max(lastAt - this.meetingStartedAtMs, startedAt - this.meetingStartedAtMs + Math.round(bytes / 32))),
      });
      this.queue.enqueue({ utteranceId: utterance.id, meetingId: this.meetingId, audio: Buffer.concat(chunks, bytes), enqueuedAtMs: Date.now() });
    } catch (error) {
      this.budget.release(bytes);
      this.store.event(this.meetingId, 'AUDIO_ENQUEUE_FAILED', 'ERROR');
      throw error;
    }
  }

  drop(): void {
    this.budget.release(this.bytes);
    this.chunks = [];
    this.bytes = 0;
    this.startedAtMs = null;
    this.lastAudioAtMs = null;
    this.lastVoicedAtMs = null;
    this.chainId = null;
    this.chainIndex = 0;
  }
}

class SpeakerPipe {
  readonly segmenter: Segmenter;
  readonly opus: ReturnType<VoiceReceiver['subscribe']>;
  readonly decoder: prism.opus.Decoder;
  readonly ffmpeg: ChildProcessWithoutNullStreams;
  private closed = false;
  private closing = false;

  constructor(receiver: VoiceReceiver, meetingId: string, userId: string, startedAtMs: number, store: Store, queue: SttQueue, budget: AudioBudget, onFatal: (reason: string) => void) {
    this.segmenter = new Segmenter(meetingId, userId, startedAtMs, store, queue, budget);
    this.decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    this.ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      this.opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
      this.opus.pipe(this.decoder).pipe(this.ffmpeg.stdin);
    } catch (error) {
      this.decoder.destroy();
      this.ffmpeg.kill();
      throw error;
    }
    this.ffmpeg.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      try { this.segmenter.push(chunk, Date.now(), voiced(chunk)); }
      catch { onFatal('AUDIO_MEMORY_OR_DB_FAILED'); }
    });
    this.ffmpeg.stderr.on('data', () => { /* Never log audio or raw decoder output. */ });
    this.opus.on('error', () => { if (!this.closing) onFatal('OPUS_RECEIVE_FAILED'); });
    this.decoder.on('error', () => { if (!this.closing) onFatal('OPUS_DECODE_FAILED'); });
    this.ffmpeg.on('error', () => { if (!this.closing) onFatal('FFMPEG_FAILED'); });
    this.ffmpeg.on('exit', (code) => { if (!this.closing && !this.closed && code !== 0) onFatal('FFMPEG_EXITED'); });
  }

  tick(now: number): void { if (!this.closed) this.segmenter.tick(now); }
  async close(drop: boolean): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (drop) {
      this.closed = true;
      this.opus.destroy();
      this.decoder.destroy();
      this.ffmpeg.stdin.destroy();
      this.ffmpeg.kill();
      this.segmenter.drop();
      return;
    }
    const done = once(this.ffmpeg, 'close').then(() => true).catch(() => false);
    this.opus.unpipe(this.decoder);
    this.opus.destroy();
    this.decoder.end();
    const flushed = await Promise.race([done, new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000))]);
    if (!flushed) {
      this.ffmpeg.kill();
      this.segmenter.store.event(this.segmenter.meetingId, 'AUDIO_PIPELINE_FLUSH_TIMEOUT', 'WARNING');
    }
    this.closed = true;
    this.decoder.destroy();
    this.segmenter.finalize();
  }
}

export class AudioReceiver {
  private speakers = new Map<string, SpeakerPipe>();
  private timer: NodeJS.Timeout;
  constructor(
    readonly receiver: VoiceReceiver,
    readonly meetingId: string,
    readonly startedAtMs: number,
    readonly store: Store,
    readonly queue: SttQueue,
    readonly budget: AudioBudget,
    readonly onFatal: (reason: string) => void,
  ) {
    this.timer = setInterval(() => {
      for (const pipe of this.speakers.values()) pipe.tick(Date.now());
    }, 200);
  }

  subscribe(userId: string): void {
    if (this.speakers.has(userId)) return;
    if (this.speakers.size >= MAX_CONSENTED_SPEAKERS) throw new Error('Maximum eight consenting speakers');
    this.speakers.set(userId, new SpeakerPipe(this.receiver, this.meetingId, userId, this.startedAtMs, this.store, this.queue, this.budget, this.onFatal));
  }

  async unsubscribe(userId: string, drop: boolean): Promise<void> {
    const pipe = this.speakers.get(userId);
    if (!pipe) return;
    this.speakers.delete(userId);
    await pipe.close(drop);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.speakers.keys()].map((userId) => this.unsubscribe(userId, false)));
  }

  get activeSpeakers(): number { return this.speakers.size; }
}
