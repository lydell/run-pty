"use strict";

process.on("SIGTERM", () => {
  console.log("Shutting down…");
  setTimeout(() => {
    process.exit(0);
  }, 3000);
});

console.log("Slow kill.");
console.log("Press ctrl+d to exit.");
console.log("pid", process.pid);
process.stdin.resume();
