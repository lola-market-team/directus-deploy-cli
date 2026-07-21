import { readFile } from "node:fs/promises";
export async function loadTargets(path) {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.targets || typeof parsed.targets !== "object") {
        throw new Error(`invalid targets file at ${path}: missing 'targets' object`);
    }
    return parsed;
}
//# sourceMappingURL=targets.js.map