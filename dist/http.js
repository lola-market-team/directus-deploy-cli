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
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const r = await fetchImpl(url, init);
                if (!RETRY_STATUSES.has(r.status))
                    return r;
                if (attempt === MAX_RETRIES)
                    return r;
                // Drain body so the connection is reusable.
                try {
                    await r.text();
                }
                catch { /* ignore */ }
            }
            catch (e) {
                // Network error (ECONNRESET/EAI_AGAIN) — retry the same window.
                lastErr = e;
                if (attempt === MAX_RETRIES)
                    throw e;
            }
            await sleep(backoffMs(attempt));
        }
        // Unreachable — the loop returns or throws.
        throw lastErr instanceof Error ? lastErr : new Error("fetch retry exhausted");
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