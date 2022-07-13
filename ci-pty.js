"use strict";

const pty = require("node-pty");

console.log("stdin", process.stdin.isTTY);
console.log("stdout", process.stdout.isTTY);
console.log("stderr", process.stderr.isTTY);

const terminal = pty.spawn("node", ["tmp.js"], {
  cwd: process.cwd(),
  cols: process.stdout.columns,
  rows: process.stdout.rows,
  conptyInheritCursor: true,
});

const disposeOnData = terminal.onData((data) => {
  process.stdout.write(data);
});

const disposeOnExit = terminal.onExit(({ exitCode }) => {
  disposeOnData.dispose();
  disposeOnExit.dispose();
  process.exitCode = exitCode;
});
