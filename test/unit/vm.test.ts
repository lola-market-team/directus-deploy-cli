import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { buildIdTokenAssertion, resolveVmControl } from "../../src/vm.js";
import { buildAccessTokenAssertion, parseGsUri } from "../../src/gcloud.js";

const base = { base_url: "https://test.example.com", ssh_host: "h", ssh_user: "u", remote_extensions_path: "/x" };

describe("resolveVmControl", () => {
  it("resolves url, token (default env convention), and health url", () => {
    const ctl = resolveVmControl(
      "test",
      { ...base, control_url: "https://fn.example.com/test-vm-control/" },
      { DIRECTUS_TEST_CONTROL_TOKEN: "sekrit" },
    );
    expect(ctl.controlUrl).toBe("https://fn.example.com/test-vm-control");
    expect(ctl.token).toBe("sekrit");
    expect(ctl.healthUrl).toBe("https://test.example.com/server/health");
  });

  it("honors an explicit control_token_env", () => {
    const ctl = resolveVmControl(
      "test",
      { ...base, control_url: "https://fn.example.com/c", control_token_env: "MY_TOKEN" },
      { MY_TOKEN: "t2", DIRECTUS_TEST_CONTROL_TOKEN: "wrong" },
    );
    expect(ctl.token).toBe("t2");
  });

  it("throws without control_url", () => {
    expect(() => resolveVmControl("test", { ...base }, {})).toThrow(/no control_url/);
  });

  it("throws when NEITHER token nor invoker key is set, naming both variables", () => {
    expect(() =>
      resolveVmControl("prod", { ...base, control_url: "https://fn.example.com/c" }, {}),
    ).toThrow(/DIRECTUS_PROD_CONTROL_TOKEN.*DIRECTUS_PROD_INVOKER_KEY_B64/);
  });

  it("resolves an API Gateway key and it wins as the preferred transport", () => {
    const ctl = resolveVmControl(
      "test",
      { ...base, control_url: "https://gw.example.dev/control" },
      { DIRECTUS_TEST_CONTROL_KEY: "AIzaSyFake" },
    );
    expect(ctl.apiKey).toBe("AIzaSyFake");
    expect(ctl.token).toBeUndefined();
    expect(ctl.invokerKey).toBeUndefined();
  });

  it("accepts invoker key alone — shared token is optional", () => {
    const key = { client_email: "sa@p.iam.gserviceaccount.com", private_key: "-----BEGIN..." };
    const ctl = resolveVmControl(
      "test",
      { ...base, control_url: "https://fn.example.com/c" },
      { DIRECTUS_TEST_INVOKER_KEY_B64: Buffer.from(JSON.stringify(key)).toString("base64") },
    );
    expect(ctl.token).toBeUndefined();
    expect(ctl.invokerKey?.client_email).toBe(key.client_email);
  });

  it("parses an invoker SA key from base64 JSON and rejects garbage", () => {
    const key = { client_email: "sa@p.iam.gserviceaccount.com", private_key: "-----BEGIN..." };
    const env = {
      DIRECTUS_TEST_CONTROL_TOKEN: "t",
      DIRECTUS_TEST_INVOKER_KEY_B64: Buffer.from(JSON.stringify(key)).toString("base64"),
    };
    const ctl = resolveVmControl("test", { ...base, control_url: "https://fn.example.com/c" }, env);
    expect(ctl.invokerKey?.client_email).toBe(key.client_email);

    expect(() =>
      resolveVmControl(
        "test",
        { ...base, control_url: "https://fn.example.com/c" },
        { DIRECTUS_TEST_CONTROL_TOKEN: "t", DIRECTUS_TEST_INVOKER_KEY_B64: "not-base64-json" },
      ),
    ).toThrow(/base64-encoded service-account JSON key/);
  });
});

describe("buildIdTokenAssertion", () => {
  it("produces a verifiable RS256 JWT with the right claims", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const now = 1_700_000_000;
    const jwt = buildIdTokenAssertion(
      { client_email: "sa@p.iam.gserviceaccount.com", private_key: pem },
      "https://fn.example.com/c",
      now,
    );
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toEqual({
      iss: "sa@p.iam.gserviceaccount.com",
      sub: "sa@p.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      target_audience: "https://fn.example.com/c",
      iat: now,
      exp: now + 3600,
    });
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("resolveAdminToken", () => {
  it("uses the DIRECTUS_<TARGET>_TOKEN convention and honors token_env", async () => {
    const { resolveAdminToken } = await import("../../src/targets.js");
    expect(resolveAdminToken("staging", { ...base }, { DIRECTUS_STAGING_TOKEN: "t1" })).toBe("t1");
    expect(resolveAdminToken("staging", { ...base, token_env: "MY_T" }, { MY_T: "t2" })).toBe("t2");
    expect(() => resolveAdminToken("prod", { ...base }, {})).toThrow(/DIRECTUS_PROD_TOKEN/);
  });
});

describe("buildAccessTokenAssertion", () => {
  it("carries a scope claim instead of target_audience", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = buildAccessTokenAssertion(
      { client_email: "sa@p.iam.gserviceaccount.com", private_key: pem },
      "https://www.googleapis.com/auth/devstorage.read_write",
      1_700_000_000,
    );
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    expect(claims.scope).toBe("https://www.googleapis.com/auth/devstorage.read_write");
    expect(claims.target_audience).toBeUndefined();
    expect(claims.iss).toBe("sa@p.iam.gserviceaccount.com");
  });
});

describe("parseGsUri", () => {
  it("splits bucket and prefix", () => {
    expect(parseGsUri("gs://lola-market-extensions")).toEqual({ bucket: "lola-market-extensions", prefix: "" });
    expect(parseGsUri("gs://b/pre/fix/")).toEqual({ bucket: "b", prefix: "pre/fix" });
    expect(() => parseGsUri("https://nope")).toThrow(/not a gs:/);
  });
});
