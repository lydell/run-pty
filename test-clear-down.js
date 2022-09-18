"use strict";

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function goUp() {
  const CURSOR_UP = "\x1B[A";
  const split = 2;
  process.stdout.write(CURSOR_UP.slice(0, split));
  await delay(1);
  process.stdout.write(CURSOR_UP.slice(split));
}

async function run() {
  const CLEAR = "\x1B[2J\x1B[3J\x1B[H";
  const CLEAR_DOWN = "\x1B[0J";
  const CLEAR_LINE = "\x1B[2K";

  process.stdout.write("Apple: in progress\n");
  await delay(100);
  process.stdout.write("Banana: in progress\n");
  await delay(1000);
  await goUp();
  await goUp();
  process.stdout.write(`${CLEAR_LINE}Apple: done\n`);
  await delay(1000);
  process.stdout.write(`${CLEAR_LINE}Banana: done\n`);
  process.stdout.write(`${CLEAR_DOWN}Success!`);

  await delay(2000);
  process.stdout.write(CLEAR);
  await run();
}

run();
