"use strict";

/**
 * @param {number} ms
 * @returns
 */
const waitMs = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function run() {
  for (let index = 0; index < 5; index++) {
    console.log(index);
    await waitMs(500);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
