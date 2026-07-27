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

describe("createDirectusClient does not replay non-idempotent writes on timeout", () => {
  // The dangerous case: the server DOES commit, just slower than our deadline.
  // Aborting and retrying would create the row twice.
  function slowCommitFetch(dispatched: string[]): typeof globalThis.fetch {
    return async (_url, init) => {
      dispatched.push((init?.method ?? "GET").toUpperCase());
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, 300);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const e = new Error("aborted");
          e.name = "TimeoutError";
          rej(e);
        });
      });
      return jsonResponse({ data: { id: 1 } });
    };
  }

  for (const method of ["post", "patch", "delete"] as const) {
    it(`${method} dispatches exactly once and surfaces the timeout`, async () => {
      const dispatched: string[] = [];
      const client = createDirectusClient({
        baseUrl: "https://example.invalid",
        token: "t",
        fetch: slowCommitFetch(dispatched),
        timeoutMs: 50,
        maxElapsedMs: 5_000,
      });

      const err = await (method === "delete"
        ? client.delete("/items/x")
        : client[method]("/items/x", { a: 1 })
      ).catch((e) => e);

      expect(isTimeoutError(err)).toBe(true);
      expect(dispatched).toHaveLength(1);
    });
  }

  it("still replays a timed-out GET, which is safe to repeat", async () => {
    const dispatched: string[] = [];
    const client = createDirectusClient({
      baseUrl: "https://example.invalid",
      token: "t",
      fetch: slowCommitFetch(dispatched),
      timeoutMs: 50,
      maxElapsedMs: 1_200,
    });
    await client.get("/items/x").catch(() => undefined);
    expect(dispatched.length).toBeGreaterThan(1);
  });

  it("still retries a write on 503 — the server shed it without processing", async () => {
    let calls = 0;
    const client = createDirectusClient({
      baseUrl: "https://example.invalid",
      token: "t",
      fetch: async () => {
        calls++;
        if (calls === 1) return new Response("under pressure", { status: 503 });
        return jsonResponse({ data: { ok: true } });
      },
    });
    await expect(client.post("/items/x", {})).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
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
