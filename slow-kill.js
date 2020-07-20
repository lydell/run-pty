"use strict";

const timeout = Number(process.argv[2]) || 3000;
const message = process.argv[3] || "";

process.on("SIGTERM", () => {
  if (message !== "") {
    console.log(message);
  }
  setTimeout(() => {
    process.exit(0);
  }, timeout);
});

console.log("Slow kill.");
console.log("Press ctrl+d to exit.");
console.log("pid", process.pid);
process.stdin.resume();
