import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULTS = {
  port: 4801,
  host: "127.0.0.1",
  reasoningModels: [],
  defaultReasoningEffort: "high",
  maxUpstreamAttempts: 4,
  logLevel: "info",
};

/**
 * Loads config from, in increasing priority order: built-in defaults, a JSON
 * config file, environment variables (`ORB_*`), then explicit CLI flags.
 * Never logs `apiKey`; callers must not either.
 *
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [opts]
 */
export function loadConfig({ argv = [], env = process.env } = {}) {
  const flags = parseFlags(argv);

  const fileConfig = loadFileConfig(flags.config || env.ORB_CONFIG);

  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig(env),
    ...flags,
  };
  delete merged.config;

  return validate(resolveApiKey(merged, env));
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--config":
        out.config = next();
        break;
      case "--port":
        out.port = Number(next());
        break;
      case "--host":
        out.host = next();
        break;
      case "--upstream":
        out.upstreamBaseUrl = next();
        break;
      case "--api-key":
        out.apiKey = next();
        break;
      case "--api-key-env":
        out.apiKeyEnv = next();
        break;
      case "--reasoning-models":
        out.reasoningModels = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--effort":
        out.defaultReasoningEffort = next();
        break;
      case "--max-upstream-attempts":
        out.maxUpstreamAttempts = Number(next());
        break;
      case "--log-level":
        out.logLevel = next();
        break;
      default:
        break;
    }
  }
  return out;
}

function loadFileConfig(configPath) {
  if (!configPath) return {};
  const resolved = path.resolve(configPath);
  if (!existsSync(resolved)) {
    throw new Error(`config file not found: ${resolved}`);
  }
  try {
    return JSON.parse(readFileSync(resolved, "utf8"));
  } catch (e) {
    throw new Error(`config file at ${resolved} is not valid JSON: ${e.message}`);
  }
}

function envConfig(env) {
  const out = {};
  if (env.ORB_PORT) out.port = Number(env.ORB_PORT);
  if (env.ORB_HOST) out.host = env.ORB_HOST;
  if (env.ORB_UPSTREAM_BASE_URL) out.upstreamBaseUrl = env.ORB_UPSTREAM_BASE_URL;
  if (env.ORB_API_KEY) out.apiKey = env.ORB_API_KEY;
  if (env.ORB_API_KEY_ENV) out.apiKeyEnv = env.ORB_API_KEY_ENV;
  if (env.ORB_REASONING_MODELS) {
    out.reasoningModels = env.ORB_REASONING_MODELS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (env.ORB_DEFAULT_REASONING_EFFORT) out.defaultReasoningEffort = env.ORB_DEFAULT_REASONING_EFFORT;
  if (env.ORB_MAX_UPSTREAM_ATTEMPTS) out.maxUpstreamAttempts = Number(env.ORB_MAX_UPSTREAM_ATTEMPTS);
  if (env.ORB_LOG_LEVEL) out.logLevel = env.ORB_LOG_LEVEL;
  return out;
}

function resolveApiKey(cfg, env) {
  if (cfg.apiKey) return cfg;
  if (cfg.apiKeyEnv) {
    const value = env[cfg.apiKeyEnv];
    if (!value) {
      throw new Error(
        `apiKeyEnv is set to "${cfg.apiKeyEnv}" but that environment variable is empty or unset`
      );
    }
    return { ...cfg, apiKey: value };
  }
  return cfg;
}

function validate(cfg) {
  const problems = [];
  if (!cfg.upstreamBaseUrl) problems.push("upstreamBaseUrl is required (--upstream, ORB_UPSTREAM_BASE_URL, or config file)");
  if (!cfg.apiKey) problems.push("apiKey is required (--api-key, --api-key-env, ORB_API_KEY/ORB_API_KEY_ENV, or config file)");
  if (!Array.isArray(cfg.reasoningModels) || cfg.reasoningModels.length === 0) {
    problems.push("reasoningModels must list at least one model id (--reasoning-models, ORB_REASONING_MODELS, or config file)");
  }
  if (!Number.isInteger(cfg.port) || cfg.port <= 0) problems.push("port must be a positive integer");

  if (problems.length) {
    throw new Error(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    port: cfg.port,
    host: cfg.host,
    upstreamBaseUrl: cfg.upstreamBaseUrl.replace(/\/+$/, ""),
    apiKey: cfg.apiKey,
    reasoningModels: cfg.reasoningModels,
    defaultReasoningEffort: cfg.defaultReasoningEffort,
    maxUpstreamAttempts: cfg.maxUpstreamAttempts,
    logLevel: cfg.logLevel,
  };
}
