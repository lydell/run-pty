"use strict";

// Mimics the output of a frontend dev server like Vite.

console.log();
console.log("  VITE v7.3.7  ready in 53 ms");
console.log();
console.log("  ➜  Local:   http://localhost:5173/");
console.log("  ➜  Network: use --host to expose");

const interval = Number(process.argv[2] ?? "3000");

let count = 0;

setInterval(() => {
  count++;
  const time = new Date().toLocaleTimeString("en-GB");
  if (count % 5 === 0) {
    console.log(`${time} [vite] Internal server error: Unexpected token (1:7)`);
  } else {
    console.log(`${time} [vite] page reload src/main.js`);
  }
}, interval);
