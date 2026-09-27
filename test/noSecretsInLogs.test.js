// Regression guard: this project exists partly because a secret ended up
// somewhere it shouldn't have (see README "Security notes"). This test
// statically scans every source file for logging calls that mention a
// secret-shaped identifier, so a future change can't silently reintroduce
// that class of bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [path.join(__dirname, "..", "src"), path.join(__dirname, "..", "bin")];

const LOG_CALL = /\b(logger?\.(debug|info|warn|error)|console\.(log|error|warn|info))\s*\(/;
const FORBIDDEN_TOKENS = [/apiKey/i, /authorization/i, /\bAPI_KEY\b/];

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJsFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

test("no logging call in src/ or bin/ references an api key or Authorization header", () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const file of listJsFiles(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (LOG_CALL.test(line) && FORBIDDEN_TOKENS.some((re) => re.test(line))) {
          offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `found logging calls that may leak secrets:\n${offenders.join("\n")}`);
});
