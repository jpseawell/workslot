import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { WorkslotError } from "./errors.js";
import { git } from "./git.js";

const PORT_BLOCK = 100;
const FIRST_BASE = 4100;

export function repoId(commonDir) {
  return createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
}

export function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function gitContext(cwd) {
  const toplevel = canonical(git(cwd, ["rev-parse", "--show-toplevel"]));
  const commonDir = canonical(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const gitDir = canonical(git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]));
  return {
    toplevel,
    commonDir,
    isPrimary: gitDir === commonDir,
  };
}

export function rangesOverlap(a, b) {
  return a <= b + PORT_BLOCK - 1 && b <= a + PORT_BLOCK - 1;
}

export function allocateBase(registry) {
  const bases = Object.values(registry.repos).map((repo) => repo.base);
  let base = FIRST_BASE;
  while (bases.some((used) => rangesOverlap(base, used))) base += PORT_BLOCK;
  if (base + PORT_BLOCK - 1 > 65535) {
    throw new WorkslotError("No free port block left in ~/.workslot");
  }
  return base;
}

export function findOverlap(registry, base, exceptId) {
  return Object.values(registry.repos).find(
    (repo) => repo.id !== exceptId && rangesOverlap(repo.base, base),
  );
}

export function slotPath(repo, n) {
  return join(dirname(repo.primary), `${repo.prefix}-${n}`);
}

export function slotPort(repo, n) {
  return repo.base + n;
}

export function detectDevCommand(dir) {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm dev";
  if (existsSync(join(dir, "package-lock.json")) || existsSync(join(dir, "npm-shrinkwrap.json"))) {
    return "npm run dev";
  }
  if (existsSync(join(dir, "yarn.lock"))) return "yarn dev";
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun run dev";
  return "pnpm dev";
}

export function installPlan(dir) {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) {
    return { cmd: "pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"] };
  }
  if (existsSync(join(dir, "package-lock.json")) || existsSync(join(dir, "npm-shrinkwrap.json"))) {
    return { cmd: "npm", args: ["ci"] };
  }
  if (existsSync(join(dir, "yarn.lock"))) {
    return { cmd: "yarn", args: ["install", "--frozen-lockfile"] };
  }
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) {
    return { cmd: "bun", args: ["install", "--frozen-lockfile"] };
  }
  return null;
}

export function formatInstall(plan) {
  if (!plan) return "none";
  return [plan.cmd, ...plan.args].join(" ");
}

export function untrackedEnvFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name === ".env" || name.startsWith(".env."))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    })
    .filter((name) => git(dir, ["ls-files", "--error-unmatch", "--", name], { allowFail: true }) === null)
    .sort();
}

export function copyEnvFiles(from, to) {
  const copied = [];
  for (const name of untrackedEnvFiles(from)) {
    const dest = join(to, name);
    if (existsSync(dest)) continue;
    copyFileSync(join(from, name), dest);
    copied.push(name);
  }
  return copied;
}

export function snapshotEnv(dir) {
  const snap = join(tmpdir(), `workslot-env-${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(snap, { recursive: true });
  const names = [];
  for (const name of readdirSync(dir)) {
    if (name !== ".env" && !name.startsWith(".env.")) continue;
    const source = join(dir, name);
    if (!statSync(source).isFile()) continue;
    writeFileSync(join(snap, name), readFileSync(source));
    names.push(name);
  }
  return { snap, names };
}

export function restoreEnv(dir, snapshot) {
  for (const name of snapshot.names) {
    const dest = join(dir, name);
    if (!existsSync(dest)) copyFileSync(join(snapshot.snap, name), dest);
  }
}

export function detectDefaultBranch(cwd) {
  const originHead = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    allowFail: true,
  });
  if (originHead?.startsWith("origin/")) return originHead.slice("origin/".length);
  for (const name of ["main", "master"]) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { allowFail: true }) !== null) {
      return name;
    }
  }
  const current = git(cwd, ["branch", "--show-current"]);
  if (current) return current;
  throw new WorkslotError("Cannot determine the default branch");
}

export function resolveStart(cwd) {
  const branch = detectDefaultBranch(cwd);
  const origin = `origin/${branch}`;
  if (git(cwd, ["rev-parse", "--verify", "--quiet", origin], { allowFail: true }) !== null) {
    return origin;
  }
  return branch;
}

export function detachAt(cwd, start) {
  if (git(cwd, ["switch", "--detach", start], { allowFail: true }) !== null) return;
  const sha = git(cwd, ["rev-parse", "--verify", start]);
  git(cwd, ["switch", "--detach", sha]);
}

export function worktreePaths(cwd) {
  const out = git(cwd, ["worktree", "list", "--porcelain"]);
  const paths = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(canonical(line.slice("worktree ".length)));
  }
  return paths;
}

function porcelainPath(line) {
  let file = line.slice(3);
  if (file.includes(" -> ")) file = file.split(" -> ").pop();
  file = file.trim();
  if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
  return file;
}

function isUntrackedRootEnv(line) {
  if (!line.startsWith("??")) return false;
  const file = porcelainPath(line);
  return file === ".env" || (file.startsWith(".env.") && !file.includes("/"));
}

export function isDirty(cwd) {
  const out = git(cwd, ["status", "--porcelain"]);
  if (!out) return false;
  return out.split("\n").some((line) => line && !isUntrackedRootEnv(line));
}

export function listeningPids(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  if (result.error) throw new WorkslotError("lsof is required to check whether a slot port is in use");
  if (result.status !== 0 && result.status !== 1) {
    throw new WorkslotError((result.stderr || "lsof failed").trim());
  }
  return (result.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

export function killPort(port) {
  const signal = (sig) => {
    for (const pid of listeningPids(port)) {
      try {
        process.kill(Number(pid), sig);
      } catch {
        // already gone
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && listeningPids(port).length > 0) sleepSync(50);
  signal("SIGKILL");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function inspectSlot(repo, n, trees) {
  const path = canonical(slotPath(repo, n));
  const name = `${repo.prefix}-${n}`;
  const port = slotPort(repo, n);
  const lock = repo.slots?.[String(n)] ?? null;
  const known = trees ? trees.has(path) : false;
  const base = {
    n,
    name,
    path,
    port,
    url: `http://localhost:${port}`,
    lock,
    branch: null,
    dirty: false,
    server: false,
    free: false,
    reason: "",
  };

  if (!existsSync(path) || (trees && !known)) {
    if (existsSync(path) && trees && !known) {
      return { ...base, reason: "path exists but is not a worktree of this repo" };
    }
    return { ...base, reason: "missing" };
  }

  let branch = null;
  try {
    branch = git(path, ["branch", "--show-current"]) || null;
  } catch (err) {
    return { ...base, reason: err.message };
  }
  const dirty = isDirty(path);
  const server = listeningPids(port).length > 0;
  const info = { ...base, branch, dirty, server };

  if (server) return { ...info, reason: "server running" };
  if (dirty) return { ...info, reason: "dirty" };
  if (branch) {
    if (lock) return { ...info, reason: `claimed by ${lock.holder} for ${lock.branch}` };
    return { ...info, reason: `on ${branch} with no lock` };
  }
  if (lock) {
    return {
      ...info,
      reason: `locked by ${lock.holder} for ${lock.branch}, but the worktree is detached. If that claim is abandoned: workslot release ${n} --force`,
    };
  }
  return { ...info, free: true, reason: "free" };
}

export function inspectRepo(repo) {
  let trees;
  try {
    trees = new Set(worktreePaths(repo.primary));
  } catch {
    trees = new Set();
  }
  const slots = [];
  for (let n = 1; n <= repo.count; n += 1) slots.push(inspectSlot(repo, n, trees));
  return slots;
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function slotNumberFromPath(repo, toplevel) {
  const match = new RegExp(`^${escapeRegex(repo.prefix)}-(\\d+)$`).exec(basename(toplevel));
  if (!match) return null;
  return Number(match[1]);
}
