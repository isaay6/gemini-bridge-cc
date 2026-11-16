import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PLUGIN_ROOT } from "./helpers.mjs";

const FS_MODULE = pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", "fs.mjs")).href;

test("readStdinSync reads large stdin written slowly in chunks", async () => {
  const script = `import { readStdinSync } from ${JSON.stringify(FS_MODULE)};
const text = readStdinSync();
process.stdout.write(String(text.length) + ":" + text.slice(-5));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const chunk = "x".repeat(64 * 1024);
  for (let i = 0; i < 5; i += 1) {
    child.stdin.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.stdin.end("END!!");

  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stdout, `${5 * 64 * 1024 + 5}:END!!`);
});
