import { createSign } from "node:crypto";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
function b64url(data) {
    return Buffer.from(data).toString("base64url");
}
function signAssertion(key, claims) {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify(claims));
    const unsigned = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
    return `${unsigned}.${b64url(signature)}`;
}
// Pure builders — exported for tests.
export function buildIdTokenAssertion(key, audience, nowSeconds) {
    return signAssertion(key, {
        iss: key.client_email,
        sub: key.client_email,
        aud: TOKEN_ENDPOINT,
        target_audience: audience,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
    });
}
export function buildAccessTokenAssertion(key, scope, nowSeconds) {
    return signAssertion(key, {
        iss: key.client_email,
        aud: TOKEN_ENDPOINT,
        scope,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
    });
}
async function exchange(assertion, want, who) {
    const r = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
        }),
    });
    const body = (await r.json().catch(() => ({})));
    const token = body[want];
    if (!r.ok || !token) {
        throw new Error(`could not mint ${want} for ${who}: ${body.error_description ?? `HTTP ${r.status}`}`);
    }
    return token;
}
export async function mintIdToken(key, audience) {
    return exchange(buildIdTokenAssertion(key, audience, Math.floor(Date.now() / 1000)), "id_token", key.client_email);
}
const GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
export async function mintGcsToken(key) {
    return exchange(buildAccessTokenAssertion(key, GCS_SCOPE, Math.floor(Date.now() / 1000)), "access_token", key.client_email);
}
// -------------------- GCS REST --------------------
// gs://bucket/some/prefix → { bucket, prefix } (prefix without trailing slash)
export function parseGsUri(uri) {
    const m = uri.match(/^gs:\/\/([^/]+)\/?(.*?)\/?$/);
    if (!m)
        throw new Error(`not a gs:// URI: ${uri}`);
    return { bucket: m[1], prefix: m[2] ?? "" };
}
export async function gcsObjectExists(bucket, object, token) {
    const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404)
        return false;
    if (!r.ok)
        throw new Error(`GCS stat ${bucket}/${object} failed: HTTP ${r.status}`);
    return true;
}
export async function gcsDownload(bucket, object, token) {
    const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404)
        return null;
    if (!r.ok)
        throw new Error(`GCS download ${bucket}/${object} failed: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
}
export async function gcsUpload(bucket, object, data, token, contentType = "application/octet-stream") {
    const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
        body: new Uint8Array(data),
    });
    if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`GCS upload ${bucket}/${object} failed: HTTP ${r.status} ${body.slice(0, 200)}`);
    }
}
//# sourceMappingURL=gcloud.js.map