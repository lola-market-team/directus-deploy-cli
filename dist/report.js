export function formatHuman(report) {
    const lines = [];
    for (const r of report.results) {
        if (r.action === "unchanged")
            continue;
        const suffix = r.reason ? ` — ${r.reason}` : "";
        lines.push(`  ${r.action.toUpperCase().padEnd(9)} ${r.label}${suffix}`);
    }
    const { created, updated, unchanged, skipped, failed } = report.counts;
    lines.push(`\n${created} created, ${updated} updated, ${unchanged} unchanged, ${skipped} skipped, ${failed} failed  (target: ${report.target})`);
    return lines.join("\n");
}
export function formatJson(report) {
    return JSON.stringify(report, null, 2);
}
//# sourceMappingURL=report.js.map