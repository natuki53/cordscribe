export type MeetingStatus = 'STARTING' | 'RECORDING' | 'DRAINING' | 'TRANSCRIBED' | 'SUMMARIZING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED';
export type ConsentStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED';
export type UtteranceStatus = 'QUEUED' | 'PROCESSING' | 'TRANSCRIBED' | 'IGNORED' | 'FAILED' | 'LOST';

export interface Meeting {
  id: string;
  guild_id: string;
  voice_channel_id: string;
  output_channel_id: string;
  started_by_user_id: string;
  title: string | null;
  status: MeetingStatus;
  transcription_result: 'COMPLETE' | 'PARTIAL' | null;
  started_at_ms: number | null;
  stopped_at_ms: number | null;
  stop_reason: string | null;
  config_snapshot_json: string;
  purge_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface Participant {
  meeting_id: string;
  user_id: string;
  display_name_snapshot: string;
  consent_status: ConsentStatus;
  consent_updated_at_ms: number | null;
  first_joined_at_ms: number;
  last_left_at_ms: number | null;
}

export interface Utterance {
  id: string;
  meeting_id: string;
  speaker_user_id: string;
  sequence: number;
  public_id: string;
  chain_id: string;
  chain_index: number;
  started_offset_ms: number;
  ended_offset_ms: number;
  status: UtteranceStatus;
  text: string | null;
  language: string | null;
  language_probability: number | null;
  stt_attempts: number;
  stt_latency_ms: number | null;
  error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface SummaryItem {
  text: string;
  evidenceUtteranceIds: string[];
}

export interface MeetingSummary {
  schemaVersion: '1';
  title: string;
  overview: string;
  topics: { title: string; summary: string; evidenceUtteranceIds: string[] }[];
  decisions: SummaryItem[];
  actionItems: {
    task: string;
    assigneeUserId: string | null;
    assigneeDisplayName: string | null;
    dueDate: string | null;
    dueText: string | null;
    evidenceUtteranceIds: string[];
  }[];
  openQuestions: SummaryItem[];
}
