"use strict";

/**
 * @param {number} ms
 * @returns
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// White, underlined text on magenta background.
process.stdout.write(`\x1B[4m\x1B[37m\x1B[45m`);

async function run() {
  for (let i = 0; i < 1000; i++) {
    process.stdout.write(`Log ${i}\n`);
    await wait(1000);
  }
}

run().catch(console.error);
