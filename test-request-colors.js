"use strict";

process.stdin.setRawMode(true);

let stdin = "";

process.stdin.on("data", (data) => {
  const string = data.toString("utf8");
  stdin += string;
  if (string === "\x03") {
    process.exit();
  } else if (stdin.includes("]11;")) {
    const results =
      stdin.match(/rgb:[\da-f]{4}\/[\da-f]{4}\/[\da-f]{4}/gi) ?? [];
    console.log("Results", results.length, new Set(results));
    process.exit();
  }
});

for (let i = 0; i <= 1024; i++) {
  if (i % 2 === 0) {
    process.stdout.write(`\x1B]4;${i};?\x1B\\`);
  } else {
    process.stdout.write(`\x1B]4;${i};?\x07`);
  }
}

process.stdout.write(`\x1B]10;?\x1B\\`);
process.stdout.write(`\x1B]11;?\x07`);
