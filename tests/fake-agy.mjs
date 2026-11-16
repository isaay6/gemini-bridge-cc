#!/usr/bin/env node
// Test double for the Antigravity CLI (`agy`). Replays recorded fixtures.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "agy");
const argv = process.argv.slice(2);

if (argv[0] === "--version") {
  process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? "1.5.9"}\n`);
  process.exit(0);
}

if (argv[0] === "models") {
  process.stdout.write("Fetching available models...\n");
  process.stdout.write("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n");
  process.stdout.write("gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n");
  process.exit(0);
}

let prompt = null;
if (argv.includes("--input-format") && argv[argv.indexOf("--input-format") + 1] === "stream-json") {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const line = input.split(/\r?\n/, 1)[0];
  if (line) {
    prompt = JSON.parse(line)?.message?.content ?? null;
  }
}

if (process.env.FAKE_AGY_ARGS_FILE) {
  fs.writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify({ argv, cwd: process.cwd(), prompt }));
}

if (process.env.FAKE_AGY_HANG === "1") {
  process.stdout.write(
    `${JSON.stringify({ event: "init", conversation_id: "hang-0000", init: { cwd: process.cwd() } })}\n`
  );
  setInterval(() => {}, 1 << 30);
} else {
  const name = process.env.FAKE_AGY_FIXTURE ?? "success";
  const read = (ext) => fs.readFileSync(path.join(FIXTURE_DIR, `${name}.${ext}`), "utf8");
  process.stdout.write(read("ndjson"));
  process.stderr.write(read("stderr"));
  process.exitCode = Number.parseInt(read("exit").trim(), 10) || 0;
}
