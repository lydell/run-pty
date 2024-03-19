"use strict";

const pty = require("node-pty");

const configurations = [
  [0, 700],
  [0, 800],
  [0, 2000],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [0, 700],
  [1, 700],
];

const queue = configurations.map(([exitCode, delay], i) =>
  run(i + 1, exitCode, delay),
);

/** @type {Array<number>} */
const results = [];

/**
 * @param {number} i
 * @param {number} wantedExitCode
 * @param {number} delay
 */
function run(i, wantedExitCode, delay) {
  return () => {
    console.log("Start", i);
    let buffer = "";
    const terminal = pty.spawn(
      "node",
      ["repro.js", wantedExitCode.toString(), delay.toString()],
      {},
    );
    terminal.onData((data) => {
      buffer += data;
    });
    terminal.onExit(({ exitCode, signal }) => {
      console.log("Exit", i, { exitCode, signal });
      console.log(buffer);
      results.push(exitCode);
      const next = queue.shift();
      if (next === undefined) {
        if (results.length === configurations.length) {
          const isSuccess = results.every((code) => code === 0);
          console.log(isSuccess ? "SUCCESS" : "ERROR", results);
          process.exit(isSuccess ? 0 : 1);
        }
      } else {
        next();
      }
    });
  };
}

for (let i = 0; i < 12; i++) {
  queue.shift()?.();
}
