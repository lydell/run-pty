"use strict";

const cyanVariations = [
  ["\x1B[36m"],

  ["\x1B[36", "m"],
  ["\x1B[3", "6m"],
  ["\x1B[", "36m"],
  ["\x1B", "[36m"],

  ["\x1B[3", "6", "m"],
  ["\x1B[", "3", "6m"],
  ["\x1B", "[", "36m"],
  ["\x1B[", "36", "m"],
  ["\x1B", "[3", "6m"],
  ["\x1B", "[36", "m"],

  ["\x1B[", "3", "6", "m"],
  ["\x1B", "[", "3", "6m"],
  ["\x1B", "[", "36", "m"],
  ["\x1B", "[3", "6", "m"],

  ["\x1B", "[", "3", "6", "m"],
];

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  for (const [index, variation] of cyanVariations.entries()) {
    for (const segment of variation) {
      process.stdout.write(segment);
      await waitMs(1);
    }
    process.stdout.write(
      `Line ${index + 1} (${variation.length} variations)\x1B[0m\n`
    );
    await waitMs(100);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
