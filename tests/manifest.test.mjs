import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { REPO_ROOT, PLUGIN_ROOT, fixture, makeTempRepo } from "./helpers.mjs";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

test("marketplace declares the single gemini plugin", () => {
  const market = readJson(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"));
  assert.equal(market.name, "isaay6");
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, "gemini");
  assert.equal(market.plugins[0].source, "./plugins/gemini");
});

test("all versions are equal", () => {
  const pkg = readJson(path.join(REPO_ROOT, "package.json"));
  const market = readJson(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"));
  const plugin = readJson(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"));
  assert.equal(plugin.name, "gemini");
  assert.equal(market.metadata.version, pkg.version);
  assert.equal(market.plugins[0].version, pkg.version);
  assert.equal(plugin.version, pkg.version);
});

test("makeTempRepo returns a realpath git repo with one commit", () => {
  const dir = makeTempRepo({ "a/b.txt": "hi\n" });
  assert.equal(dir, fs.realpathSync.native(dir));
  assert.equal(fs.readFileSync(path.join(dir, "a", "b.txt"), "utf8"), "hi\n");
  assert.ok(fs.existsSync(path.join(dir, ".git")));
});

test("fixture('success') loads ndjson, stderr and numeric exit", () => {
  const f = fixture("success");
  assert.equal(typeof f.ndjson, "string");
  assert.equal(typeof f.stderr, "string");
  assert.equal(typeof f.exit, "number");
  assert.ok(f.ndjson.length > 0);
});
