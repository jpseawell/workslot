import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkslotError } from "./errors.js";

function rootDir() {
  return join(homedir(), ".workslot");
}

function registryPath() {
  return join(rootDir(), "registry.json");
}

function lockPath() {
  return join(rootDir(), "registry.lock");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function lockIsStale(lock) {
  let pid = 0;
  try {
    pid = Number(readFileSync(join(lock, "pid"), "utf8"));
  } catch {
    pid = 0;
  }
  if (pid && isAlive(pid)) return false;
  try {
    return Date.now() - statSync(lock).mtimeMs > 5000;
  } catch {
    return false;
  }
}

function acquire() {
  mkdirSync(rootDir(), { recursive: true });
  const lock = lockPath();
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (lockIsStale(lock)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new WorkslotError("Timed out waiting for the ~/.workslot registry lock");
      }
      sleepSync(40);
    }
  }
}

function releaseLock() {
  rmSync(lockPath(), { recursive: true, force: true });
}

export function withRegistry(fn) {
  acquire();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

export function loadRegistry() {
  const file = registryPath();
  if (!existsSync(file)) return { version: 1, repos: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new WorkslotError(`Cannot parse ${file}`);
  }
  if (parsed.version !== 1 || !parsed.repos) {
    throw new WorkslotError(`${file} is not a workslot registry (version 1)`);
  }
  return parsed;
}

export function saveRegistry(registry) {
  const dir = rootDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `registry.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(tmp, registryPath());
}

export function readRegistry() {
  return withRegistry(() => loadRegistry());
}

export function updateRegistry(mutator) {
  return withRegistry(() => {
    const registry = loadRegistry();
    const result = mutator(registry);
    saveRegistry(registry);
    return result;
  });
}
