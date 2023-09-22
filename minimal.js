"use strict";

const pty = require("node-pty");

const NUM = 5;

const queue = Array.from({ length: NUM }, (_, i) => run(i + 1));

/** @type {Array<number>} */
const results = [];

/**
 * @param {number} i
 */
function run(i) {
  return () => {
    console.log("Start", i);
    let buffer = "";
    const terminal = pty.spawn("node", ["repro.js", i === NUM ? "1" : "0"], {});
    terminal.onData((data) => {
      buffer += data;
    });
    terminal.onExit(({ exitCode, signal }) => {
      console.log("Exit", i, { exitCode, signal });
      console.log(buffer);
      results.push(exitCode);
      const next = queue.shift();
      if (next === undefined) {
        if (results.length === NUM) {
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

for (let i = 0; i < 2; i++) {
  queue.shift()?.();
}
