import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_START = "<!-- workslot:start -->";
export const AGENTS_END = "<!-- workslot:end -->";

export function agentInstructions(plan) {
  const names = plan.slots.map((slot) => `\`${slot.name}\``).join(", ");
  const ports = plan.slots.length === 1
    ? String(plan.slots[0].port)
    : `${plan.slots[0].port}–${plan.slots[plan.slots.length - 1].port}`;
  return `## Work slots

This repo uses permanent git worktree slots for parallel work. Follow these steps even when the session started in the primary checkout.

The primary checkout keeps its current branch. Create branches, commits, and file edits in a slot.

1. From the primary checkout, run \`workslot claim <branch>\` before editing. The new branch starts from that current branch. Pass \`--base <ref>\` to start from a different commit.
2. Do every file edit and git command in the printed \`path\`.
3. Keep the printed \`token\`. Pass it as \`--token\` or \`WORKSLOT_TOKEN\`.

This repo has ${plan.count} ${plan.count === 1 ? "slot" : "slots"}: ${names}. They sit next to the primary checkout. Ports are ${ports} (\`${plan.portEnv}\`).

- Dev server: \`workslot dev <n> --token <token>\`
- See the command without starting it: \`workslot dev <n> --dry-run\`
- Clean and finished: \`workslot release <n> --token <token>\`
- Discard uncommitted work: \`workslot reset <n> --token <token> --yes\`

Leave \`${plan.devCommand}\` to \`workslot dev\`. Leave slots you do not hold alone. If \`workslot claim\` reports no open slot, stop and report which slots are busy. \`workslot status\` shows holders and does not reveal tokens.

If \`workslot\` is not on PATH, prefix the same commands with \`npx workslot\`.
`;
}

export function cursorRule(plan) {
  return `---
description: Use workslot worktrees for edits, git, and the dev server
alwaysApply: true
---

${agentInstructions(plan).trim()}
`;
}

export function mergeAgents(existing, block) {
  const section = `${AGENTS_START}\n${block.trim()}\n${AGENTS_END}\n`;
  if (!existing.trim()) return section;
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start !== -1 && end > start) {
    const before = existing.slice(0, start).replace(/\s+$/, "");
    const after = existing.slice(end + AGENTS_END.length).replace(/^\s+/, "");
    const head = before ? `${before}\n\n` : "";
    const tail = after ? `\n${after.endsWith("\n") ? after : `${after}\n`}` : "";
    return `${head}${section}${tail}`;
  }
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${base}\n${section}`;
}

export function installAgentInstructions(primary, plan) {
  const block = agentInstructions(plan);
  const agentsPath = join(primary, "AGENTS.md");
  const previousAgents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const nextAgents = mergeAgents(previousAgents, block);
  if (nextAgents !== previousAgents) writeFileSync(agentsPath, nextAgents);

  const ruleDir = join(primary, ".cursor", "rules");
  const rulePath = join(ruleDir, "workslot.mdc");
  const nextRule = cursorRule(plan);
  const previousRule = existsSync(rulePath) ? readFileSync(rulePath, "utf8") : "";
  if (nextRule !== previousRule) {
    mkdirSync(ruleDir, { recursive: true });
    writeFileSync(rulePath, nextRule);
  }

  return {
    agentsPath,
    rulePath,
    changed: nextAgents !== previousAgents || nextRule !== previousRule,
  };
}
