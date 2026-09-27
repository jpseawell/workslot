import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { installAgentInstructions } from "./agents.js";
import { WorkslotError } from "./errors.js";
import { git, tryFetch } from "./git.js";
import { readRegistry, updateRegistry } from "./registry.js";
import {
  allocateBase,
  canonical,
  copyEnvFiles,
  detachAt,
  detectDefaultBranch,
  detectDevCommand,
  findOverlap,
  formatInstall,
  gitContext,
  inspectRepo,
  inspectSlot,
  installPlan,
  killPort,
  listeningPids,
  repoId,
  resolveStart,
  restoreEnv,
  slotNumberFromPath,
  snapshotEnv,
  worktreePaths,
} from "./slots.js";

function liveRepo(registry, id) {
  const repo = registry.repos[id];
  if (!repo) throw new WorkslotError("This repo is not initialized. From the primary checkout, run: workslot init");
  return repo;
}

export function locate(cwd = process.cwd()) {
  const ctx = gitContext(cwd);
  const registry = readRegistry();
  const repo = Object.values(registry.repos).find((entry) => entry.commonDir === ctx.commonDir);
  if (!repo) {
    throw new WorkslotError("This repo is not initialized. From the primary checkout, run: workslot init");
  }
  const slotNumber = ctx.isPrimary ? null : slotNumberFromPath(repo, ctx.toplevel);
  if (!ctx.isPrimary && !slotNumber) {
    throw new WorkslotError(
      `This worktree is not a ${repo.prefix}-N slot. Work in ${repo.prefix}-1 or the primary checkout.`,
    );
  }
  if (slotNumber && (slotNumber < 1 || slotNumber > repo.count)) {
    throw new WorkslotError(`${repo.prefix}-${slotNumber} is outside this repo's slot count (${repo.count})`);
  }
  return { ctx, repo, slotNumber };
}

function integer(value, name, { min, max }) {
  if (!/^[0-9]+$/.test(String(value))) {
    throw new WorkslotError(`${name} must be an integer`, 2);
  }
  const n = Number(value);
  if (n < min || n > max) throw new WorkslotError(`${name} must be between ${min} and ${max}`, 2);
  return n;
}

function resolveSlotArg(located, slotArg) {
  if (slotArg === undefined) {
    if (!located.slotNumber) {
      throw new WorkslotError("Pass a slot number. From the primary checkout the slot is not implied.", 2);
    }
    return located.slotNumber;
  }
  return integer(slotArg, "slot", { min: 1, max: located.repo.count });
}

function providedToken(flags) {
  return flags.token || process.env.WORKSLOT_TOKEN || "";
}

function assertToken(repo, n, flags) {
  const lock = repo.slots?.[String(n)] ?? null;
  if (flags.force) return lock;
  if (!lock) {
    throw new WorkslotError(
      `${repo.prefix}-${n} has no claim. Pass --force to override a missing lock.`,
    );
  }
  const token = providedToken(flags);
  if (!token || token !== lock.token) {
    throw new WorkslotError(
      `Token does not match the claim on ${repo.prefix}-${n}. Pass --token from \`workslot claim\`, or --force to override.`,
    );
  }
  return lock;
}

async function confirm(question, defaultYes) {
  if (!input.isTTY) return null;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function requireYes(flags, prompt) {
  if (flags.yes) return;
  throw new WorkslotError(`${prompt}\nRe-run with --yes to proceed.`, 2);
}

export function validatePrefix(prefix) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix) || /[.-]$/.test(prefix) || prefix.includes("..")) {
    throw new WorkslotError(
      "Prefix must start with a letter or number and contain only letters, numbers, dots, underscores, and dashes.",
      2,
    );
  }
}

function validateDev(dev) {
  if (!dev || !dev.trim()) throw new WorkslotError("--dev must be a command", 2);
}

function validatePortEnv(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new WorkslotError("--port-env must be an environment variable name", 2);
  }
}

function planLines(plan) {
  const end = plan.base + 99;
  const lines = [
    "Workslot will create:",
    `  ~/.workslot/ registry entry (ports ${plan.base}–${end})`,
  ];
  for (const slot of plan.slots) {
    const state = slot.already ? "already exists" : "new worktree";
    lines.push(`  ${slot.path}  port ${slot.port}  (${state})`);
  }
  lines.push("It will copy untracked env files from the primary checkout into each new slot.");
  if (plan.writeAgents) {
    lines.push("It will add agent instructions to AGENTS.md and .cursor/rules/workslot.mdc.");
  } else {
    lines.push("It will leave AGENTS.md and .cursor/rules/workslot.mdc unchanged.");
  }
  lines.push(`The primary checkout stays on ${plan.defaultBranch}.`);
  lines.push(`Dev command: ${plan.devCommand}  (${plan.portEnv})`);
  return lines;
}

function buildPlan(cwd, flags) {
  const ctx = gitContext(cwd);
  if (!ctx.isPrimary) {
    throw new WorkslotError("Run workslot init from the primary checkout, not from a slot.");
  }
  const registry = readRegistry();
  const id = repoId(ctx.commonDir);
  const existing = registry.repos[id] ?? null;
  const prefix = flags.prefix ?? existing?.prefix ?? "slot";
  const count = flags.count !== undefined ? integer(flags.count, "--count", { min: 1, max: 20 }) : (existing?.count ?? 2);
  const devCommand = flags.dev ?? existing?.devCommand ?? detectDevCommand(ctx.toplevel);
  const portEnv = flags["port-env"] ?? existing?.portEnv ?? "PORT";
  validatePrefix(prefix);
  validateDev(devCommand);
  validatePortEnv(portEnv);

  let base = existing?.base ?? null;
  if (flags.base !== undefined) {
    base = integer(flags.base, "--base", { min: 1024, max: 65436 });
  }
  if (base === null) base = allocateBase(registry);
  const overlap = findOverlap(registry, base, id);
  if (overlap) {
    throw new WorkslotError(
      `Port base ${base} overlaps ${overlap.primary} (base ${overlap.base}). Pick another --base, or omit it to take the next free block.`,
    );
  }
  if (existing && flags.prefix && flags.prefix !== existing.prefix) {
    throw new WorkslotError(
      `This repo already uses prefix ${existing.prefix}. Remove those worktrees before changing it.`,
    );
  }
  if (existing && flags.base !== undefined && Number(flags.base) !== existing.base) {
    throw new WorkslotError(
      `This repo already uses port base ${existing.base}. Slot ports stay fixed once created.`,
    );
  }
  const defaultBranch = detectDefaultBranch(ctx.toplevel);
  const slots = [];
  const trees = new Set(worktreePaths(ctx.toplevel));
  for (let n = 1; n <= count; n += 1) {
    const path = slotPathOf(ctx.toplevel, prefix, n);
    const key = canonical(path);
    if (existsSync(path) && !trees.has(key)) {
      throw new WorkslotError(
        `${path} already exists and is not a worktree of this repo. Re-run with a different --prefix.`,
      );
    }
    slots.push({
      n,
      name: `${prefix}-${n}`,
      path,
      port: base + n,
      already: trees.has(key),
    });
  }

  return {
    ctx,
    id,
    existing,
    prefix,
    count,
    base,
    devCommand,
    portEnv,
    defaultBranch,
    slots,
    writeAgents: !flags["no-agents"],
  };
}

function slotPathOf(primary, prefix, n) {
  return join(dirname(primary), `${prefix}-${n}`);
}

function requirePrimary(located, command) {
  if (!located.ctx.isPrimary) {
    throw new WorkslotError(`Run workslot ${command} from the primary checkout, not from a slot.`);
  }
}

function planFromRepo(repo) {
  const slots = [];
  for (let n = 1; n <= repo.count; n += 1) {
    slots.push({
      n,
      name: `${repo.prefix}-${n}`,
      path: slotPathOf(repo.primary, repo.prefix, n),
      port: repo.base + n,
    });
  }
  return {
    slots,
    count: repo.count,
    prefix: repo.prefix,
    defaultBranch: repo.defaultBranch,
    devCommand: repo.devCommand,
    portEnv: repo.portEnv,
  };
}

function reportAgents(repo, flags) {
  if (flags["no-agents"]) {
    console.log("agents: skipped");
    return;
  }
  const agents = installAgentInstructions(repo.primary, planFromRepo(repo));
  const state = agents.changed ? "updated" : "unchanged";
  console.log(`agents: ${state} ${agents.agentsPath}`);
  console.log(`agents: ${state} ${agents.rulePath}`);
}

export async function init(cwd, flags) {
  const plan = buildPlan(cwd, flags);
  if (plan.existing) {
    const names = Array.from({ length: plan.existing.count }, (_, index) => `${plan.existing.prefix}-${index + 1}`);
    throw new WorkslotError(
      `This repo already has ${plan.existing.count} ${plan.existing.count === 1 ? "slot" : "slots"}: ${names.join(", ")}.\n` +
      "Add one: workslot add\n" +
      "Remove the last: workslot remove",
    );
  }
  const preview = planLines(plan).join("\n");
  console.log(preview);
  if (!flags.yes) {
    const accepted = await confirm("Continue? [Y/n] ", true);
    if (accepted === null) requireYes(flags, "Init was not confirmed.");
    if (accepted === false) throw new WorkslotError("Aborted.", 2);
  }

  updateRegistry((registry) => {
    registry.repos[plan.id] = {
      id: plan.id,
      commonDir: plan.ctx.commonDir,
      primary: plan.ctx.toplevel,
      prefix: plan.prefix,
      count: plan.count,
      base: plan.base,
      devCommand: plan.devCommand,
      portEnv: plan.portEnv,
      defaultBranch: plan.defaultBranch,
      slots: plan.existing?.slots ?? {},
    };
  });

  tryFetch(plan.ctx.toplevel);
  const start = resolveStart(plan.ctx.toplevel);
  const copied = new Set();
  let created = 0;
  for (const slot of plan.slots) {
    if (!slot.already) {
      git(plan.ctx.toplevel, ["worktree", "add", "--detach", slot.path, start]);
      created += 1;
    }
    for (const name of copyEnvFiles(plan.ctx.toplevel, slot.path)) copied.add(name);
  }

  console.log("");
  console.log(`Initialized ${plan.ctx.toplevel}`);
  console.log(`primary: ${plan.ctx.toplevel} stays on ${plan.defaultBranch}`);
  for (const slot of plan.slots) {
    console.log(`slot: ${slot.n} name=${slot.name} path=${slot.path} port=${slot.port}`);
  }
  console.log(`created: ${created}`);
  console.log(`copied env: ${copied.size ? [...copied].join(", ") : "none"}`);
  if (plan.writeAgents) {
    const agents = installAgentInstructions(plan.ctx.toplevel, plan);
    const state = agents.changed ? "updated" : "unchanged";
    console.log(`agents: ${state} ${agents.agentsPath}`);
    console.log(`agents: ${state} ${agents.rulePath}`);
    console.error("Commit AGENTS.md and .cursor/rules/workslot.mdc on the default branch so agents claim a slot before editing.");
  } else {
    console.log("agents: skipped");
  }
  console.error("Claim a slot from this checkout with: workslot claim <branch>");
}

export async function add(cwd, flags) {
  const located = locate(cwd);
  requirePrimary(located, "add");
  if (located.repo.count >= 20) {
    throw new WorkslotError("Refusing to add a 21st slot.");
  }
  const n = located.repo.count + 1;
  const path = slotPathOf(located.repo.primary, located.repo.prefix, n);
  const port = located.repo.base + n;
  const name = `${located.repo.prefix}-${n}`;
  const trees = new Set(worktreePaths(located.repo.primary));
  if (existsSync(path) && !trees.has(canonical(path))) {
    throw new WorkslotError(`${path} already exists and is not a worktree of this repo.`);
  }
  if (trees.has(canonical(path))) {
    throw new WorkslotError(`${name} already exists.`);
  }
  const lines = [
    "Workslot will create:",
    `  ${path}  port ${port}`,
    "It will copy untracked env files from the primary checkout.",
    flags["no-agents"]
      ? "It will leave AGENTS.md and .cursor/rules/workslot.mdc unchanged."
      : "It will update AGENTS.md and .cursor/rules/workslot.mdc.",
  ];
  console.log(lines.join("\n"));
  if (!flags.yes) {
    const accepted = await confirm("Continue? [Y/n] ", true);
    if (accepted === null) requireYes(flags, "Add was not confirmed.");
    if (accepted === false) throw new WorkslotError("Aborted.", 2);
  }

  updateRegistry((registry) => {
    liveRepo(registry, located.repo.id).count = n;
  });
  try {
    const start = resolveStart(located.repo.primary);
    git(located.repo.primary, ["worktree", "add", "--detach", path, start]);
    const copied = copyEnvFiles(located.repo.primary, path);
    console.log(`added: ${n}`);
    console.log(`name: ${name}`);
    console.log(`path: ${path}`);
    console.log(`port: ${port}`);
    console.log(`copied env: ${copied.length ? copied.join(", ") : "none"}`);
    const repo = { ...located.repo, count: n };
    reportAgents(repo, flags);
  } catch (err) {
    updateRegistry((registry) => {
      const repo = liveRepo(registry, located.repo.id);
      if (repo.count === n) repo.count = n - 1;
    });
    throw err;
  }
}

export async function remove(cwd, slotArg, flags) {
  const located = locate(cwd);
  requirePrimary(located, "remove");
  const last = located.repo.count;
  if (last <= 1) {
    throw new WorkslotError("Refusing to remove the last slot.");
  }
  const n = slotArg === undefined ? last : integer(slotArg, "slot", { min: 1, max: last });
  if (n !== last) {
    throw new WorkslotError(
      `Only the last slot can be removed, so earlier ports stay put. Run: workslot remove ${last}`,
    );
  }
  const trees = new Set(worktreePaths(located.repo.primary));
  const info = inspectSlot(located.repo, n, trees);
  const name = `${located.repo.prefix}-${n}`;
  if (info.reason === "missing" || info.reason.startsWith("path exists")) {
    throw new WorkslotError(`${name}: ${info.reason}`);
  }
  if (info.server && !flags.force) {
    throw new WorkslotError(`${name} has a server on port ${info.port}. Stop it, or re-run with --force.`);
  }
  if (info.dirty && !flags.force) {
    throw new WorkslotError(`${name} has uncommitted changes. Commit them, or re-run with --force --yes to delete the worktree.`);
  }
  if (info.lock && !flags.force) {
    throw new WorkslotError(`${name} is claimed by ${info.lock.holder} for ${info.lock.branch}. Release it, or re-run with --force.`);
  }
  console.log(`Remove ${name} at ${info.path}?`);
  console.log("This deletes that worktree. Branches already committed are kept.");
  if (!flags.yes) {
    const accepted = await confirm("Continue? [y/N] ", false);
    if (accepted === null) requireYes(flags, "Remove was not confirmed.");
    if (!accepted) throw new WorkslotError("Aborted.", 2);
  }
  if (info.server) killPort(info.port);
  git(located.repo.primary, ["worktree", "remove", "--force", info.path]);
  updateRegistry((registry) => {
    const repo = liveRepo(registry, located.repo.id);
    repo.count = n - 1;
    if (repo.slots) delete repo.slots[String(n)];
  });
  console.log(`removed: ${n}`);
  console.log(`name: ${name}`);
  console.log(`path: ${info.path}`);
  reportAgents({ ...located.repo, count: n - 1 }, flags);
}

function formatStatus(located) {
  const slots = inspectRepo(located.repo);
  const lockWidth = Math.max(4, ...slots.map((slot) => lockLabel(slot).length));
  const nameWidth = Math.max(4, ...slots.map((slot) => slot.name.length));
  const lines = [
    `primary  ${located.repo.primary}`,
    `prefix   ${located.repo.prefix}`,
    `base     ${located.repo.base}`,
    `dev      ${located.repo.devCommand} (${located.repo.portEnv})`,
    "",
    `${pad("SLOT", nameWidth)}  ${pad("BRANCH", 28)}  ${pad("DIRTY", 5)}  ${pad("PORT", 6)}  ${pad("LOCK", lockWidth)}  SERVER`,
  ];
  for (const slot of slots) {
    const branch = slot.branch || (existsBranchless(slot) ? "(detached)" : "-");
    const dirty = slot.reason === "missing" ? "-" : slot.dirty ? "yes" : "clean";
    const server = slot.server ? `UP ${slot.url}` : "down";
    lines.push(
      `${pad(slot.name, nameWidth)}  ${pad(branch, 28)}  ${pad(dirty, 5)}  ${pad(String(slot.port), 6)}  ${pad(lockLabel(slot), lockWidth)}  ${server}`,
    );
  }
  return lines.join("\n");
}

function existsBranchless(slot) {
  return slot.reason !== "missing" && !slot.reason.startsWith("path exists");
}

function lockLabel(slot) {
  if (!slot.lock) return "free";
  if (!slot.branch && !slot.dirty && !slot.server) return `${slot.lock.holder} abandoned`;
  return slot.lock.holder;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function status(cwd, flags) {
  const located = locate(cwd);
  if (flags.json) {
    const slots = inspectRepo(located.repo).map((slot) => ({
      slot: slot.n,
      name: slot.name,
      path: slot.path,
      branch: slot.branch,
      dirty: slot.dirty,
      port: slot.port,
      url: slot.url,
      server: slot.server ? "up" : "down",
      free: slot.free,
      reason: slot.reason,
      holder: slot.lock?.holder ?? null,
      claimedBranch: slot.lock?.branch ?? null,
      claimedAt: slot.lock?.claimedAt ?? null,
    }));
    console.log(JSON.stringify({
      primary: located.repo.primary,
      prefix: located.repo.prefix,
      count: located.repo.count,
      base: located.repo.base,
      devCommand: located.repo.devCommand,
      portEnv: located.repo.portEnv,
      slots,
    }, null, 2));
    return;
  }
  console.log(formatStatus(located));
}

function checkoutBranch(slotPath, branch, start) {
  const exists = git(slotPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    allowFail: true,
  });
  if (exists === null) {
    git(slotPath, ["switch", "-c", branch, start]);
    return true;
  }
  git(slotPath, ["switch", branch]);
  return false;
}

function claimBase(primary, override) {
  if (override) {
    if (git(primary, ["rev-parse", "--verify", "--quiet", override], { allowFail: true }) === null) {
      throw new WorkslotError(`Base ref not found: ${override}`, 2);
    }
    return override;
  }
  const current = git(primary, ["branch", "--show-current"]);
  if (current) return current;
  return resolveStart(primary);
}

export function claim(cwd, branch, flags) {
  if (!branch) throw new WorkslotError("Usage: workslot claim <branch> [--slot N] [--base <ref>]", 2);
  const located = locate(cwd);
  const normalized = git(located.ctx.toplevel, ["check-ref-format", "--branch", branch]);
  const requested = flags.slot ? integer(flags.slot, "--slot", { min: 1, max: located.repo.count }) : null;
  const start = claimBase(located.repo.primary, flags.base);
  tryFetch(located.repo.primary);

  const token = randomBytes(8).toString("hex");
  const holder = process.env.USER || "unknown";
  const claimedAt = new Date().toISOString();

  const picked = updateRegistry((registry) => {
    const repo = liveRepo(registry, located.repo.id);
    const trees = new Set(worktreePaths(repo.primary));
    const nums = requested ? [requested] : Array.from({ length: repo.count }, (_, i) => i + 1);
    const blocked = [];
    for (const n of nums) {
      const info = inspectSlot(repo, n, trees);
      if (!info.free) {
        blocked.push(info);
        continue;
      }
      repo.slots ??= {};
      repo.slots[String(n)] = { token, branch: normalized, claimedAt, holder };
      return { info, blocked: null };
    }
    return { info: null, blocked };
  });

  if (!picked.info) {
    const lines = ["No open slot."];
    for (const info of picked.blocked) lines.push(`  ${info.name}: ${info.reason}`);
    if (!requested) lines.push("Release a finished slot, or add one with: workslot add");
    throw new WorkslotError(lines.join("\n"));
  }

  const info = picked.info;
  let created = false;
  try {
    created = checkoutBranch(info.path, normalized, start);
  } catch (err) {
    updateRegistry((registry) => {
      const repo = liveRepo(registry, located.repo.id);
      if (repo.slots[String(info.n)]?.token === token) delete repo.slots[String(info.n)];
    });
    throw new WorkslotError(`Could not check out ${normalized} in ${info.name}. The lock was released.\n${err.message}`);
  }

  console.log(`slot: ${info.n}`);
  console.log(`name: ${info.name}`);
  console.log(`path: ${info.path}`);
  console.log(`branch: ${normalized}`);
  console.log(`base: ${start}`);
  console.log(`port: ${info.port}`);
  console.log(`url: ${info.url}`);
  console.log(`token: ${token}`);
  console.error(`Claimed ${info.name} on ${normalized} from ${start}.`);
  if (!created) console.error(`Checked out existing ${normalized}. It was not recreated from ${start}.`);
  console.error(`Do all edits and git commands in ${info.path}. The primary checkout stays on its current branch.`);
  console.error(`Dev server: workslot dev ${info.n} --token ${token}`);
  console.error(`Release: workslot release ${info.n} --token ${token}`);
}

export async function release(cwd, slotArg, flags) {
  const located = locate(cwd);
  const n = resolveSlotArg(located, slotArg);
  const trees = new Set(worktreePaths(located.repo.primary));
  const info = inspectSlot(located.repo, n, trees);
  if (info.reason === "missing" || info.reason.startsWith("path exists")) {
    throw new WorkslotError(`${info.name}: ${info.reason}`);
  }

  const lock = located.repo.slots?.[String(n)] ?? null;
  if (!lock && !flags.force) {
    if (!info.branch && !info.dirty) {
      console.log(`released: ${n}`);
      console.log(`path: ${info.path}`);
      console.error(
        info.server
          ? `${info.name} has no claim. Its server is still up at ${info.url}.`
          : `${info.name} is already free.`,
      );
      return;
    }
    throw new WorkslotError(
      `${info.name} is ${info.branch ? `on ${info.branch}` : "dirty"} with no lock. Re-run with --force to detach it. The branch is kept.`,
    );
  }
  if (lock && !flags.force && !tokenMatches(lock, flags)) {
    throw new WorkslotError(
      `Token does not match the claim on ${info.name} (${lock.holder}, ${lock.branch}). Pass --token from claim, or --force.`,
    );
  }
  if (info.dirty) {
    throw new WorkslotError(
      `${info.name} has uncommitted changes. Commit or stash them, or discard them with: workslot reset ${n} ${flags.force ? "--force" : "--token <token>"} --yes`,
    );
  }

  killPort(info.port);
  const start = resolveStart(located.repo.primary);
  detachAt(info.path, start);
  clearLock(located.repo.id, n, flags, lock?.token);
  const kept = lock?.branch || info.branch;
  console.log(`released: ${n}`);
  console.log(`name: ${info.name}`);
  console.log(`path: ${info.path}`);
  console.error(
    kept
      ? `${info.name} is detached on ${start} and unlocked. Branch ${kept} was kept.`
      : `${info.name} is detached on ${start} and unlocked.`,
  );
}

function tokenMatches(lock, flags) {
  const token = providedToken(flags);
  return Boolean(token) && token === lock.token;
}

function clearLock(id, n, flags, expectedToken) {
  updateRegistry((registry) => {
    const repo = liveRepo(registry, id);
    repo.slots ??= {};
    const current = repo.slots[String(n)];
    if (!current) return;
    if (flags.force || (expectedToken && current.token === expectedToken)) {
      delete repo.slots[String(n)];
    }
  });
}

export async function reset(cwd, slotArg, flags) {
  const located = locate(cwd);
  const n = resolveSlotArg(located, slotArg);
  const trees = new Set(worktreePaths(located.repo.primary));
  const info = inspectSlot(located.repo, n, trees);
  if (info.reason === "missing" || info.reason.startsWith("path exists")) {
    throw new WorkslotError(`${info.name}: ${info.reason}`);
  }
  const lock = assertToken(located.repo, n, flags);
  const branch = info.branch || lock?.branch || "(detached)";
  const preview = [
    `Reset ${info.name} at ${info.path}?`,
    "This discards uncommitted changes, detaches onto the default branch, and unlocks the slot.",
    `The branch ${branch} is kept.`,
    "Continue? [y/N] ",
  ];
  if (!flags.yes) {
    console.log(preview.slice(0, 3).join("\n"));
    const accepted = await confirm(preview[3], false);
    if (accepted === null) requireYes(flags, "Reset was not confirmed.");
    if (!accepted) throw new WorkslotError("Aborted.", 2);
  }

  killPort(info.port);
  const snapshot = snapshotEnv(info.path);
  try {
    git(info.path, ["reset", "--hard"]);
    git(info.path, ["clean", "-fd"]);
    restoreEnv(info.path, snapshot);
    const start = resolveStart(located.repo.primary);
    detachAt(info.path, start);
  } finally {
    rmSync(snapshot.snap, { recursive: true, force: true });
  }
  clearLock(located.repo.id, n, flags, lock?.token);
  console.log(`reset: ${n}`);
  console.log(`name: ${info.name}`);
  console.log(`path: ${info.path}`);
  console.error(`${info.name} is clean, detached, and unlocked.`);
}

export async function dev(cwd, slotArg, flags) {
  const located = locate(cwd);
  const n = resolveSlotArg(located, slotArg);
  const trees = new Set(worktreePaths(located.repo.primary));
  const info = inspectSlot(located.repo, n, trees);
  if (info.reason === "missing" || info.reason.startsWith("path exists")) {
    throw new WorkslotError(`${info.name}: ${info.reason}`);
  }
  if (!flags["dry-run"]) assertToken(located.repo, n, flags);

  const install = installPlan(info.path);
  const portState = listeningPids(info.port).length > 0 ? "in use" : "free";
  if (flags["dry-run"]) {
    console.log(`[${info.name}] DRY RUN — nothing started, no files touched`);
    console.log(`  path:    ${info.path}`);
    console.log(`  branch:  ${info.branch || "(detached)"}`);
    console.log(`  port:    ${info.port} (${portState})`);
    console.log(`  env:     ${located.repo.portEnv}=${info.port}`);
    console.log(`  install: ${formatInstall(install)}`);
    console.log(`  command: ${located.repo.devCommand}`);
    return;
  }
  if (portState === "in use") {
    throw new WorkslotError(`port ${info.port} is already in use — is ${info.name}'s server already running?`);
  }

  console.error(`[${info.name}] branch=${info.branch || "(detached)"} port=${info.port}`);
  if (install) {
    console.error(`[${info.name}] ${formatInstall(install)}`);
    const installed = spawnSync(install.cmd, install.args, { cwd: info.path, stdio: "inherit" });
    if (installed.error) {
      throw new WorkslotError(`Could not run ${install.cmd}: ${installed.error.message}`);
    }
    if (installed.status !== 0) throw new WorkslotError(`${formatInstall(install)} failed in ${info.name}`);
  }
  console.error(`[${info.name}] ${located.repo.portEnv}=${info.port}`);
  console.error(`[${info.name}] ${info.url}`);

  const child = spawn("sh", ["-c", located.repo.devCommand], {
    cwd: info.path,
    stdio: "inherit",
    env: { ...process.env, [located.repo.portEnv]: String(info.port) },
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  const code = await new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("exit", (status, signal) => resolvePromise(signal ? 1 : status ?? 1));
  });
  return code ?? 1;
}
