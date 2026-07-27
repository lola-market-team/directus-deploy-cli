import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOverview, hasErrors } from "../../src/overview.js";
import type { ProgressEvent } from "../../src/overview.js";

// #39: `overview` used to buffer everything until the slowest probe of the
// slowest target resolved, with no per-check deadline — so one wedged check
// produced an unbounded, entirely silent run.

async function repoWithProbe(cmd: string): Promise<{ repoRoot: string; targetsFile: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "overview-progress-"));
  const targetsFile = join(repoRoot, "targets.json");
  await writeFile(
    targetsFile,
    JSON.stringify({
      // No `ref` — a worktree target, so no git materialization is needed.
      targets: { sandbox: { base_url: "https://sandbox.invalid" } },
      drift_probes: [{ name: "slow", cmd }],
    }),
    "utf8",
  );
  return { repoRoot, targetsFile };
}

describe("overview progress + per-check deadline (#39)", () => {
  it("emits start and terminal events per check instead of staying silent", async () => {
    const { repoRoot, targetsFile } = await repoWithProbe(
      `echo '{"clean":true,"summary":"in sync"}'`,
    );
    process.env.DIRECTUS_SANDBOX_TOKEN = "tok";

    const events: ProgressEvent[] = [];
    await runOverview({
      targetsFile,
      repoRoot,
      // Short: the HTTP legs point at an unresolvable host, and we only care
      // that they announce themselves — not how long their retries take.
      timeoutMs: 2_000,
      onProgress: (e) => events.push(e),
    });

    const probeEvents = events.filter((e) => e.stage === "probe:slow");
    expect(probeEvents.map((e) => e.status)).toEqual(["start", "ok"]);
    expect(probeEvents[1]!.detail).toBe("in sync");
    expect(probeEvents[1]!.ms).toBeTypeOf("number");

    // Every dimension announces itself, so a slow run is legible while running.
    const started = events.filter((e) => e.status === "start").map((e) => e.stage);
    expect(started).toEqual(expect.arrayContaining(["extensions", "migrations", "config", "probe:slow"]));
  }, 30_000);

  it("times out a wedged probe, kills it, and reports it as an error (exit 2)", async () => {
    // Would outlive the command by minutes without a kill.
    const { repoRoot, targetsFile } = await repoWithProbe("sleep 120");
    process.env.DIRECTUS_SANDBOX_TOKEN = "tok";

    const events: ProgressEvent[] = [];
    const started = Date.now();
    const report = await runOverview({
      targetsFile,
      repoRoot,
      timeoutMs: 300,
      onProgress: (e) => events.push(e),
    });
    const elapsed = Date.now() - started;

    const done = events.find((e) => e.stage === "probe:slow" && e.status !== "start");
    expect(done?.status).toBe("timeout");

    const probe = report.targets[0]!.probes!.slow!;
    expect(probe).toHaveProperty("error");
    expect((probe as { error: string }).error).toMatch(/^TIMEOUT /);

    // A timed-out check is "could not run", which must outrank drift.
    expect(hasErrors(report)).toBe(true);
    // Bounded by the deadline, not by the 120s sleep.
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);

  it("runs without a progress sink (the MCP path) and still applies the deadline", async () => {
    const { repoRoot, targetsFile } = await repoWithProbe("sleep 120");
    process.env.DIRECTUS_SANDBOX_TOKEN = "tok";

    const report = await runOverview({ targetsFile, repoRoot, timeoutMs: 300 });
    expect(hasErrors(report)).toBe(true);
  }, 60_000);
});
