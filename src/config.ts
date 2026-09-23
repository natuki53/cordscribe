export interface Config {
  discordToken: string;
  applicationId: string;
  guildId: string;
  operatorRoleId: string;
  meetingChannelId: string;
  dbPath: string;
  sttBaseUrl: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  timeZone: string;
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
  return {
    discordToken: required('DISCORD_TOKEN'),
    applicationId: required('DISCORD_APPLICATION_ID'),
    guildId: required('DISCORD_GUILD_ID'),
    operatorRoleId: required('OPERATOR_ROLE_ID'),
    meetingChannelId: required('MEETING_CHANNEL_ID'),
    dbPath: env.DB_PATH || '/var/lib/cordscribe/cordscribe.sqlite',
    sttBaseUrl: url('STT_BASE_URL', 'http://127.0.0.1:8765'),
    ollamaBaseUrl: url('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
    ollamaModel: env.OLLAMA_MODEL || 'qwen3.5:9b',
    timeZone,
  };
}
