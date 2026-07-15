import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { splitSql } from "../sql.js";
async function rawQuery(client, sql) {
    try {
        const r = (await client.postRaw("/raw-query/execute", { query: sql }));
        if (r === null || typeof r !== "object")
            return null;
        return r;
    }
    catch (e) {
        const msg = e.message;
        if (msg.includes(" 404 "))
            return null;
        throw e;
    }
}
function stripLeadingComments(s) {
    let i = 0;
    while (true) {
        while (i < s.length && /\s/.test(s[i]))
            i += 1;
        if (s[i] === "-" && s[i + 1] === "-") {
            const nl = s.indexOf("\n", i);
            if (nl === -1)
                return "";
            i = nl + 1;
            continue;
        }
        if (s[i] === "/" && s[i + 1] === "*") {
            const end = s.indexOf("*/", i);
            if (end === -1)
                return "";
            i = end + 2;
            continue;
        }
        break;
    }
    return s.slice(i);
}
export async function reconcileMigrations(input) {
    const results = [];
    const probe = await rawQuery(input.client, "SELECT 1 AS ok");
    if (probe === null) {
        results.push({
            kind: "migrations",
            label: "migrations",
            action: "skipped",
            reason: "/raw-query/execute not available on this target",
        });
        return results;
    }
    let entries;
    try {
        entries = await readdir(input.migrationsDir);
    }
    catch {
        return results;
    }
    const files = entries.filter((f) => extname(f) === ".sql" && !f.startsWith("_")).sort();
    if (files.length === 0)
        return results;
    for (const filename of files) {
        const label = `migrations/${filename}`;
        const full = join(input.migrationsDir, filename);
        let raw;
        try {
            raw = await readFile(full, "utf8");
        }
        catch (e) {
            results.push({ kind: "migrations", label, action: "failed", reason: e.message });
            continue;
        }
        const statements = splitSql(raw).filter((s) => {
            const stripped = stripLeadingComments(s.trim()).trim();
            return stripped.length > 0 && stripped !== ";";
        });
        if (statements.length === 0) {
            results.push({ kind: "migrations", label, action: "skipped", reason: "no executable statements" });
            continue;
        }
        if (input.opts.dryRun) {
            results.push({
                kind: "migrations",
                label,
                action: "created",
                reason: `${statements.length} statement(s) would apply`,
            });
            continue;
        }
        let failedReason = null;
        for (const stmt of statements) {
            const r = await rawQuery(input.client, stmt);
            const inner = r?.results?.[0];
            if (!r?.success || !inner?.success) {
                failedReason = inner?.error ?? "unknown error";
                break;
            }
        }
        if (failedReason) {
            results.push({ kind: "migrations", label, action: "failed", reason: failedReason });
            continue;
        }
        results.push({ kind: "migrations", label, action: "created" });
    }
    return results;
}
//# sourceMappingURL=migrations.js.map