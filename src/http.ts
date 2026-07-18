import type { DirectusClient } from "./types.js";

// Thin fetch-based Directus REST client. No id resolution — that's per-reconciler.
// GET returns null on 404 OR 403 (Directus hides existence via permission).
// 503 responses (Directus "Under pressure" load-shed) are retried with
// exponential backoff before surfacing as errors.

export interface DirectusHttpConfig {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
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
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const r = await fetchImpl(url, init);
        if (!RETRY_STATUSES.has(r.status)) return r;
        if (attempt === MAX_RETRIES) return r;
        // Drain body so the connection is reusable.
        try { await r.text(); } catch { /* ignore */ }
      } catch (e) {
        // Network error (ECONNRESET/EAI_AGAIN) — retry the same window.
        lastErr = e;
        if (attempt === MAX_RETRIES) throw e;
      }
      await sleep(backoffMs(attempt));
    }
    // Unreachable — the loop returns or throws.
    throw lastErr instanceof Error ? lastErr : new Error("fetch retry exhausted");
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
