import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "gemini-bridge-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

const PIPED_STDIN_TIMEOUT_MS = 10_000;

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return Promise.resolve("");
  }
  if (process.stdin.readableEnded) {
    return Promise.resolve("");
  }

  // Use the stream API instead of a synchronous read: a pipe whose writer
  // remains open without writing must not hold the companion forever.
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.off("close", onClose);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk) => chunks.push(Buffer.from(chunk));
    const onEnd = () => finish();
    const onClose = () => finish();
    const onError = (error) => finish(error);
    const timeout = setTimeout(
      () => finish(new Error(`Timed out after ${PIPED_STDIN_TIMEOUT_MS / 1000} seconds while reading piped stdin.`)),
      PIPED_STDIN_TIMEOUT_MS
    );

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.once("close", onClose);
    process.stdin.resume();
  });
}
