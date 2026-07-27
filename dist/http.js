function toErr(url, status, body) {
    const e = new Error(`${status} ${url} :: ${body}`);
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
export function isTimeoutError(e) {
    return Boolean(e) && e.timeout === true;
}
function toTimeoutErr(url, ms, method = "GET") {
    const e = new Error(`timeout after ${ms}ms :: ${method} ${url}`);
    e.timeout = true;
    return e;
}
function backoffMs(attempt) {
    // 500, 1000, 2000, 4000, 8000, 16000 ms — cumulative ~31s
    return 500 * Math.pow(2, attempt);
}
async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export function createDirectusClient(cfg) {
    const base = cfg.baseUrl.replace(/\/+$/, "");
    const fetchImpl = cfg.fetch ?? globalThis.fetch;
    const timeoutMs = cfg.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const maxElapsedMs = cfg.maxElapsedMs ?? MAX_ELAPSED_MS;
    const headers = {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
    };
    async function readJson(r) {
        if (r.status === 204)
            return {};
        const text = await r.text();
        if (!text)
            return {};
        try {
            const j = JSON.parse(text);
            return (j && typeof j === "object" ? j : {}) ?? {};
        }
        catch {
            throw toErr(r.url, r.status, text);
        }
    }
    async function fetchWithRetry(url, init) {
        let lastErr = undefined;
        const startedAt = Date.now();
        const outOfTime = () => maxElapsedMs > 0 && Date.now() - startedAt >= maxElapsedMs;
        // A timeout is an abort on OUR side: the request may well have reached the
        // server and committed. Replaying that is only safe when the method is
        // idempotent, so a timed-out write surfaces immediately instead of
        // retrying and risking a duplicate row.
        const method = (init?.method ?? "GET").toUpperCase();
        const replayableOnTimeout = method === "GET" || method === "HEAD";
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Abort the attempt rather than waiting on the OS. Without this a
                // half-open connection parks forever and the caller has no signal.
                const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
                const r = await fetchImpl(url, signal ? { ...init, signal } : init);
                if (!RETRY_STATUSES.has(r.status))
                    return r;
                if (attempt === MAX_RETRIES)
                    return r;
                // Drain body so the connection is reusable — and keep it, so an
                // exhausted retry sequence reports what the server actually said.
                let body = "";
                try {
                    body = await r.text();
                }
                catch { /* ignore */ }
                lastErr = toErr(url, r.status, body || "under pressure");
            }
            catch (e) {
                // A 503 means the server shed the request without processing it, so
                // retrying any method is safe (handled above). Here we are dealing
                // with our own abort, or a network error.
                const isAbort = e instanceof Error && e.name === "TimeoutError";
                lastErr = isAbort ? toTimeoutErr(url, timeoutMs, method) : e;
                if (isAbort && !replayableOnTimeout)
                    throw lastErr;
                if (attempt === MAX_RETRIES)
                    throw lastErr;
            }
            if (outOfTime())
                break;
            await sleep(backoffMs(attempt));
            if (outOfTime())
                break;
        }
        if (lastErr)
            throw lastErr;
        throw new Error("fetch retry exhausted");
    }
    return {
        async get(path) {
            const r = await fetchWithRetry(base + path, { headers });
            if (r.status === 404 || r.status === 403)
                return null;
            if (!r.ok)
                throw toErr(r.url, r.status, await r.text());
            const j = await readJson(r);
            const data = j.data;
            if (Array.isArray(data))
                return data;
            return data && typeof data === "object" ? data : null;
        },
        async post(path, body) {
            const r = await fetchWithRetry(base + path, {
                method: "POST",
                headers,
                body: JSON.stringify(body ?? {}),
            });
            if (!r.ok)
                throw toErr(r.url, r.status, await r.text());
            const j = await readJson(r);
            return j.data ?? {};
        },
        async patch(path, body) {
            const r = await fetchWithRetry(base + path, {
                method: "PATCH",
                headers,
                body: JSON.stringify(body ?? {}),
            });
            if (!r.ok)
                throw toErr(r.url, r.status, await r.text());
            const j = await readJson(r);
            return j.data ?? {};
        },
        async delete(path) {
            const r = await fetchWithRetry(base + path, { method: "DELETE", headers });
            if (r.status === 404)
                return; // idempotent
            if (!r.ok)
                throw toErr(r.url, r.status, await r.text());
        },
        async postRaw(path, body) {
            const r = await fetchWithRetry(base + path, {
                method: "POST",
                headers,
                body: JSON.stringify(body ?? {}),
            });
            if (!r.ok)
                throw toErr(r.url, r.status, await r.text());
            return await readJson(r);
        },
    };
}
//# sourceMappingURL=http.js.map