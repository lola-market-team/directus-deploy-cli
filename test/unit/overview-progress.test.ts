import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
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
    // A COMPOUND command on purpose. `sh -c "sleep 120"` is exec-replaced by
    // sh, so killing the child pid happens to reach the worker — which made an
    // earlier version of this test pass against a kill that could not handle
    // the realistic shapes (`a | b`, `cd x && a`), where the worker is a
    // grandchild in the same process group. See the orphan check below.
    const { repoRoot, targetsFile } = await repoWithProbe("cd / && sleep 120 | cat");
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

    // The whole process group must be gone, not just the `sh` that spawned it.
    // An orphaned probe keeps holding its connection to the target.
    await new Promise((r) => setTimeout(r, 500));
    // `sleep 1[2]0` still matches the probe's "sleep 120", but the bracket
    // keeps the pgrep command line itself from matching — otherwise the shell
    // execSync spawns shows up as its own false positive.
    const orphans = execSync(`pgrep -f "sleep 1[2]0" || true`, { encoding: "utf8" }).trim();
    expect(orphans).toBe("");
  }, 60_000);

  it("runs without a progress sink (the MCP path) and still applies the deadline", async () => {
    // Distinct duration so it can't collide with the orphan pgrep above.
    const { repoRoot, targetsFile } = await repoWithProbe("sleep 121");
    process.env.DIRECTUS_SANDBOX_TOKEN = "tok";

    const report = await runOverview({ targetsFile, repoRoot, timeoutMs: 300 });
    expect(hasErrors(report)).toBe(true);
  }, 60_000);
});
