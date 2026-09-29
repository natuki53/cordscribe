export interface Config {
  discordToken: string;
  applicationId: string;
  guildIds: string[];
  dbPath: string;
  sttBaseUrl: string;
  summaryMode: 'off' | 'ollama';
  ollamaBaseUrl: string;
  ollamaModel: string;
  timeZone: string;
  transcriptionDebugLog: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const url = (key: string, fallback: string): string => {
    const value = env[key] ?? fallback;
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:') throw new Error(`${key} must use local HTTP`);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      throw new Error(`${key} must be loopback`);
    }
    return parsed.origin;
  };
  const timeZone = env.TZ || 'Asia/Tokyo';
  new Intl.DateTimeFormat('ja-JP', { timeZone });
  const summaryMode = env.SUMMARY_MODE?.trim() || 'off';
  if (summaryMode !== 'off' && summaryMode !== 'ollama') throw new Error('SUMMARY_MODE must be off or ollama');
  const guildIds = [...new Set((env.DISCORD_GUILD_IDS?.trim() || required('DISCORD_GUILD_ID'))
    .split(',').map((id) => id.trim()).filter(Boolean))];
  if (!guildIds.length) throw new Error('Missing DISCORD_GUILD_IDS');
  return {
    discordToken: required('DISCORD_TOKEN'),
    applicationId: required('DISCORD_APPLICATION_ID'),
    guildIds,
    dbPath: env.DB_PATH || '/var/lib/cordscribe/cordscribe.sqlite',
    sttBaseUrl: url('STT_BASE_URL', 'http://127.0.0.1:8765'),
    summaryMode,
    ollamaBaseUrl: summaryMode === 'ollama' ? url('OLLAMA_BASE_URL', 'http://127.0.0.1:11434') : '',
    ollamaModel: env.OLLAMA_MODEL || 'qwen3.5:9b',
    timeZone,
    transcriptionDebugLog: env.TRANSCRIPTION_DEBUG_LOG?.trim().toLowerCase() === 'true',
  };
}
