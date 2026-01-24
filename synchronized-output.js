"use strict";

async function run() {
  const BEGIN_SYNC_UPDATE = "\x1B[?2026h";
  const END_SYNC_UPDATE = "\x1B[?2026l";

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  process.stdout.write(BEGIN_SYNC_UPDATE);
  process.stdout.write("Line 1\n");
  await waitMs(500);
  process.stdout.write(
    "Line 2 – lines 1 and 2 should appear at the same time\n",
  );
  process.stdout.write(END_SYNC_UPDATE);

  process.stdout.write(BEGIN_SYNC_UPDATE);
  process.stdout.write("Line 3\n");
  await waitMs(1000);
  process.stdout.write("Line 4\n");
  await waitMs(1000);
  process.stdout.write(
    "Line 5 – lines 3, 4 and 5 use sync output, but is too slow, so only lines 3 and 4 print together\n",
  );
  process.stdout.write(END_SYNC_UPDATE);

  await waitMs(1000);
  process.stdout.write("Final line – comes later\n");
}

void run();
