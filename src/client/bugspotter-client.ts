import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';
import type { Config } from '../config.js';
import { UpstreamError } from '../types.js';

export class BugSpotterClient {
  private http: AxiosInstance;

  constructor(private config: Config) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      headers: {
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    opts: { params?: Record<string, unknown>; body?: unknown } = {}
  ): Promise<T> {
    const upstreamUrl = `${method} ${path}`;
    const cfg: AxiosRequestConfig = {
      method,
      url: path,
      params: opts.params,
      data: opts.body,
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const res = await this.http.request<T>(cfg);
        return res.data;
      } catch (err) {
        lastError = err;
        const classified = classify(err, upstreamUrl);
        // Only retry on 5xx, timeout, or network — never 4xx.
        if (classified.errorClass === 'upstream_4xx') throw classified;
        if (attempt < this.config.retryAttempts) {
          await sleep(2 ** (attempt - 1) * 250);
          continue;
        }
        throw classified;
      }
    }
    throw lastError;
  }
}

function classify(err: unknown, upstreamUrl: string): UpstreamError {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError<{ message?: string; error?: string }>;
    if (ax.code === 'ECONNABORTED' || ax.code === 'ETIMEDOUT') {
      return new UpstreamError('Upstream request timed out', null, 'timeout', upstreamUrl);
    }
    const status = ax.response?.status ?? null;
    const upstreamMsg =
      ax.response?.data?.message || ax.response?.data?.error || ax.message;
    if (status && status >= 400 && status < 500) {
      return new UpstreamError(`BugSpotter ${status}: ${upstreamMsg}`, status, 'upstream_4xx', upstreamUrl);
    }
    if (status && status >= 500) {
      return new UpstreamError(`BugSpotter ${status}: ${upstreamMsg}`, status, 'upstream_5xx', upstreamUrl);
    }
    return new UpstreamError(`Network error: ${ax.message}`, null, 'network', upstreamUrl);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new UpstreamError(`Unexpected error: ${msg}`, null, 'network', upstreamUrl);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
