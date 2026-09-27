#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HELP = `oai-responses-bridge — Chat Completions -> Responses API bridge

Lets a client that only speaks the OpenAI Chat Completions wire format
(most coding-agent CLIs) use reasoning models that require the Responses API
when function tools are involved, without the client needing to change.

USAGE
  oai-responses-bridge [options]

OPTIONS
  --config <path>              JSON config file (see README for schema)
  --port <n>                   Listen port (default 4801)
  --host <addr>                Listen address (default 127.0.0.1)
  --upstream <url>             Upstream base URL, e.g. https://litellm.example.com/v1
  --api-key <key>              Upstream API key (prefer --api-key-env; this is visible in 'ps')
  --api-key-env <NAME>         Read the upstream API key from this environment variable
  --reasoning-models <a,b,c>   Comma-separated model ids to route via /v1/responses
  --effort <level>             Default reasoning effort: none|low|medium|high|xhigh|max (default high)
  --max-upstream-attempts <n>  Retry attempts for transient upstream failures (default 4)
  --log-level <level>          debug|info|warn|error (default info)
  --help                       Show this help
  --version                    Show version

ENVIRONMENT VARIABLES
  ORB_CONFIG, ORB_PORT, ORB_HOST, ORB_UPSTREAM_BASE_URL, ORB_API_KEY,
  ORB_API_KEY_ENV, ORB_REASONING_MODELS, ORB_DEFAULT_REASONING_EFFORT,
  ORB_MAX_UPSTREAM_ATTEMPTS, ORB_LOG_LEVEL

Precedence (highest wins): CLI flags > environment variables > config file > defaults.
`;

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  let cfg;
  try {
    cfg = loadConfig({ argv });
  } catch (e) {
    process.stderr.write(`oai-responses-bridge: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(cfg.logLevel);
  const server = createServer(cfg, logger);

  server.listen(cfg.port, cfg.host, () => {
    logger.info(`listening on http://${cfg.host}:${cfg.port}  upstream=${cfg.upstreamBaseUrl}`);
    logger.info("reasoning models routed via /v1/responses:", cfg.reasoningModels.join(", "));
  });

  const shutdown = (signal) => {
    logger.info(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main(process.argv.slice(2));
