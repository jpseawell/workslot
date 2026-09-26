# workslot

Permanent git worktree slots for parallel local development. One primary checkout stays on the default branch. Tasks run in sibling worktrees (`slot-1`, `slot-2`, …) on fixed ports, with a lock so two sessions cannot take the same slot.

Validation harnesses (smoke specs, auth proxies, device bridges) stay in the app repo. This tool only creates the slots, copies env files, and runs the dev server.

## Install

The package is not published yet. From the repo you want slots for:

```sh
npx ~/Dev/workslot init
```

Or install the command once:

```sh
npm install -g ~/Dev/workslot
workslot init
```

## Create slots

```sh
cd space-traveler
npx ~/Dev/workslot init --prefix st --count 3
```

That prints the plan and asks before writing anything. `--yes` skips the prompt (required when stdin is not a terminal).

```
Workslot will create:
  ~/.workslot/ registry entry (ports 4100–4199)
  ../st-1  port 4101
  ../st-2  port 4102
  ../st-3  port 4103
It will copy untracked env files from the primary checkout into each new slot.
The primary checkout stays on main.
Continue? [Y/n]
```

| Flag | Default |
| --- | --- |
| `--prefix` | `slot` | `slot-1`, or `st-1` when the prefix is `st` |
| `--count` | `3` | how many worktrees to add (1–20) |
| `--base` | next free hundred | `slot-1` listens on `base + 1` |
| `--dev` | detected from the lockfile | shell command, usually `pnpm dev` |
| `--port-env` | `PORT` | variable exported to that command |

Running `init` again is safe. It creates any missing slots and fills in env files that are not already there. It will not shrink the set, change the prefix, or move the port block.

Untracked root env files (`.env`, `.env.local`, `.env.uat`, …) are copied from the primary checkout. Tracked files such as `.env.example` are already in the worktree. A later `init` does not overwrite an env file the slot already has.

Port blocks are recorded in `~/.workslot/registry.json`. The first repo on the machine gets `4100–4199`, the next `4200–4299`, and so on, so two repos do not pick the same ports.

## Daily commands

```sh
workslot status
workslot claim my-branch
workslot dev 1 --token <token>
workslot release 1 --token <token>
workslot reset 1 --token <token> --yes
```

`claim` locks the first open slot, creates `my-branch` from the default branch (or checks out that branch if it already exists), and prints the path, port, and token. A slot is open only when it exists, is detached, is clean, has no server listening, and has no lock.

`release` stops the server, detaches the worktree back onto the default branch, and clears the lock. The branch is kept. Uncommitted changes are refused; use `reset` to discard them.

`reset` throws away uncommitted work, restores env files, detaches, and unlocks. It asks first unless you pass `--yes`.

`dev` runs the install that matches the lockfile (`pnpm install --frozen-lockfile --prefer-offline`, `npm ci`, or the yarn/bun equivalent), exports the port, and starts the dev command. `--dry-run` prints that plan and starts nothing. It is safe in any slot.

From inside a slot, `dev`, `release`, and `reset` apply to that slot when you omit the number. They still require the claim token. `--dry-run` does not.

`--force` overrides a missing or foreign token. It still will not discard uncommitted changes; that is `reset`.

## Agent workflow

Start in the primary checkout, not in a slot. Ask the tool for a slot instead of choosing one yourself:

```sh
workslot claim my-branch
```

Stdout is the contract:

```
slot: 1
name: st-1
path: /Users/you/Dev/st-1
branch: my-branch
port: 4101
url: http://localhost:4101
token: …
```

Do every edit and git command in `path`. Leave the primary checkout on its current branch.

```sh
workslot dev 1 --token <token>          # from the primary checkout
workslot dev --dry-run                   # from inside the slot; starts nothing
workslot release 1 --token <token>       # after the tree is clean
```

`WORKSLOT_TOKEN` is accepted in place of `--token`.

If every slot is busy, `claim` exits 1 and names the holder. Do not steal a lock. `status` shows the same information. An abandoned lock (the worktree is detached and clean, but the lock remains) is cleared with `workslot release <n> --force`.

## What stays put

The primary checkout is never switched, reset, or turned into a slot. `init` refuses to run from inside a slot, and it refuses to create a worktree on top of a directory that is not already one of this repo's worktrees.
