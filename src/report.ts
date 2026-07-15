import type { RunReport } from "./types.js";

export function formatHuman(report: RunReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    if (r.action === "unchanged") continue;
    const suffix = r.reason ? ` — ${r.reason}` : "";
    lines.push(`  ${r.action.toUpperCase().padEnd(9)} ${r.label}${suffix}`);
  }
  const { created, updated, unchanged, skipped, failed } = report.counts;
  lines.push(
    `\n${created} created, ${updated} updated, ${unchanged} unchanged, ${skipped} skipped, ${failed} failed  (target: ${report.target})`,
  );
  return lines.join("\n");
}

export function formatJson(report: RunReport): string {
  return JSON.stringify(report, null, 2);
}
