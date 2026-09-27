import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

const BASE_ENV = { PATH: process.env.PATH };

test("throws a clear error when required fields are missing", () => {
  assert.throws(() => loadConfig({ argv: [], env: BASE_ENV }), /upstreamBaseUrl is required/);
});

test("env vars populate config", () => {
  const cfg = loadConfig({
    argv: [],
    env: {
      ...BASE_ENV,
      ORB_UPSTREAM_BASE_URL: "https://example.com/v1",
      ORB_API_KEY: "sk-test",
      ORB_REASONING_MODELS: "gpt-6-sol,gpt-5.6-terra",
    },
  });
  assert.equal(cfg.upstreamBaseUrl, "https://example.com/v1");
  assert.equal(cfg.apiKey, "sk-test");
  assert.deepEqual(cfg.reasoningModels, ["gpt-6-sol", "gpt-5.6-terra"]);
  assert.equal(cfg.port, 4801, "default port applies when unset");
});

test("CLI flags take priority over env vars", () => {
  const cfg = loadConfig({
    argv: ["--port", "9999", "--upstream", "https://flag.example.com/v1"],
    env: {
      ...BASE_ENV,
      ORB_UPSTREAM_BASE_URL: "https://env.example.com/v1",
      ORB_API_KEY: "sk-test",
      ORB_REASONING_MODELS: "gpt-6-sol",
    },
  });
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.upstreamBaseUrl, "https://flag.example.com/v1");
});

test("apiKeyEnv resolves the key from the named environment variable", () => {
  const cfg = loadConfig({
    argv: [],
    env: {
      ...BASE_ENV,
      ORB_UPSTREAM_BASE_URL: "https://example.com/v1",
      ORB_API_KEY_ENV: "MY_SECRET",
      ORB_REASONING_MODELS: "gpt-6-sol",
      MY_SECRET: "sk-from-env",
    },
  });
  assert.equal(cfg.apiKey, "sk-from-env");
});

test("apiKeyEnv pointing at an unset variable fails loudly", () => {
  assert.throws(
    () =>
      loadConfig({
        argv: [],
        env: {
          ...BASE_ENV,
          ORB_UPSTREAM_BASE_URL: "https://example.com/v1",
          ORB_API_KEY_ENV: "NOPE_NOT_SET",
          ORB_REASONING_MODELS: "gpt-6-sol",
        },
      }),
    /NOPE_NOT_SET.*empty or unset/
  );
});

test("config file values are used, and env vars still override them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orb-test-"));
  const file = path.join(dir, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      upstreamBaseUrl: "https://file.example.com/v1",
      apiKey: "sk-file",
      reasoningModels: ["gpt-6-sol"],
      port: 1234,
    })
  );
  try {
    const cfg = loadConfig({
      argv: ["--config", file],
      env: { ...BASE_ENV, ORB_PORT: "5555" },
    });
    assert.equal(cfg.upstreamBaseUrl, "https://file.example.com/v1");
    assert.equal(cfg.port, 5555, "env var overrides config file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trailing slashes on upstreamBaseUrl are normalized away", () => {
  const cfg = loadConfig({
    argv: [],
    env: {
      ...BASE_ENV,
      ORB_UPSTREAM_BASE_URL: "https://example.com/v1///",
      ORB_API_KEY: "sk-test",
      ORB_REASONING_MODELS: "gpt-6-sol",
    },
  });
  assert.equal(cfg.upstreamBaseUrl, "https://example.com/v1");
});
