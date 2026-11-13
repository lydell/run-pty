"use strict";

// Escapes that look like requests, but never get a response (or might not get
// one, depending on the terminal) must not block later requests.

process.stdin.setRawMode(true);

const start = Date.now();

process.stdin.on("data", (data) => {
  const string = data.toString("utf8");
  if (string === "\x03") {
    process.exit();
  } else if (string.endsWith("R")) {
    console.log(
      "Got cursor position response after",
      Date.now() - start,
      "ms:",
      JSON.stringify(string),
    );
    process.exit();
  }
});

// Save window title (Vim does this). Never gets a response.
process.stdout.write("\x1B[22;2t");
// Report window size in pixels. Many terminals don’t respond.
process.stdout.write("\x1B[14t");
// Report cursor position. All terminals respond.
process.stdout.write("\x1B[6n");

console.log("Waiting for cursor position response…");
