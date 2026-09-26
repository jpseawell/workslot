import { readFileSync } from "node:fs";
import { WorkslotError } from "./errors.js";
import { claim, dev, init, release, reset, status } from "./commands.js";

const help = `workslot — permanent git worktree slots

  workslot init [--prefix slot] [--count 3] [--base N] [--dev CMD] [--port-env PORT] [--yes]
  workslot status [--json]
  workslot claim <branch> [--slot N]
  workslot release [n] [--token T] [--force]
  workslot reset [n] [--token T] [--force] [--yes]
  workslot dev [n] [--token T] [--dry-run]

Slots are sibling directories of the primary checkout (../slot-1 by default).
The primary checkout stays on the default branch. Each repo on this machine
gets its own hundred-port block, starting at 4100. Slot N listens on base+N.

From the primary checkout, claim locks the first open slot and prints its
path and token. Pass that token to dev, release, and reset so another session
cannot take or clear the slot.
`;

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (["yes", "force", "dry-run", "json", "help", "version"].includes(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new WorkslotError(`Missing value for --${key}`, 2);
    }
    flags[key] = value;
    i += 1;
  }
  return { positionals, flags };
}

function version() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return pkg.version;
}

export async function main(argv) {
  const { positionals, flags } = parseArgs(argv);
  if (flags.help || positionals[0] === "help") {
    console.log(help.trimEnd());
    return 0;
  }
  if (flags.version) {
    console.log(version());
    return 0;
  }
  const [command, ...rest] = positionals;
  if (!command) {
    console.log(help.trimEnd());
    return 0;
  }
  switch (command) {
    case "init":
      if (rest.length) throw new WorkslotError("workslot init takes no positional arguments", 2);
      await init(process.cwd(), flags);
      return 0;
    case "status":
      if (rest.length) throw new WorkslotError("workslot status takes no positional arguments", 2);
      status(process.cwd(), flags);
      return 0;
    case "claim":
      claim(process.cwd(), rest[0], flags);
      return 0;
    case "release":
      await release(process.cwd(), rest[0], flags);
      return 0;
    case "reset":
      await reset(process.cwd(), rest[0], flags);
      return 0;
    case "dev":
      return await dev(process.cwd(), rest[0], flags);
    default:
      throw new WorkslotError(`Unknown command: ${command}\n\n${help.trimEnd()}`, 2);
  }
}
