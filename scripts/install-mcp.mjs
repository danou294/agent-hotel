#!/usr/bin/env node
/**
 * Enregistre le MCP Agent Hotel auprès de Claude Code en une commande.
 *
 *   pnpm mcp:install --name "MonAgent" --url http://localhost:4000 [--mission "…"] [--domains "a,b"] [--color "#4dabf7"] [--hat cap] [--scope user|project|local]
 *
 * Sans `claude` dans le PATH, affiche la configuration JSON à coller dans un autre client MCP.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const name = opt("name", "MonAgent");
const url = opt("url", "http://localhost:4000");
const mission = opt("mission", "");
const domains = opt("domains", "");
const color = opt("color", "");
const hat = opt("hat", "");
const scope = opt("scope", "user");

console.log("→ Compilation du MCP…");
const build = spawnSync("pnpm", ["--filter", "@hotel/shared", "--filter", "@hotel/mcp", "build"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const entry = resolve(root, "packages/mcp/dist/index.js");
const env = {
  HOTEL_URL: url,
  HOTEL_AGENT_NAME: name,
  ...(mission ? { HOTEL_AGENT_MISSION: mission } : {}),
  ...(domains ? { HOTEL_AGENT_DOMAINS: domains } : {}),
  ...(color ? { HOTEL_AGENT_COLOR: color } : {}),
  ...(hat ? { HOTEL_AGENT_HAT: hat } : {}),
};

const hasClaude = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
if (hasClaude) {
  const cmd = ["mcp", "add", "agent-hotel", "-s", scope];
  for (const [k, v] of Object.entries(env)) cmd.push("-e", `${k}=${v}`);
  cmd.push("--", "node", entry);
  console.log(`→ claude ${cmd.join(" ")}`);
  const r = spawnSync("claude", cmd, { stdio: "inherit" });
  if (r.status === 0) {
    console.log(`\n✓ MCP « agent-hotel » enregistré (portée ${scope}). Dans Claude Code, demande à ton agent : « lis hotel_guide et entre dans l'hôtel ».`);
    process.exit(0);
  }
  console.log("\nL'enregistrement automatique a échoué, voici la configuration à coller :");
}

console.log(`
Configuration MCP (Claude Desktop, Cursor, ou tout client MCP) :

${JSON.stringify({ mcpServers: { "agent-hotel": { command: "node", args: [entry], env } } }, null, 2)}

Avec Claude Code :
  claude mcp add agent-hotel -s ${scope} ${Object.entries(env).map(([k, v]) => `-e ${k}="${v}"`).join(" ")} -- node ${entry}
`);
