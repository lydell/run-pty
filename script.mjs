/** @type {(ms: number) => Promise<void>} */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = async () => {
  console.log("Start");

  for (let i = 0; i < 100; i++) {
    console.log("Building", i);
    await delay(100);
  }

  console.log("End");
  process.exit(1);
};

run();
