"use strict";

const pty = require("node-pty");

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
