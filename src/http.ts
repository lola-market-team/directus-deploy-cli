import type { DirectusClient } from "./types.js";

// Thin fetch-based Directus REST client. No id resolution — that's per-reconciler.
// GET returns null on 404 OR 403 (Directus hides existence via permission).
// 503 responses (Directus "Under pressure" load-shed) are retried with
// exponential backoff before surfacing as errors.

export interface DirectusHttpConfig {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  // Per-attempt deadline. A request that produces no response within this
  // window is aborted and treated as a transient network error (retryable).
  // 0 disables. Default REQUEST_TIMEOUT_MS.
  timeoutMs?: number;
  // Ceiling on the whole retry sequence for one logical request. Without it,
  // a flapping target costs MAX_RETRIES × (timeoutMs + backoff) — minutes per
  // call, silently, which is what made `overview` look hung (#39).
  // 0 disables. Default MAX_ELAPSED_MS.
  maxElapsedMs?: number;
}

export interface DirectusError extends Error {
  status: number;
  body: string;
}

function toErr(url: string, status: number, body: string): DirectusError {
  const e = new Error(`${status} ${url} :: ${body}`) as DirectusError;
  e.status = status;
  e.body = body;
  return e;
}

// Small VMs (test.lola.market) 503 with `Service "api" is unavailable. Under
// pressure.` during bulk apply. Retry with exponential backoff — the caller
// has no way to distinguish this from a real outage.
const RETRY_STATUSES = new Set([503, 502, 504]);
const MAX_RETRIES = 6;

// Defaults chosen so a single logical request can never exceed ~2.5 min:
// 6 retries × 30s attempts would be 3min of dead air on its own, so the
// elapsed ceiling — not the retry count — is what actually bounds it.
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_ELAPSED_MS = 120_000;

export interface TimeoutError extends Error {
  timeout: true;
}

export function isTimeoutError(e: unknown): e is TimeoutError {
  return Boolean(e) && (e as TimeoutError).timeout === true;
}

function toTimeoutErr(url: string, ms: number): TimeoutError {
  const e = new Error(`timeout after ${ms}ms :: ${url}`) as TimeoutError;
  e.timeout = true;
  return e;
}

function backoffMs(attempt: number): number {
  // 500, 1000, 2000, 4000, 8000, 16000 ms — cumulative ~31s
  return 500 * Math.pow(2, attempt);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createDirectusClient(cfg: DirectusHttpConfig): DirectusClient {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const timeoutMs = cfg.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxElapsedMs = cfg.maxElapsedMs ?? MAX_ELAPSED_MS;
  const headers: HeadersInit = {
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  async function readJson(r: Response): Promise<Record<string, unknown>> {
    if (r.status === 204) return {};
    const text = await r.text();
    if (!text) return {};
    try {
      const j = JSON.parse(text);
      return (j && typeof j === "object" ? (j as Record<string, unknown>) : {}) ?? {};
    } catch {
      throw toErr(r.url, r.status, text);
    }
  }

  async function fetchWithRetry(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    let lastErr: unknown = undefined;
    const startedAt = Date.now();
    const outOfTime = (): boolean =>
      maxElapsedMs > 0 && Date.now() - startedAt >= maxElapsedMs;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Abort the attempt rather than waiting on the OS. Without this a
        // half-open connection parks forever and the caller has no signal.
        const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
        const r = await fetchImpl(url, signal ? { ...init, signal } : init);
        if (!RETRY_STATUSES.has(r.status)) return r;
        if (attempt === MAX_RETRIES) return r;
        // Drain body so the connection is reusable.
        try { await r.text(); } catch { /* ignore */ }
        lastErr = toErr(url, r.status, "under pressure");
      } catch (e) {
        // Network error (ECONNRESET/EAI_AGAIN) or our own abort — both are
        // transient, so both retry inside the elapsed ceiling.
        const isAbort = e instanceof Error && e.name === "TimeoutError";
        lastErr = isAbort ? toTimeoutErr(url, timeoutMs) : e;
        if (attempt === MAX_RETRIES) throw lastErr;
      }
      if (outOfTime()) break;
      await sleep(backoffMs(attempt));
      if (outOfTime()) break;
    }
    if (lastErr) throw lastErr;
    throw new Error("fetch retry exhausted");
  }

  return {
    async get(path) {
      const r = await fetchWithRetry(base + path, { headers });
      if (r.status === 404 || r.status === 403) return null;
      if (!r.ok) throw toErr(r.url, r.status, await r.text());
      const j = await readJson(r);
      const data = (j as { data?: unknown }).data;
      if (Array.isArray(data)) return data as Record<string, unknown>[];
      return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    },
    async post(path, body) {
      const r = await fetchWithRetry(base + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
      });
      if (!r.ok) throw toErr(r.url, r.status, await r.text());
      const j = await readJson(r);
      return ((j as { data?: unknown }).data as Record<string, unknown>) ?? {};
    },
    async patch(path, body) {
      const r = await fetchWithRetry(base + path, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body ?? {}),
      });
      if (!r.ok) throw toErr(r.url, r.status, await r.text());
      const j = await readJson(r);
      return ((j as { data?: unknown }).data as Record<string, unknown>) ?? {};
    },
    async delete(path) {
      const r = await fetchWithRetry(base + path, { method: "DELETE", headers });
      if (r.status === 404) return; // idempotent
      if (!r.ok) throw toErr(r.url, r.status, await r.text());
    },
    async postRaw(path, body) {
      const r = await fetchWithRetry(base + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
      });
      if (!r.ok) throw toErr(r.url, r.status, await r.text());
      return await readJson(r);
    },
  };
}
