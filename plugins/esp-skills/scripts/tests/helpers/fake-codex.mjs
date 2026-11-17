#!/usr/bin/env node
// Fake Codex CLI for codex.mjs tests, used through
// ESP_CODEX_CMD='["node", "<this file>"]'.
//
// ESP_FAKE_CODEX (a JSON file path) scripts the behavior:
//   {
//     "version": "codex-cli 0.128.0",       // --version output (null: exit 1)
//     "login": { "code": 0, "message": "Logged in using ChatGPT" },
//     "exec": {
//       "events": [ { "type": "..." } ],    // JSONL lines printed on stdout
//       "last_message": "text",             // written to -o (null: not written)
//       "exit_code": 0,
//       "stderr": "text",
//       "delay_ms": 0,                      // wait before answering
//       "hang": false,                      // never exit
//       "grandchild_pid_file": "path"       // with hang: spawn a hanging child, write its pid
//     },
//     "record": "path"                      // append { argv, stdin, cwd } per call (JSON lines)
//   }

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const scenario = process.env.ESP_FAKE_CODEX
  ? JSON.parse(readFileSync(process.env.ESP_FAKE_CODEX, "utf8"))
  : {};
const argv = process.argv.slice(2);

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (argv[0] === "--version") {
  if (scenario.version === null) {
    process.stderr.write("codex: broken install\n");
    process.exit(1);
  }
  process.stdout.write(`${scenario.version ?? "codex-cli 0.128.0"}\n`);
  process.exit(0);
}

if (argv[0] === "login" && argv[1] === "status") {
  const login = scenario.login ?? {
    code: 0,
    message: "Logged in using ChatGPT"
  };
  process.stderr.write(`${login.message}\n`);
  process.exit(login.code);
}

if (argv[0] !== "exec") {
  process.stderr.write(`fake codex: unsupported command ${argv.join(" ")}\n`);
  process.exit(2);
}

const stdin = argv.at(-1) === "-" ? readStdin() : "";
if (scenario.record)
  appendFileSync(
    scenario.record,
    `${JSON.stringify({ argv, stdin, cwd: process.cwd() })}\n`
  );

const exec = scenario.exec ?? {};

function answer() {
  for (const event of exec.events ?? [])
    process.stdout.write(`${JSON.stringify(event)}\n`);
  const out = flag("-o");
  if (out && exec.last_message !== null && exec.last_message !== undefined)
    writeFileSync(out, exec.last_message, "utf8");
  if (exec.stderr) process.stderr.write(`${exec.stderr}\n`);
  process.exit(exec.exit_code ?? 0);
}

if (exec.hang) {
  if (exec.grandchild_pid_file) {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
        windowsHide: true
      }
    );
    writeFileSync(exec.grandchild_pid_file, String(child.pid), "utf8");
  }
  process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
  setInterval(() => {}, 1000);
} else if (exec.delay_ms) {
  setTimeout(answer, exec.delay_ms);
} else {
  answer();
}
