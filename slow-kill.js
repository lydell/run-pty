"use strict";

const timeout = Number(process.argv[2]) || 3000;
const message = process.argv[3] || "";

const signals = ["SIGHUP", "SIGINT", "SIGTERM"];

for (const signal of signals) {
  process.on(signal, () => {
    if (message !== "") {
      console.log(`${message} (${signal})`);
    }
    setTimeout(() => {
      process.exit(0);
    }, timeout);
  });
}

console.log(`Exiting after ${timeout} ms on:`, signals);
console.log("Press ctrl+d to exit.");
console.log("pid", process.pid);
process.stdin.resume();
