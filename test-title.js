"use strict";

/**
 * @param {number} ms
 * @returns
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  for (let i = 0; i < 1000; i++) {
    // OSC 0 sets both the icon name and the window title.
    process.stdout.write(`\x1B]0;test-title ${i}\x07`);
    process.stdout.write(`Set title to: test-title ${i}\n`);
    await wait(2000);
  }
}

run().catch(console.error);
