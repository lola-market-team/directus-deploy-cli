import { loadTargets } from "./targets.js";
import { mintIdToken } from "./gcloud.js";
// Re-export for existing importers/tests.
export { buildIdTokenAssertion } from "./gcloud.js";
// Pure resolver for the invoker SA key — also used by `push --publish` for
// GCS uploads when gsutil isn't available. Exported for tests.
export function resolveInvokerKey(name, target, env) {
    const invokerEnv = target.control_invoker_key_env ?? `DIRECTUS_${name.toUpperCase()}_INVOKER_KEY_B64`;
    const rawKey = env[invokerEnv];
    if (!rawKey)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(rawKey, "base64").toString("utf8"));
        if (!parsed.client_email || !parsed.private_key)
            throw new Error("missing fields");
        return { client_email: parsed.client_email, private_key: parsed.private_key };
    }
    catch {
        throw new Error(`target '${name}': $${invokerEnv} is not a base64-encoded service-account JSON key`);
    }
}
// Pure resolver — exported for tests.
export function resolveVmControl(name, target, env) {
    if (!target.control_url) {
        throw new Error(`target '${name}' has no control_url in the targets file — deploy cloudfunctions/vm-control for it first`);
    }
    const tokenEnv = target.control_token_env ?? `DIRECTUS_${name.toUpperCase()}_CONTROL_TOKEN`;
    const token = env[tokenEnv]; // optional — IAM-gated functions need no shared token
    const keyEnv = target.control_key_env ?? `DIRECTUS_${name.toUpperCase()}_CONTROL_KEY`;
    const apiKey = env[keyEnv]; // API Gateway key — preferred transport when set
    const invokerKey = resolveInvokerKey(name, target, env);
    if (!token && !invokerKey && !apiKey) {
        throw new Error(`target '${name}': no control credentials — set $${keyEnv} (API Gateway key), $${tokenEnv} (shared token), or $${target.control_invoker_key_env ?? `DIRECTUS_${name.toUpperCase()}_INVOKER_KEY_B64`} (invoker SA key)`);
    }
    return {
        controlUrl: target.control_url.replace(/\/+$/, ""),
        token,
        apiKey,
        healthUrl: `${target.base_url.replace(/\/+$/, "")}/server/health`,
        invokerKey,
    };
}
export async function callControl(ctl, action, params = {}) {
    const headers = {};
    if (ctl.token)
        headers["X-Control-Token"] = ctl.token;
    if (ctl.apiKey) {
        headers["x-api-key"] = ctl.apiKey; // gateway authenticates to the backend itself
    }
    else if (ctl.invokerKey) {
        headers.Authorization = `Bearer ${await mintIdToken(ctl.invokerKey, ctl.controlUrl)}`;
    }
    const qs = new URLSearchParams({ action, ...params });
    const r = await fetch(`${ctl.controlUrl}?${qs.toString()}`, { method: "POST", headers });
    const body = (await r.json().catch(() => ({})));
    if (!r.ok) {
        const hint = r.status === 401 || r.status === 403
            ? ctl.invokerKey
                ? " (invoker SA lacks run.invoker on the service, or the shared token mismatches)"
                : " (service not publicly invokable? set DIRECTUS_<TARGET>_INVOKER_KEY_B64 with an invoker SA key)"
            : "";
        throw new Error(`vm-control ${action} failed: HTTP ${r.status}${hint} ${JSON.stringify(body)}`);
    }
    return body;
}
export async function isHealthy(healthUrl) {
    try {
        const r = await fetch(healthUrl, { signal: AbortSignal.timeout(8000) });
        return r.ok;
    }
    catch {
        return false;
    }
}
export async function waitHealthy(healthUrl, timeoutMs, intervalMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, intervalMs));
        if (await isHealthy(healthUrl))
            return true;
    }
    return false;
}
export async function runVm(input) {
    const cfg = await loadTargets(input.targetsFile);
    const t = cfg.targets[input.target];
    if (!t) {
        throw new Error(`unknown target '${input.target}' — known: ${Object.keys(cfg.targets).join(", ") || "(none)"}`);
    }
    const ctl = resolveVmControl(input.target, t, process.env);
    const out = (o, human) => {
        process.stdout.write(input.json ? JSON.stringify(o, null, 2) + "\n" : human + "\n");
    };
    if (input.action === "start") {
        if (await isHealthy(ctl.healthUrl)) {
            out({ target: input.target, healthy: true, operation: "no-op" }, `${input.target}: already up`);
            return 0;
        }
        const r = await callControl(ctl, "start");
        out(r, `${input.target}: ${String(r.operation ?? "start dispatched")} (was ${String(r.statusBefore)}) — waiting for health…`);
        const ok = await waitHealthy(ctl.healthUrl, input.waitTimeoutMs);
        out({ target: input.target, healthy: ok }, ok ? `${input.target}: up` : `${input.target}: still not healthy after ${Math.round(input.waitTimeoutMs / 1000)}s`);
        return ok ? 0 : 1;
    }
    if (input.action === "stop") {
        const r = await callControl(ctl, "stop");
        out(r, `${input.target}: ${String(r.operation ?? "stop dispatched")} (was ${String(r.statusBefore)})`);
        return 0;
    }
    const r = await callControl(ctl, "status");
    const healthy = await isHealthy(ctl.healthUrl);
    out({ ...r, healthy }, `${input.target}: instance ${String(r.statusBefore)}, directus ${healthy ? "responding" : "NOT responding"}`);
    return 0;
}
//# sourceMappingURL=vm.js.map