import { spawnSync } from "node:child_process";
import { WorkslotError } from "./errors.js";

export function git(cwd, args, { allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new WorkslotError(`git failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFail) return null;
    const message = (result.stderr || result.stdout || "git failed").trim();
    throw new WorkslotError(message);
  }
  return (result.stdout || "").trim();
}

export function tryFetch(cwd) {
  const remotes = git(cwd, ["remote"]).split("\n").filter(Boolean);
  if (!remotes.includes("origin")) return;
  const result = spawnSync("git", ["fetch", "origin", "--prune"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    console.error(
      `warning: git fetch origin failed; using local refs${detail ? `\n${detail}` : ""}`,
    );
  }
}
