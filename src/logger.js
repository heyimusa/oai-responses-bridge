// Minimal leveled logger. Deliberately tiny: this project has no runtime
// dependencies, and a logging framework would be the first one.
//
// Invariant (tested in test/noSecretsInLogs.test.js): nothing in this file,
// nor any call site, may log `apiKey`, `Authorization`, or request/response
// bodies. Log request *shapes* (model, stream boolean, status codes) — never
// contents.

const LEVELS = ["debug", "info", "warn", "error"];

export function createLogger(level = "info") {
  const threshold = LEVELS.includes(level) ? LEVELS.indexOf(level) : LEVELS.indexOf("info");

  function log(levelName, ...args) {
    if (LEVELS.indexOf(levelName) < threshold) return;
    const line = `${new Date().toISOString()} [${levelName}]`;
    if (levelName === "error") console.error(line, ...args);
    else console.log(line, ...args);
  }

  return {
    debug: (...args) => log("debug", ...args),
    info: (...args) => log("info", ...args),
    warn: (...args) => log("warn", ...args),
    error: (...args) => log("error", ...args),
  };
}
