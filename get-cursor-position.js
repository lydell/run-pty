"use strict";

const CURSOR_POSITION = "\x1B[6n";
const CURSOR_POSITION2 = "\x1B[?6n";
const WINDOW_POSITION = "\x1B[13t";
const FOREGROUND_COLOR = "\x1B]10;?\x07";
const BACKGROUND_COLOR = "\x1B]11;?\x07";

process.stdin.setRawMode(true);

process.stdin.on("data", (data) => {
  const string = data.toString("utf8");
  if (string === "\x03") {
    process.exit();
  } else {
    console.log("Got stdin:", JSON.stringify(string));
  }
});

setTimeout(() => {
  console.log("Requesting cursor position, window position and colors…");
  process.stdout.write(
    [
      CURSOR_POSITION,
      CURSOR_POSITION2,
      WINDOW_POSITION,
      FOREGROUND_COLOR,
      BACKGROUND_COLOR,
    ].join(""),
  );
}, 200);
