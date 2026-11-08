#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const headless = process.argv.includes("--no-app");
const creds = `${process.env.HOME}/.near-credentials/testnet`;

const missing = ["alice-18e5.testnet", "bob-18e5.testnet", "carol-18e5.testnet", "polypus-agent-18e5.testnet"].filter(
  a => !fs.existsSync(path.join(creds, `${a}.json`)),
);
if (missing.length) {
  console.error(`missing testnet credentials: ${missing.join(", ")} (npm run setup:agent creates the agent account)`);
  process.exit(1);
}
if (!fs.existsSync(path.join(root, ".polypus-run/attestor-pub.json"))) {
  console.error("run `npm run setup:live` once first (registers the attestor and seeds trader history)");
  process.exit(1);
}

const tsx = path.join(root, "node_modules/.bin/tsx");
const procs = [
  ["api", tsx, ["api/server.ts"], "agents"],
  ["trader", tsx, ["trader-node/index.ts"], "agents"],
  ["follower", tsx, ["follower/index.ts"], "agents"],
  ["attestor", tsx, ["attestor/index.ts"], "agents"],
  ...(headless ? [] : [["app", path.join(root, "node_modules/.bin/vite"), ["--port", "5174", "--host", "127.0.0.1", "--strictPort"], "apps/keys"]]),
];

const children = [];
let stopping = false;

for (const [name, cmd, args, cwd] of procs) {
  const child = spawn(cmd, args, { cwd: path.join(root, cwd), env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: undefined, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", line => {
      const tagged = /^\x1b\[\d+m\w+\s*\x1b\[0m/.test(line);
      console.log(tagged ? line : `\x1b[90m${name.padEnd(8)}\x1b[0m ${line}`);
    });
  }
  child.on("exit", code => {
    if (stopping) return;
    console.error(`\x1b[31m${name} exited (${code})\x1b[0m`);
    shutdown(1);
  });
}

if (!headless) {
  setTimeout(() => console.log("\n  app  http://127.0.0.1:5174\n  api  http://127.0.0.1:8787/api/health\n"), 2500);
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
