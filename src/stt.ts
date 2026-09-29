import type { Store } from './db.js';

export const AUDIO_MEMORY_LIMIT = 256 * 1024 * 1024;
const WARNING_RESERVE = 8 * 1024 * 1024;

export interface AsrMetrics {
  avgLogprob: number | null;
  noSpeechProbability: number | null;
  compressionRatio: number | null;
  rmsDbfs: number;
  peak: number;
  clippingRatio: number;
  speechDurationMs: number;
  confidence: 'none' | 'low' | 'medium' | 'high';
  suspectedHallucination: boolean;
  hallucinationReasons: string[];
  hallucinationPhraseMatch: boolean;
  debugAudioId: string | null;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  languageProbability: number;
  durationMs: number;
  asr: AsrMetrics;
}

export class AudioBudget {
  bytes = 0;
  private warned = false;
  constructor(readonly onNearLimit: () => void, readonly limit = AUDIO_MEMORY_LIMIT) {}
  add(size: number): void {
    if (this.bytes + size > this.limit) throw new Error('AUDIO_MEMORY_HARD_LIMIT');
    this.bytes += size;
    if (!this.warned && this.bytes >= this.limit - WARNING_RESERVE) {
      this.warned = true;
      queueMicrotask(this.onNearLimit);
    }
  }
  release(size: number): void { this.bytes = Math.max(0, this.bytes - size); }
}

export class SttClient {
  constructor(readonly baseUrl: string) {}

  private async json(path: string, method = 'GET'): Promise<any> {
    const response = await fetch(`${this.baseUrl}${path}`, { method, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`STT_${response.status}`);
    return response.json();
  }

  async load(): Promise<void> { await this.json('/admin/load', 'POST'); }
  async unload(): Promise<void> { await this.json('/admin/unload', 'POST'); }
  async keepalive(): Promise<void> { await this.json('/admin/keepalive', 'POST'); }
  async ready(): Promise<boolean> {
    try { return (await this.json('/ready')).ready === true; } catch { return false; }
  }

  async transcribe(audio: Buffer): Promise<TranscriptionResult> {
    const response = await fetch(`${this.baseUrl}/v1/transcribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-audio-format': 's16le',
        'x-sample-rate': '16000',
        'x-channels': '1',
        'x-language': 'ja',
      },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      const error = new Error(`STT_${response.status}`) as Error & { retryable?: boolean };
      error.retryable = response.status >= 500 || response.status === 429;
      throw error;
    }
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object') throw new Error('STT_INVALID_RESPONSE');
    const value = result as Record<string, unknown>;
    const asr = value.asr as Record<string, unknown> | undefined;
    const nullableNumber = (input: unknown) => input === null || typeof input === 'number';
    const confidence = asr?.confidence;
    if (typeof value.text !== 'string' || typeof value.language !== 'string' || typeof value.languageProbability !== 'number' || typeof value.durationMs !== 'number'
      || !asr || !nullableNumber(asr.avgLogprob) || !nullableNumber(asr.noSpeechProbability) || !nullableNumber(asr.compressionRatio)
      || typeof asr.rmsDbfs !== 'number' || typeof asr.peak !== 'number' || typeof asr.clippingRatio !== 'number'
      || typeof asr.speechDurationMs !== 'number' || !['none', 'low', 'medium', 'high'].includes(String(confidence))
      || typeof asr.suspectedHallucination !== 'boolean' || !Array.isArray(asr.hallucinationReasons)
      || asr.hallucinationReasons.some((reason) => typeof reason !== 'string') || typeof asr.hallucinationPhraseMatch !== 'boolean'
      || !(asr.debugAudioId === null || typeof asr.debugAudioId === 'string')) {
      throw new Error('STT_INVALID_RESPONSE');
    }
    return value as unknown as TranscriptionResult;
  }
}

interface Job { utteranceId: string; meetingId: string; publicId?: string; audio: Buffer; enqueuedAtMs: number }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SttQueue {
  private jobs: Job[] = [];
  private processing = false;
  private active: Job | null = null;
  private waiters: (() => void)[] = [];
  private recentPhrases = new Map<string, number[]>();

  constructor(readonly store: Store, readonly client: SttClient, readonly budget: AudioBudget, readonly debugLog = false) {}

  enqueue(job: Job): void {
    this.jobs.push(job);
    void this.run();
  }

  get pendingJobs(): number { return this.jobs.length + Number(this.active !== null); }
  get oldestJobAgeMs(): number {
    const oldest = this.active?.enqueuedAtMs ?? this.jobs[0]?.enqueuedAtMs;
    return oldest === undefined ? 0 : Date.now() - oldest;
  }
  get pendingAudioDurationMs(): number { return Math.round((this.jobs.reduce((n, j) => n + j.audio.byteLength, 0) + (this.active?.audio.byteLength ?? 0)) / 32); }

  async drain(meetingId: string): Promise<void> {
    while (this.jobs.some((job) => job.meetingId === meetingId) || this.active?.meetingId === meetingId) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void { this.waiters.splice(0).forEach((resolve) => resolve()); }

  private applyRepetitionEvidence(job: Job, result: TranscriptionResult): void {
    if (!result.asr.hallucinationPhraseMatch || !result.text.trim()) return;
    const normalized = result.text.normalize('NFKC').replace(/[\s。．.!！?？、，]+/g, '');
    const key = `${job.meetingId}\0${normalized}`;
    const cutoff = job.enqueuedAtMs - 5 * 60_000;
    const timestamps = (this.recentPhrases.get(key) ?? []).filter((timestamp) => timestamp >= cutoff);
    timestamps.push(job.enqueuedAtMs);
    this.recentPhrases.set(key, timestamps);
    if (timestamps.length < 3) return;
    result.asr.suspectedHallucination = true;
    result.asr.confidence = 'low';
    if (!result.asr.hallucinationReasons.includes('repeated_phrase')) result.asr.hallucinationReasons.push('repeated_phrase');
  }

  private async run(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift()!;
        this.active = job;
        try { await this.process(job); }
        catch (error) {
          console.error('STT_QUEUE_FAILED', error instanceof Error ? error.message : String(error));
          try {
            this.store.setUtterance(job.utteranceId, 'FAILED', { errorCode: 'STT_QUEUE_FAILED' });
            this.store.event(job.meetingId, 'STT_QUEUE_FAILED', 'ERROR', { utteranceId: job.utteranceId });
          } catch (storeError) {
            console.error('STT_STORE_FAILED', storeError instanceof Error ? storeError.message : String(storeError));
          }
        }
        finally {
          this.budget.release(job.audio.byteLength);
          this.active = null;
          this.wake();
        }
      }
    } finally { this.processing = false; this.wake(); }
  }

  private async process(job: Job): Promise<void> {
    this.store.setUtterance(job.utteranceId, 'PROCESSING');
    const started = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await this.client.transcribe(job.audio);
        this.applyRepetitionEvidence(job, result);
        const text = result.text.trim();
        this.store.setUtterance(job.utteranceId, text ? 'TRANSCRIBED' : 'IGNORED', {
          text, language: result.language, probability: result.languageProbability,
          latencyMs: Date.now() - started, attempts: attempt,
          avgLogprob: result.asr.avgLogprob,
          noSpeechProbability: result.asr.noSpeechProbability,
          compressionRatio: result.asr.compressionRatio,
          rmsDbfs: result.asr.rmsDbfs,
          peak: result.asr.peak,
          clippingRatio: result.asr.clippingRatio,
          speechDurationMs: result.asr.speechDurationMs,
          asrConfidence: result.asr.confidence,
          suspectedHallucination: result.asr.suspectedHallucination,
          hallucinationReasons: result.asr.hallucinationReasons,
          errorCode: text ? undefined : result.asr.speechDurationMs === 0 ? 'VAD_NO_SPEECH' : 'ASR_EMPTY',
        });
        if (this.debugLog) console.info('ASR_RESULT', {
          utteranceId: job.publicId ?? job.utteranceId,
          durationMs: result.durationMs,
          speechDurationMs: result.asr.speechDurationMs,
          rmsDbfs: result.asr.rmsDbfs,
          peak: result.asr.peak,
          clippingRatio: result.asr.clippingRatio,
          avgLogprob: result.asr.avgLogprob,
          noSpeechProbability: result.asr.noSpeechProbability,
          compressionRatio: result.asr.compressionRatio,
          confidence: result.asr.confidence,
          suspectedHallucination: result.asr.suspectedHallucination,
          textLength: text.length,
        });
        return;
      } catch (error) {
        const retryable = error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || (error as Error & { retryable?: boolean }).retryable === true));
        if (!retryable || attempt === 3) {
          this.store.setUtterance(job.utteranceId, 'FAILED', { attempts: attempt, latencyMs: Date.now() - started, errorCode: error instanceof Error ? error.message.slice(0, 80) : 'STT_ERROR' });
          this.store.event(job.meetingId, 'STT_FAILED', 'ERROR', { utteranceId: job.utteranceId });
          return;
        }
        await sleep(attempt === 1 ? 500 : 2000);
      }
    }
  }
}
