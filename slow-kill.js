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

// Move cursor down so the program isn’t considered a simple log.
// We still print stuff ending with newlines though, so we can still show
// keyboard shortcuts.
process.stdout.write("\x1B[B");
console.log(`Exiting after ${timeout} ms on:`, killSignals);
console.log("Press ctrl+d to exit.");
console.log("pid", process.pid);
process.stdin.resume();
