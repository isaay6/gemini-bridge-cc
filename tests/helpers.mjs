import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "gemini");

const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "agy");

export function fixture(name) {
  const read = (ext) => fs.readFileSync(path.join(FIXTURE_DIR, `${name}.${ext}`), "utf8");
  return {
    ndjson: read("ndjson"),
    stderr: read("stderr"),
    exit: Number.parseInt(read("exit").trim(), 10)
  };
}

export function makeTempDir(prefix = "gemini-bridge-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    ...options
  });
}

export function makeTempRepo(files = {}) {
  const dir = makeTempDir("gemini-bridge-repo-");
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  const git = (...args) => {
    const result = run("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd: dir });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  };
  git("init", "-b", "main");
  git("add", "-A");
  git("commit", "--allow-empty", "-m", "initial");
  return fs.realpathSync.native(dir);
}
