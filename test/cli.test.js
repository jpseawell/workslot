import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const cli = fileURLToPath(new URL("../bin/workslot.js", import.meta.url));
const trash = [];
let nextBase = 20000;

function keep(dir) {
  trash.push(dir);
  return dir;
}

function homeDir() {
  return keep(mkdtempSync(join(tmpdir(), "workslot-home-")));
}

function makeRepo() {
  const root = keep(mkdtempSync(join(tmpdir(), "workslot-repo-")));
  const repo = join(root, "app");
  mkdirSync(repo);
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "hi\n");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  writeFileSync(join(repo, ".env.local"), "LOCAL=1\n");
  writeFileSync(join(repo, ".env.example"), "SECRET=\n");
  git(["add", "README.md", ".gitignore", ".env.example"]);
  git(["commit", "-m", "init"]);
  return { root, repo };
}

function run(home, cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, HOME: home, USER: "tester" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

function branch(dir) {
  return execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim();
}

function field(stdout, name) {
  const match = stdout.match(new RegExp(`^${name}: (.+)$`, "m"));
  assert.ok(match, `missing ${name} in\n${stdout}`);
  return match[1];
}

after(() => {
  for (const dir of trash) rmSync(dir, { recursive: true, force: true });
});

test("init refuses a non-interactive run without --yes", async () => {
  const home = homeDir();
  const { root, repo } = makeRepo();
  const result = await run(home, repo, ["init", "--prefix", "st"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--yes/);
  assert.equal(existsSync(join(root, "st-1")), false);
  assert.equal(existsSync(join(repo, "AGENTS.md")), false);
  assert.equal(branch(repo), "main");
});

test("init creates sibling slots, copies env files, and leaves primary on main", async () => {
  const home = homeDir();
  const { root, repo } = makeRepo();
  const result = await run(home, repo, ["init", "--yes", "--prefix", "st", "--count", "2", "--dev", "pnpm dev"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(branch(repo), "main");
  assert.equal(branch(join(root, "st-1")), "");
  assert.equal(readFileSync(join(root, "st-1", ".env"), "utf8"), "SECRET=1\n");
  assert.equal(readFileSync(join(root, "st-1", ".env.local"), "utf8"), "LOCAL=1\n");
  assert.match(result.stdout, /copied env: \.env, \.env\.local/);
  assert.doesNotMatch(result.stdout, /\.env\.example/);
  assert.match(result.stdout, /port=4101/);
  assert.match(result.stdout, /port=4102/);

  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  assert.match(agents, /workslot claim/);
  assert.match(agents, /`st-1`, `st-2`/);
  assert.equal((agents.match(/workslot:start/g) || []).length, 1);
  const rule = readFileSync(join(repo, ".cursor/rules/workslot.mdc"), "utf8");
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, /4101–4102/);
  const slotStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: join(root, "st-1"),
    encoding: "utf8",
  });
  assert.doesNotMatch(slotStatus, /AGENTS\.md/);

  const again = await run(home, repo, ["init", "--yes", "--prefix", "st", "--count", "4"]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /workslot add/);
  assert.match(again.stderr, /workslot remove/);
  assert.equal(existsSync(join(root, "st-3")), false);
  assert.equal((readFileSync(join(repo, "AGENTS.md"), "utf8").match(/workslot:start/g) || []).length, 1);

  const fromSlot = await run(home, join(root, "st-1"), ["init", "--yes"]);
  assert.notEqual(fromSlot.status, 0);
  assert.match(fromSlot.stderr, /primary checkout/);
});

test("init keeps existing AGENTS.md text and refreshes the workslot section", async () => {
  const home = homeDir();
  const { repo } = makeRepo();
  writeFileSync(join(repo, "AGENTS.md"), "# Project\n\nBe careful.\n");
  const first = await run(home, repo, ["init", "--yes", "--prefix", "st", "--count", "1"]);
  assert.equal(first.status, 0, first.stderr);
  const widened = await run(home, repo, ["add", "--yes"]);
  assert.equal(widened.status, 0, widened.stderr);
  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  assert.match(agents, /^# Project\n\nBe careful\./);
  assert.match(agents, /`st-1`, `st-2`/);
  assert.equal((agents.match(/workslot:start/g) || []).length, 1);
  assert.equal((agents.match(/workslot:end/g) || []).length, 1);
});

test("init --no-agents leaves an existing AGENTS.md untouched", async () => {
  const home = homeDir();
  const { repo } = makeRepo();
  writeFileSync(join(repo, "AGENTS.md"), "Be careful.\n");
  const result = await run(home, repo, ["init", "--yes", "--no-agents", "--prefix", "st", "--count", "1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /leave AGENTS.md and \.cursor\/rules\/workslot.mdc unchanged/);
  assert.match(result.stdout, /agents: skipped/);
  assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), "Be careful.\n");
  assert.equal(existsSync(join(repo, ".cursor", "rules", "workslot.mdc")), false);
});

test("init creates two slots unless --count says otherwise", async () => {
  const home = homeDir();
  const { root, repo } = makeRepo();
  const result = await run(home, repo, ["init", "--yes", "--prefix", "st", "--no-agents"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, "st-1")), true);
  assert.equal(existsSync(join(root, "st-2")), true);
  assert.equal(existsSync(join(root, "st-3")), false);
});

test("add creates the next slot and remove deletes only the last one", async () => {
  const home = homeDir();
  const { root, repo } = makeRepo();
  assert.equal((await run(home, repo, ["init", "--yes", "--prefix", "st", "--count", "2"])).status, 0);
  const added = await run(home, repo, ["add", "--yes"]);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(existsSync(join(root, "st-3")), true);
  assert.equal(readFileSync(join(root, "st-3", ".env"), "utf8"), "SECRET=1\n");
  assert.match(readFileSync(join(repo, "AGENTS.md"), "utf8"), /`st-1`, `st-2`, `st-3`/);

  writeFileSync(join(root, "st-3", "scratch.txt"), "x\n");
  const dirty = await run(home, repo, ["remove", "--yes"]);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /uncommitted/);
  assert.equal(existsSync(join(root, "st-3")), true);

  const middle = await run(home, repo, ["remove", "1", "--yes"]);
  assert.notEqual(middle.status, 0);
  assert.match(middle.stderr, /workslot remove 3/);

  const removed = await run(home, repo, ["remove", "--force", "--yes"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(join(root, "st-3")), false);
  assert.equal(existsSync(join(root, "st-1")), true);
  assert.match(readFileSync(join(repo, "AGENTS.md"), "utf8"), /`st-1`, `st-2`/);
  assert.doesNotMatch(readFileSync(join(repo, "AGENTS.md"), "utf8"), /`st-3`/);

  const home2 = homeDir();
  const second = makeRepo();
  assert.equal((await run(home2, second.repo, ["init", "--yes", "--prefix", "only", "--count", "1", "--no-agents"])).status, 0);
  const last = await run(home2, second.repo, ["remove", "--yes"]);
  assert.notEqual(last.status, 0);
  assert.match(last.stderr, /last slot/);
  assert.equal(existsSync(join(second.root, "only-1")), true);
});

test("init refuses a prefix path that already exists", async () => {
  const home = homeDir();
  const { root, repo } = makeRepo();
  mkdirSync(join(root, "slot-1"));
  const result = await run(home, repo, ["init", "--yes"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/);
});

test("init rejects a prefix that escapes the parent directory", async () => {
  const home = homeDir();
  const { repo } = makeRepo();
  const result = await run(home, repo, ["init", "--yes", "--prefix", "../x"]);
  assert.equal(result.status, 2, result.stderr);
});

test("each repo gets its own port block", async () => {
  const home = homeDir();
  const first = makeRepo();
  const second = makeRepo();
  const third = makeRepo();
  assert.equal((await run(home, first.repo, ["init", "--yes", "--prefix", "aa", "--count", "1"])).status, 0);
  const next = await run(home, second.repo, ["init", "--yes", "--prefix", "bb", "--count", "1"]);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /ports 4200/);
  assert.match(next.stdout, /port=4201/);
  const overlap = await run(home, third.repo, ["init", "--yes", "--prefix", "cc", "--count", "1", "--base", "4100"]);
  assert.notEqual(overlap.status, 0);
  assert.match(overlap.stderr, /overlaps/);
});

test("claim locks the first open slot and a second claim takes the next one", async () => {
  const home = homeDir();
  const { root, repo } = makeRepo();
  assert.equal((await run(home, repo, ["init", "--yes", "--prefix", "st", "--count", "2"])).status, 0);

  const first = await run(home, repo, ["claim", "feature-a"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(field(first.stdout, "slot"), "1");
  assert.equal(realpathSync(field(first.stdout, "path")), realpathSync(join(root, "st-1")));
  assert.equal(branch(join(root, "st-1")), "feature-a");
  assert.equal(branch(repo), "main");
  const token = field(first.stdout, "token");

  const picked = await run(home, repo, ["claim", "feature-b", "--slot", "2"]);
  assert.equal(picked.status, 0, picked.stderr);
  assert.equal(field(picked.stdout, "slot"), "2");

  const full = await run(home, repo, ["claim", "feature-c"]);
  assert.equal(full.status, 1, full.stdout);
  assert.match(full.stderr, /No open slot/);

  const wrong = await run(home, repo, ["release", "1", "--token", "nope"]);
  assert.notEqual(wrong.status, 0);
  assert.equal(branch(join(root, "st-1")), "feature-a");

  writeFileSync(join(root, "st-1", "scratch.txt"), "x\n");
  writeFileSync(join(root, "st-1", "README.md"), "changed\n");
  const dirty = await run(home, repo, ["release", "1", "--token", token]);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /uncommitted/);
  assert.equal(branch(join(root, "st-1")), "feature-a");

  const wiped = await run(home, repo, ["reset", "1", "--token", token, "--yes"]);
  assert.equal(wiped.status, 0, wiped.stderr);
  assert.equal(branch(join(root, "st-1")), "");
  assert.equal(existsSync(join(root, "st-1", "scratch.txt")), false);
  assert.equal(readFileSync(join(root, "st-1", "README.md"), "utf8"), "hi\n");
  assert.equal(readFileSync(join(root, "st-1", ".env"), "utf8"), "SECRET=1\n");
  assert.equal(readFileSync(join(root, "st-1", ".env.local"), "utf8"), "LOCAL=1\n");
  assert.equal(branch(repo), "main");
  assert.match(
    execFileSync("git", ["branch", "--list", "feature-a"], { cwd: repo, encoding: "utf8" }),
    /feature-a/,
  );

  const again = await run(home, repo, ["claim", "feature-a"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(branch(field(again.stdout, "path")), "feature-a");
  const againToken = field(again.stdout, "token");
  const released = await run(home, repo, ["release", field(again.stdout, "slot"), "--token", againToken]);
  assert.equal(released.status, 0, released.stderr);
  assert.equal(branch(field(again.stdout, "path")), "");
  assert.match(
    execFileSync("git", ["branch", "--list", "feature-a"], { cwd: repo, encoding: "utf8" }),
    /feature-a/,
  );
});

test("parallel claims take different slots", async () => {
  const home = homeDir();
  const { repo } = makeRepo();
  assert.equal((await run(home, repo, ["init", "--yes", "--prefix", "st", "--count", "2"])).status, 0);
  const [a, b] = await Promise.all([
    run(home, repo, ["claim", "one"]),
    run(home, repo, ["claim", "two"]),
  ]);
  assert.equal(a.status, 0, a.stderr + b.stderr);
  assert.equal(b.status, 0, b.stderr + a.stderr);
  const slots = [field(a.stdout, "slot"), field(b.stdout, "slot")].sort();
  assert.deepEqual(slots, ["1", "2"]);
});

test("a parallel claim fails closed when the only slot is taken", async () => {
  const home = homeDir();
  const { repo } = makeRepo();
  assert.equal((await run(home, repo, ["init", "--yes", "--prefix", "st", "--count", "1"])).status, 0);
  const [a, b] = await Promise.all([
    run(home, repo, ["claim", "one"]),
    run(home, repo, ["claim", "two"]),
  ]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [0, 1], `${a.stderr}\n${b.stderr}`);
});

test("status json omits the claim token", async () => {
  const home = homeDir();
  const { repo } = makeRepo();
  assert.equal((await run(home, repo, ["init", "--yes", "--prefix", "st", "--count", "1"])).status, 0);
  const claimed = await run(home, repo, ["claim", "feature-a"]);
  assert.equal(claimed.status, 0, claimed.stderr);
  const result = await run(home, repo, ["status", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.slots[0].holder, "tester");
  assert.equal(body.slots[0].claimedBranch, "feature-a");
  assert.equal(body.slots[0].free, false);
  assert.equal(JSON.stringify(body).includes(field(claimed.stdout, "token")), false);
});

test("dev dry-run is safe from the primary checkout and a real run requires the token", async () => {
  const home = homeDir();
  const base = nextBase;
  nextBase += 100;
  const { root, repo } = makeRepo();
  const devCommand = `node -e 'process.exit(process.env.PORT==="${base + 1}"?0:4)'`;
  const created = await run(home, repo, [
    "init", "--yes", "--prefix", "st", "--count", "1", "--base", String(base), "--dev", devCommand,
  ]);
  assert.equal(created.status, 0, created.stderr);
  writeFileSync(join(root, "st-1", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const dry = await run(home, repo, ["dev", "1", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN/);
  assert.match(dry.stdout, new RegExp(`port:\\s+${base + 1} \\(free\\)`));
  assert.match(dry.stdout, /pnpm install --frozen-lockfile --prefer-offline/);
  assert.match(dry.stdout, /nothing started/);

  const inside = await run(home, join(root, "st-1"), ["dev", "--dry-run"]);
  assert.equal(inside.status, 0, inside.stderr);
  unlinkSync(join(root, "st-1", "pnpm-lock.yaml"));

  const denied = await run(home, repo, ["dev", "1"]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /no claim/);

  const claimed = await run(home, repo, ["claim", "feature-a"]);
  assert.equal(claimed.status, 0, claimed.stderr);
  const token = field(claimed.stdout, "token");
  const wrong = await run(home, repo, ["dev", "1", "--token", "nope"]);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /Token/);
  const insideDenied = await run(home, join(root, "st-1"), ["dev"]);
  assert.notEqual(insideDenied.status, 0);
  assert.match(insideDenied.stderr, /Token/);

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(base + 1, "127.0.0.1", resolve);
  });
  try {
    const busy = await run(home, repo, ["dev", "1", "--dry-run"]);
    assert.match(busy.stdout, /in use/);
    const blocked = await run(home, repo, ["dev", "1", "--token", token]);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /already in use/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const started = await run(home, repo, ["dev", "1", "--token", token]);
  assert.equal(started.status, 0, started.stderr);
});
