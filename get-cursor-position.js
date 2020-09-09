"use strict";

process.stdin.setRawMode(true);

process.stdin.on("data", (data) => {
  const string = data.toString("utf8");
  // eslint-disable-next-line no-control-regex
  if (/^\x1B\[\d+;\d+R$/.test(string)) {
    console.log("Got cursor position reply:", JSON.stringify(string));
  } else if (string === "\x03") {
    process.exit();
  } else {
    console.log("Got other stdin:", JSON.stringify(string));
  }
});

setTimeout(() => {
  console.log("Requesting cursor position…");
  process.stdout.write("\x1B[6n");
}, 200);
