import type { Store } from './db.js';

export const AUDIO_MEMORY_LIMIT = 256 * 1024 * 1024;
const WARNING_RESERVE = 8 * 1024 * 1024;

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

  async transcribe(audio: Buffer): Promise<{ text: string; language: string; languageProbability: number; durationMs: number }> {
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
    if (typeof value.text !== 'string' || typeof value.language !== 'string' || typeof value.languageProbability !== 'number' || typeof value.durationMs !== 'number') {
      throw new Error('STT_INVALID_RESPONSE');
    }
    return value as { text: string; language: string; languageProbability: number; durationMs: number };
  }
}

interface Job { utteranceId: string; meetingId: string; audio: Buffer; enqueuedAtMs: number }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SttQueue {
  private jobs: Job[] = [];
  private processing = false;
  private active: Job | null = null;
  private waiters: (() => void)[] = [];

  constructor(readonly store: Store, readonly client: SttClient, readonly budget: AudioBudget) {}

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
        const text = result.text.trim();
        this.store.setUtterance(job.utteranceId, text ? 'TRANSCRIBED' : 'IGNORED', {
          text, language: result.language, probability: result.languageProbability,
          latencyMs: Date.now() - started, attempts: attempt,
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
