import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConsentStatus, Meeting, MeetingStatus, Participant, Utterance, UtteranceStatus } from './types.js';

const DAY_MS = 86_400_000;
const ACTIVE = "'STARTING','RECORDING','DRAINING','SUMMARIZING'";

export interface Delivery {
  id: string;
  meeting_id: string;
  kind: 'NOTICE' | 'TRANSCRIPT' | 'SUMMARY' | 'WARNING';
  version: number;
  part: number;
  marker: string;
  message_id: string | null;
  status: 'PENDING' | 'SENT';
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, voice_channel_id TEXT NOT NULL,
        output_channel_id TEXT NOT NULL, started_by_user_id TEXT NOT NULL, title TEXT,
        status TEXT NOT NULL CHECK (status IN ('STARTING','RECORDING','DRAINING','TRANSCRIBED','SUMMARIZING','COMPLETED','INTERRUPTED','FAILED')),
        transcription_result TEXT CHECK (transcription_result IS NULL OR transcription_result IN ('COMPLETE','PARTIAL')),
        started_at_ms INTEGER, stopped_at_ms INTEGER, stop_reason TEXT,
        config_snapshot_json TEXT NOT NULL, purge_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_meeting_per_guild ON meetings(guild_id)
        WHERE status IN (${ACTIVE});
      CREATE TABLE IF NOT EXISTS participants (
        meeting_id TEXT NOT NULL, user_id TEXT NOT NULL, display_name_snapshot TEXT NOT NULL,
        consent_status TEXT NOT NULL CHECK (consent_status IN ('PENDING','ACCEPTED','DECLINED','REVOKED')),
        consent_updated_at_ms INTEGER, first_joined_at_ms INTEGER NOT NULL, last_left_at_ms INTEGER,
        PRIMARY KEY (meeting_id,user_id), FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS participant_presence (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, user_id TEXT NOT NULL,
        joined_at_ms INTEGER NOT NULL, left_at_ms INTEGER,
        FOREIGN KEY (meeting_id,user_id) REFERENCES participants(meeting_id,user_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_presence ON participant_presence(meeting_id,user_id) WHERE left_at_ms IS NULL;
      CREATE TABLE IF NOT EXISTS utterances (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker_user_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, public_id TEXT NOT NULL, chain_id TEXT NOT NULL, chain_index INTEGER NOT NULL,
        started_offset_ms INTEGER NOT NULL, ended_offset_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('QUEUED','PROCESSING','TRANSCRIBED','IGNORED','FAILED','LOST')),
        text TEXT, language TEXT, language_probability REAL, stt_attempts INTEGER NOT NULL DEFAULT 0,
        stt_latency_ms INTEGER, error_code TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        UNIQUE(meeting_id,sequence), UNIQUE(meeting_id,public_id),
        FOREIGN KEY (meeting_id,speaker_user_id) REFERENCES participants(meeting_id,user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS utterance_time ON utterances(meeting_id,started_offset_ms,sequence);
      CREATE TABLE IF NOT EXISTS summary_runs (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PROCESSING','COMPLETED','FAILED')),
        provider TEXT NOT NULL, model TEXT NOT NULL, input_utterance_count INTEGER NOT NULL,
        transcript_hash TEXT NOT NULL, result_json TEXT, markdown TEXT, error_code TEXT, error_message TEXT,
        created_at_ms INTEGER NOT NULL, completed_at_ms INTEGER,
        UNIQUE(meeting_id,version), FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS meeting_events (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','ERROR')),
        payload_json TEXT, created_at_ms INTEGER NOT NULL,
        FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('NOTICE','TRANSCRIPT','SUMMARY','WARNING')),
        version INTEGER NOT NULL, part INTEGER NOT NULL,
        marker TEXT NOT NULL UNIQUE, message_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('PENDING','SENT')),
        UNIQUE(meeting_id,kind,version,part),
        FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
      );
    `);
  }

  close(): void { this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createMeeting(input: Pick<Meeting, 'guild_id' | 'voice_channel_id' | 'output_channel_id' | 'started_by_user_id' | 'title' | 'config_snapshot_json'>): Meeting {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO meetings VALUES (?,?,?,?,? ,?,'STARTING',NULL,NULL,NULL,NULL,?,?,?,?)`).run(
      id, input.guild_id, input.voice_channel_id, input.output_channel_id,
      input.started_by_user_id, input.title, input.config_snapshot_json,
      now + 30 * DAY_MS, now, now,
    );
    return this.getMeeting(id)!;
  }

  getMeeting(id: string): Meeting | undefined {
    return this.db.prepare('SELECT * FROM meetings WHERE id=?').get(id) as unknown as Meeting | undefined;
  }

  activeMeeting(guildId: string): Meeting | undefined {
    return this.db.prepare(`SELECT * FROM meetings WHERE guild_id=? AND status IN (${ACTIVE}) ORDER BY created_at_ms DESC LIMIT 1`).get(guildId) as unknown as Meeting | undefined;
  }

  latestMeeting(guildId: string): Meeting | undefined {
    return this.db.prepare('SELECT * FROM meetings WHERE guild_id=? ORDER BY created_at_ms DESC LIMIT 1').get(guildId) as unknown as Meeting | undefined;
  }

  setStatus(id: string, expected: MeetingStatus[], status: MeetingStatus, fields: { startedAt?: number; stoppedAt?: number; stopReason?: string; result?: 'COMPLETE' | 'PARTIAL' } = {}): Meeting {
    const current = this.getMeeting(id);
    if (!current || !expected.includes(current.status)) throw new Error(`Invalid meeting transition to ${status}`);
    const now = Date.now();
    this.db.prepare(`UPDATE meetings SET status=?, started_at_ms=COALESCE(?,started_at_ms),
      stopped_at_ms=COALESCE(?,stopped_at_ms), stop_reason=COALESCE(?,stop_reason),
      transcription_result=COALESCE(?,transcription_result), updated_at_ms=? WHERE id=?`).run(
      status, fields.startedAt ?? null, fields.stoppedAt ?? null,
      fields.stopReason ?? null, fields.result ?? null, now, id,
    );
    return this.getMeeting(id)!;
  }

  join(meetingId: string, userId: string, name: string, now = Date.now()): Participant {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO participants VALUES (?,?,?,'PENDING',NULL,?,NULL)
        ON CONFLICT(meeting_id,user_id) DO UPDATE SET last_left_at_ms=NULL`).run(meetingId, userId, name, now);
      this.db.prepare(`INSERT OR IGNORE INTO participant_presence VALUES (?,?,?,?,NULL)`).run(randomUUID(), meetingId, userId, now);
    });
    return this.getParticipant(meetingId, userId)!;
  }

  leave(meetingId: string, userId: string, now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare('UPDATE participants SET last_left_at_ms=? WHERE meeting_id=? AND user_id=?').run(now, meetingId, userId);
      this.db.prepare('UPDATE participant_presence SET left_at_ms=? WHERE meeting_id=? AND user_id=? AND left_at_ms IS NULL').run(now, meetingId, userId);
    });
  }

  closePresences(meetingId: string, now = Date.now()): void {
    this.db.prepare('UPDATE participant_presence SET left_at_ms=? WHERE meeting_id=? AND left_at_ms IS NULL').run(now, meetingId);
  }

  getParticipant(meetingId: string, userId: string): Participant | undefined {
    return this.db.prepare('SELECT * FROM participants WHERE meeting_id=? AND user_id=?').get(meetingId, userId) as unknown as Participant | undefined;
  }

  participants(meetingId: string): Participant[] {
    return this.db.prepare('SELECT * FROM participants WHERE meeting_id=? ORDER BY first_joined_at_ms').all(meetingId) as unknown as Participant[];
  }

  setConsent(meetingId: string, userId: string, status: ConsentStatus): Participant {
    const result = this.db.prepare('UPDATE participants SET consent_status=?, consent_updated_at_ms=? WHERE meeting_id=? AND user_id=?').run(status, Date.now(), meetingId, userId);
    if (!result.changes) throw new Error('Participant not found');
    return this.getParticipant(meetingId, userId)!;
  }

  createUtterance(input: Pick<Utterance, 'meeting_id' | 'speaker_user_id' | 'chain_id' | 'chain_index' | 'started_offset_ms' | 'ended_offset_ms'>): Utterance {
    return this.transaction(() => {
      const sequence = Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM utterances WHERE meeting_id=?').get(input.meeting_id) as { n: number }).n);
      const id = randomUUID();
      const publicId = `U${String(sequence).padStart(6, '0')}`;
      const now = Date.now();
      this.db.prepare(`INSERT INTO utterances
        (id,meeting_id,speaker_user_id,sequence,public_id,chain_id,chain_index,started_offset_ms,ended_offset_ms,status,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,'QUEUED',?,?)`).run(
        id, input.meeting_id, input.speaker_user_id, sequence, publicId,
        input.chain_id, input.chain_index, input.started_offset_ms, input.ended_offset_ms, now, now,
      );
      return this.getUtterance(id)!;
    });
  }

  getUtterance(id: string): Utterance | undefined {
    return this.db.prepare('SELECT * FROM utterances WHERE id=?').get(id) as unknown as Utterance | undefined;
  }

  utterances(meetingId: string): Utterance[] {
    return this.db.prepare('SELECT * FROM utterances WHERE meeting_id=? ORDER BY started_offset_ms,sequence').all(meetingId) as unknown as Utterance[];
  }

  setUtterance(id: string, status: UtteranceStatus, fields: { text?: string; language?: string; probability?: number; latencyMs?: number; errorCode?: string; attempts?: number } = {}): void {
    this.db.prepare(`UPDATE utterances SET status=?,text=COALESCE(?,text),language=COALESCE(?,language),
      language_probability=COALESCE(?,language_probability),stt_latency_ms=COALESCE(?,stt_latency_ms),
      error_code=?,stt_attempts=COALESCE(?,stt_attempts),updated_at_ms=? WHERE id=?`).run(
      status, fields.text ?? null, fields.language ?? null, fields.probability ?? null,
      fields.latencyMs ?? null, fields.errorCode ?? null, fields.attempts ?? null, Date.now(), id,
    );
  }

  finalizeTranscription(meetingId: string): 'COMPLETE' | 'PARTIAL' {
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM utterances WHERE meeting_id=? AND status IN ('QUEUED','PROCESSING')").get(meetingId) as { n: number };
    if (pending.n) throw new Error('STT queue has not drained');
    const gaps = this.db.prepare("SELECT COUNT(*) AS n FROM utterances WHERE meeting_id=? AND status IN ('FAILED','LOST')").get(meetingId) as { n: number };
    const result = gaps.n ? 'PARTIAL' : 'COMPLETE';
    this.setStatus(meetingId, ['DRAINING', 'INTERRUPTED'], 'TRANSCRIBED', { result });
    return result;
  }

  recover(): Meeting[] {
    return this.transaction(() => {
      const meetings = this.db.prepare(`SELECT * FROM meetings WHERE status IN (${ACTIVE})`).all() as unknown as Meeting[];
      const now = Date.now();
      for (const meeting of meetings) {
        this.db.prepare("UPDATE utterances SET status='LOST',error_code='BOT_RESTART',updated_at_ms=? WHERE meeting_id=? AND status IN ('QUEUED','PROCESSING')").run(now, meeting.id);
        this.db.prepare("UPDATE meetings SET status='INTERRUPTED',stopped_at_ms=COALESCE(stopped_at_ms,?),stop_reason='BOT_RESTART',updated_at_ms=? WHERE id=?").run(now, now, meeting.id);
        this.closePresences(meeting.id, now);
        this.event(meeting.id, 'BOT_RECOVERED', 'WARNING');
      }
      this.db.prepare("UPDATE summary_runs SET status='FAILED',error_code='BOT_RESTART',completed_at_ms=? WHERE status='PROCESSING'").run(now);
      return meetings;
    });
  }

  event(meetingId: string, type: string, severity: 'INFO' | 'WARNING' | 'ERROR', payload?: object): void {
    this.db.prepare('INSERT INTO meeting_events VALUES (?,?,?,?,?,?)').run(randomUUID(), meetingId, type, severity, payload ? JSON.stringify(payload) : null, Date.now());
  }

  beginSummary(meetingId: string, model: string, inputCount: number, hash: string): { id: string; version: number } {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS n FROM summary_runs WHERE meeting_id=?').get(meetingId) as { n: number };
      const id = randomUUID();
      this.db.prepare(`INSERT INTO summary_runs
        (id,meeting_id,version,status,provider,model,input_utterance_count,transcript_hash,created_at_ms)
        VALUES (?,?,?,'PROCESSING','ollama',?,?,?,?)`).run(id, meetingId, row.n, model, inputCount, hash, Date.now());
      return { id, version: row.n };
    });
  }

  finishSummary(id: string, json: string, markdown: string): void {
    this.db.prepare("UPDATE summary_runs SET status='COMPLETED',result_json=?,markdown=?,completed_at_ms=? WHERE id=?").run(json, markdown, Date.now(), id);
  }

  failSummary(id: string, code: string): void {
    this.db.prepare("UPDATE summary_runs SET status='FAILED',error_code=?,completed_at_ms=? WHERE id=?").run(code, Date.now(), id);
  }

  delivery(meetingId: string, kind: Delivery['kind'], version: number, part: number): Delivery {
    const marker = `CS:${meetingId}:${kind}:${version}:${part}`;
    this.db.prepare("INSERT OR IGNORE INTO deliveries VALUES (?,?,?,?,?,?,NULL,'PENDING')").run(randomUUID(), meetingId, kind, version, part, marker);
    return this.db.prepare('SELECT * FROM deliveries WHERE meeting_id=? AND kind=? AND version=? AND part=?').get(meetingId, kind, version, part) as unknown as Delivery;
  }

  delivered(id: string, messageId: string): void {
    this.db.prepare("UPDATE deliveries SET status='SENT',message_id=? WHERE id=?").run(messageId, id);
  }

  deliveries(meetingId: string): Delivery[] {
    return this.db.prepare('SELECT * FROM deliveries WHERE meeting_id=? ORDER BY rowid').all(meetingId) as unknown as Delivery[];
  }

  expired(now = Date.now()): Meeting[] {
    return this.db.prepare("SELECT * FROM meetings WHERE purge_at_ms<=? AND status NOT IN ('STARTING','RECORDING','DRAINING','SUMMARIZING')").all(now) as unknown as Meeting[];
  }

  recentFinished(now = Date.now()): Meeting[] {
    return this.db.prepare("SELECT * FROM meetings WHERE purge_at_ms>? AND status IN ('TRANSCRIBED','COMPLETED') ORDER BY created_at_ms").all(now) as unknown as Meeting[];
  }

  completedSummaries(meetingId: string): { version: number; markdown: string }[] {
    return this.db.prepare("SELECT version,markdown FROM summary_runs WHERE meeting_id=? AND status='COMPLETED' ORDER BY version").all(meetingId) as { version: number; markdown: string }[];
  }

  deleteMeeting(id: string): void {
    this.db.prepare('DELETE FROM meetings WHERE id=?').run(id);
  }
}
