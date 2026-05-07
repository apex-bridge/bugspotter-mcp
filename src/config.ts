import 'dotenv/config';

export interface Config {
  baseUrl: string;
  apiKey: string;
  defaultProject: string | undefined;
  logDir: string;
  timeoutMs: number;
  retryAttempts: number;
}

export function loadConfig(): Config {
  const baseUrl = process.env.BUGSPOTTER_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.BUGSPOTTER_API_KEY;
  if (!baseUrl) throw new Error('BUGSPOTTER_BASE_URL is required');
  if (!apiKey) throw new Error('BUGSPOTTER_API_KEY is required');
  if (!apiKey.startsWith('bgs_')) {
    throw new Error('BUGSPOTTER_API_KEY must start with "bgs_"');
  }
  return {
    baseUrl,
    apiKey,
    defaultProject: process.env.BUGSPOTTER_DEFAULT_PROJECT || undefined,
    logDir: process.env.LOG_DIR || './logs',
    timeoutMs: 10_000,
    retryAttempts: 3,
  };
}
