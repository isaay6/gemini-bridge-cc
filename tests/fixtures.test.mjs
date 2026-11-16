import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { REPO_ROOT } from "./helpers.mjs";

test("fixture content contains no personal /Users paths across concatenated fragments", () => {
  const fixtureDir = path.join(REPO_ROOT, "tests", "fixtures");
  const files = fs.readdirSync(fixtureDir, { recursive: true });
  const content = files.filter((file) => file.endsWith(".ndjson")).map((file) => fs.readFileSync(path.join(fixtureDir, file), "utf8")).join("");
  assert.doesNotMatch(content, /\/Users\//);
});
