import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PLUGIN_ROOT } from "./helpers.mjs";

const commandNames = ["setup", "review", "adversarial-review", "rescue", "status", "result", "cancel"];
const companionPath = path.join(PLUGIN_ROOT, "scripts", "gemini-companion.mjs");

test("every command has a description and references companion subcommands in the dispatcher", () => {
  const companion = fs.readFileSync(companionPath, "utf8");
  for (const name of commandNames) {
    const command = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", `${name}.md`), "utf8");
    assert.match(command, /^---\n[\s\S]*?^description:\s*.+$/m, `${name} needs a description`);
    for (const match of command.matchAll(/gemini-companion\.mjs"\s+([a-z-]+)/g)) {
      assert.match(companion, new RegExp(`case "${match[1]}":`), `${name} references missing ${match[1]} dispatcher`);
    }
  }
});

test("plugin files do not contain the legacy transport name", () => {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.name !== "NOTICE") files.push(filePath);
    }
  };
  visit(PLUGIN_ROOT);
  for (const filePath of files) {
    assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /codex/i, path.relative(PLUGIN_ROOT, filePath));
  }
});

test("stop hook timeout leaves time for its 300-second review", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.Stop[0].hooks[0].timeout >= 330);
});
