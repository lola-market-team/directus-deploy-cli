import { readFile } from "node:fs/promises";
// Admin token for a target, by convention: token_env field, else
// DIRECTUS_<UPPER>_TOKEN. Pure — exported for tests.
export function resolveAdminToken(name, target, env) {
    const tokenEnv = target.token_env ?? `DIRECTUS_${name.toUpperCase()}_TOKEN`;
    const token = env[tokenEnv];
    if (!token)
        throw new Error(`target '${name}': $${tokenEnv} is not set in env`);
    return token;
}
export async function loadTargets(path) {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.targets || typeof parsed.targets !== "object") {
        throw new Error(`invalid targets file at ${path}: missing 'targets' object`);
    }
    return parsed;
}
//# sourceMappingURL=targets.js.map