import { describe, expect, it, vi } from "vitest";
import { createDirectusClient, isTimeoutError } from "../../src/http.js";

// Regression cover for #39: before this, a request that never answered parked
// forever, and a target that 503-flapped cost MAX_RETRIES × backoff with no
// upper bound — which is what made `overview` look deadlocked.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createDirectusClient per-attempt timeout", () => {
  it("aborts an attempt that produces no response and surfaces a timeout error", async () => {
    // Never resolves on its own — only the abort signal can end it.
    const hang: typeof globalThis.fetch = (_url, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "TimeoutError";
          rej(e);
        });
      });

    const client = createDirectusClient({
      baseUrl: "https://example.invalid",
      token: "t",
      fetch: hang,
      timeoutMs: 20,
      maxElapsedMs: 60,
    });

    const err = await client.get("/items/x").catch((e) => e);
    expect(isTimeoutError(err)).toBe(true);
    expect((err as Error).message).toMatch(/timeout after 20ms/);
  });

  it("passes an abort signal on every attempt", async () => {
    const seen: Array<AbortSignal | undefined | null> = [];
    const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
      seen.push(init?.signal);
      return jsonResponse({ data: { id: 1 } });
    };
    const client = createDirectusClient({
      baseUrl: "https://example.invalid",
      token: "t",
      fetch: fetchImpl,
    });
    await client.get("/items/x");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("does not attach a signal when timeoutMs is 0 (opt-out)", async () => {
    const seen: Array<AbortSignal | undefined | null> = [];
    const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
      seen.push(init?.signal);
      return jsonResponse({ data: {} });
    };
    const client = createDirectusClient({
      baseUrl: "https://example.invalid",
      token: "t",
      fetch: fetchImpl,
      timeoutMs: 0,
    });
    await client.get("/items/x");
    expect(seen[0]).toBeUndefined();
  });
});

describe("createDirectusClient retry-elapsed ceiling", () => {
  it("stops retrying 503s once maxElapsedMs is spent instead of running the full backoff", async () => {
    let calls = 0;
    const flap: typeof globalThis.fetch = async () => {
      calls++;
      return new Response("under pressure", { status: 503 });
    };

    const client = createDirectusClient({
      baseUrl: "https://example.invalid",
      token: "t",
      fetch: flap,
      timeoutMs: 0,
      maxElapsedMs: 700, // 500ms + 1000ms backoff — cuts the sequence short
    });

    const started = Date.now();
    const err = await client.get("/items/x").catch((e) => e);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(Error);
    // Would be 7 attempts / ~31s of backoff without the ceiling.
    expect(calls).toBeLessThan(7);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("still retries a transient 503 to success when there is time to do so", async () => {
    let calls = 0;
    const flakey: typeof globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response("under pressure", { status: 503 });
      return jsonResponse({ data: { ok: true } });
    };
    const client = createDirectusClient({
      baseUrl: "https://example.invalid",
      token: "t",
      fetch: flakey,
    });
    await expect(client.get("/items/x")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
