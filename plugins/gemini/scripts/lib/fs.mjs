import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "gemini-bridge-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const SYNC_STDIN_TIMEOUT_MS = 10_000;
const SYNC_STDIN_RETRY_MS = 5;

/**
 * Read all of stdin synchronously.
 *
 * `fs.readFileSync(0)` throws EAGAIN on some platforms (seen on macOS with
 * Node 18) when stdin is a non-blocking pipe and the writer has not finished,
 * e.g. hook input larger than the pipe buffer. Retry on EAGAIN until EOF,
 * giving up after `timeoutMs`.
 */
export function readStdinSync({ fd = 0, timeoutMs = SYNC_STDIN_TIMEOUT_MS } = {}) {
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK") {
        if (Date.now() > deadline) {
          throw new Error(`Timed out after ${timeoutMs / 1000} seconds while reading stdin.`);
        }
        Atomics.wait(sleeper, 0, 0, SYNC_STDIN_RETRY_MS);
        continue;
      }
      if (error?.code === "EOF") {
        break;
      }
      throw error;
    }
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString("utf8");
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
