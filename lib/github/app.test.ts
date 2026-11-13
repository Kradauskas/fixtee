import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadGitHubAppConfig, normalizePrivateKey, resetGitHubAppForTests } from "./app";

// Throwaway key, same format GitHub hands out (PKCS#1, "BEGIN RSA PRIVATE KEY").
const { privateKey: pkcs1 } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const PKCS8_HEADER = "-----BEGIN PRIVATE KEY-----";

function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_SLUG: "autofix-test",
    GITHUB_PRIVATE_KEY: pkcs1,
    GITHUB_WEBHOOK_SECRET: "webhook-secret-value",
    ...overrides,
  };
}

afterEach(() => resetGitHubAppForTests());

describe("normalizePrivateKey", () => {
  it("converts GitHub's PKCS#1 key to PKCS#8", () => {
    expect(pkcs1).toContain("BEGIN RSA PRIVATE KEY");
    expect(normalizePrivateKey(pkcs1)).toContain(PKCS8_HEADER);
  });

  it("accepts a single-line key with escaped \\n", () => {
    const escaped = pkcs1.trim().replace(/\n/g, "\\n");
    expect(escaped).not.toContain("\n");
    expect(normalizePrivateKey(escaped)).toContain(PKCS8_HEADER);
  });

  it("accepts CRLF line endings and surrounding quotes", () => {
    expect(normalizePrivateKey(`"${pkcs1.replace(/\n/g, "\r\n")}"`)).toContain(PKCS8_HEADER);
  });

  it("accepts a base64-encoded PEM", () => {
    expect(normalizePrivateKey(Buffer.from(pkcs1).toString("base64"))).toContain(PKCS8_HEADER);
  });

  it("produces the same key for every input form", () => {
    const expected = normalizePrivateKey(pkcs1);
    expect(normalizePrivateKey(pkcs1.replace(/\n/g, "\\n"))).toBe(expected);
    expect(normalizePrivateKey(Buffer.from(pkcs1).toString("base64"))).toBe(expected);
  });

  it("rejects non-PEM input", () => {
    expect(() => normalizePrivateKey("not-a-key")).toThrow(/not a PEM key/);
  });

  it("rejects a corrupted PEM without echoing it", () => {
    const corrupted = pkcs1.replace(/[A-Za-z0-9+/]{20}/, "AAAAAAAAAAAAAAAAAAAA");
    let message = "";
    try {
      normalizePrivateKey(corrupted);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("GITHUB_PRIVATE_KEY could not be parsed as a private key");
  });
});

describe("loadGitHubAppConfig", () => {
  it("parses a valid env", () => {
    const config = loadGitHubAppConfig(validEnv());
    expect(config.appId).toBe(123456);
    expect(config.slug).toBe("autofix-test");
    expect(config.webhookSecret).toBe("webhook-secret-value");
    expect(config.privateKey).toContain(PKCS8_HEADER);
  });

  it("names missing variables", () => {
    expect(() =>
      loadGitHubAppConfig(validEnv({ GITHUB_APP_SLUG: undefined, GITHUB_WEBHOOK_SECRET: undefined })),
    ).toThrow(/GITHUB_APP_SLUG.*GITHUB_WEBHOOK_SECRET/);
  });

  it("rejects a non-numeric App ID (e.g. the Client ID pasted by mistake)", () => {
    expect(() => loadGitHubAppConfig(validEnv({ GITHUB_APP_ID: "Iv23liABCDEF" }))).toThrow(
      /GITHUB_APP_ID: must be the numeric App ID/,
    );
  });

  it("never puts secret values into error messages", () => {
    let message = "";
    try {
      loadGitHubAppConfig(validEnv({ GITHUB_APP_ID: "abc", GITHUB_PRIVATE_KEY: "" }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/GITHUB_APP_ID/);
    expect(message).toMatch(/GITHUB_PRIVATE_KEY/);
    expect(message).not.toContain("webhook-secret-value");
    expect(message).not.toContain("abc");
  });
});
