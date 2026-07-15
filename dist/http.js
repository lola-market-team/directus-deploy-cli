function toErr(url, status, body) {
    const e = new Error(`${status} ${url} :: ${body}`);
    e.status = status;
    e.body = body;
    return e;
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
    return {
        async get(path) {
            const r = await fetchImpl(base + path, { headers });
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
            const r = await fetchImpl(base + path, {
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
            const r = await fetchImpl(base + path, {
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
            const r = await fetchImpl(base + path, {
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