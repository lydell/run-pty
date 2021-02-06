"use strict";

const timeout = Number(process.argv[2]) || 3000;
const message = process.argv[3] || "";

const killSignals = ["SIGHUP", "SIGINT", "SIGTERM"];

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (message !== "") {
      console.log(`${message} (${signal})`);
    }
    setTimeout(() => {
      process.exit(0);
    }, timeout);
  });
}

console.log(`Exiting after ${timeout} ms on:`, killSignals);
console.log("Press ctrl+d to exit.");
console.log("pid", process.pid);
process.stdin.resume();
