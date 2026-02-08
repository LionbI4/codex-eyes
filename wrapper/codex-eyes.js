#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import nodePty from "node-pty";

const WAIT_MARKER = "<<WAITING_FOR_IMAGE>>";
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const NUDGE_MESSAGE = "Requested image attached";
const CODEX_COMMAND = process.platform === "win32" ? "codex.cmd" : "codex";

const { spawn } = nodePty;
const repoRoot = process.cwd();
const requestsDir = path.join(repoRoot, ".codex-eyes");
const requestsFile = path.join(requestsDir, "requests.jsonl");

let codexProcess = null;
let outputTail = "";
let restartTimestamps = [];
let restartInFlight = false;
let rawModeEnabled = false;

fs.mkdirSync(requestsDir, { recursive: true });
if (!fs.existsSync(requestsFile)) {
  fs.writeFileSync(requestsFile, "", "utf8");
}

function enforceRestartRateLimit() {
  const now = Date.now();
  restartTimestamps = restartTimestamps.filter((ts) => now - ts < RESTART_WINDOW_MS);
  restartTimestamps.push(now);
  if (restartTimestamps.length > MAX_RESTARTS) {
    throw new Error(`Too many restarts (${MAX_RESTARTS} in ${RESTART_WINDOW_MS}ms).`);
  }
}

function getLastRequestedPath() {
  const contents = fs.readFileSync(requestsFile, "utf8");
  const lines = contents.split(/\r?\n/).filter((line) => line.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const row = JSON.parse(lines[i]);
      if (row && typeof row.path === "string" && row.path.trim() !== "") {
        return row.path;
      }
    } catch {
      // Ignore malformed rows and continue scanning backwards.
    }
  }
  throw new Error("No valid image request found in .codex-eyes/requests.jsonl.");
}

function resolveSafeImagePath(requestedPath) {
  if (path.isAbsolute(requestedPath)) {
    throw new Error("Image path must be relative to repository root.");
  }
  const resolved = path.resolve(repoRoot, requestedPath);
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`;
  if (!(resolved === repoRoot || resolved.startsWith(rootWithSep))) {
    throw new Error("Path traversal rejected: image path escapes repository root.");
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image extension: ${ext}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Requested image does not exist: ${resolved}`);
  }
  const rel = path.relative(repoRoot, resolved).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function spawnCodex(args = []) {
  let proc;
  try {
    proc = spawn(CODEX_COMMAND, args, {
      cwd: repoRoot,
      env: process.env,
      name: "xterm-color",
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });
  } catch (error) {
    throw new Error(
      `Failed to start \`${CODEX_COMMAND}\` from PATH. Install Codex CLI or adjust PATH before running wrapper.`
    );
  }

  proc.onData((data) => onCodexOutput(data));
  proc.onExit(({ exitCode }) => {
    // Ignore stale child exits after a restart.
    if (proc !== codexProcess) {
      return;
    }
    if (restartInFlight) {
      return;
    }
    process.exit(typeof exitCode === "number" ? exitCode : 0);
  });

  return proc;
}

function onCodexOutput(data) {
  process.stdout.write(data);
  outputTail = `${outputTail}${data}`;
  if (outputTail.length > WAIT_MARKER.length * 8) {
    outputTail = outputTail.slice(-WAIT_MARKER.length * 8);
  }
  if (!restartInFlight && outputTail.includes(WAIT_MARKER)) {
    restartWithRequestedImage();
  }
}

function restartWithRequestedImage() {
  restartInFlight = true;
  outputTail = "";
  try {
    enforceRestartRateLimit();
    const requestedPath = getLastRequestedPath();
    const safeRelativePath = resolveSafeImagePath(requestedPath);
    const old = codexProcess;
    codexProcess = spawnCodex(["--continue", "-i", safeRelativePath]);
    if (old) {
      old.kill();
    }
    codexProcess.write(`${NUDGE_MESSAGE}\r`);
  } catch (error) {
    process.stderr.write(`[codex-eyes] ${error.message}\n`);
    process.exit(1);
  } finally {
    restartInFlight = false;
  }
}

function setupInputPassthrough() {
  process.stdin.setEncoding("utf8");
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
    rawModeEnabled = true;
  }
  process.stdin.resume();

  process.stdin.on("data", (data) => {
    if (codexProcess) {
      codexProcess.write(data);
    }
  });
}

function setupResizePassthrough() {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.on("resize", () => {
    if (codexProcess) {
      codexProcess.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    }
  });
}

function restoreTerminalState() {
  if (rawModeEnabled && process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(false);
  }
}

setupInputPassthrough();
setupResizePassthrough();

process.on("SIGINT", () => {
  if (codexProcess) {
    codexProcess.kill();
  }
  restoreTerminalState();
  process.exit(130);
});

process.on("SIGTERM", () => {
  if (codexProcess) {
    codexProcess.kill();
  }
  restoreTerminalState();
  process.exit(143);
});

process.on("exit", () => {
  restoreTerminalState();
});

const initialArgs = process.argv.slice(2);
try {
  codexProcess = spawnCodex(initialArgs);
} catch (error) {
  process.stderr.write(`[codex-eyes] ${error.message}\n`);
  process.exit(1);
}
