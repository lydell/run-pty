"use strict";

const readline = require("readline");

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
readline.emitKeypressEvents(process.stdin);

process.stdin.on("data", (data) => {
  console.log("data:    ", JSON.stringify(data));
});

// `keypress.sequence` is mostly identical to `data` above.
// However, Vim begins by writing:
// "\u001b]11;rgb:28/2c/34\u0007", which
// `readline` splits that into:
// "\u001b]", "1", "1", ";", "r", "g", "b", ":", "2", "8", "/", "2", "c", "/", "3", "4" "\u0007"
// That breaks Vim, so we can’t use "keypress".
process.stdin.on(
  "keypress",
  /**
   * @param {unknown} unknown
   * @param {{ ctrl: boolean, name: string }} keypress
   */
  (unknown, keypress) => {
    console.log("keypress:", JSON.stringify(unknown), JSON.stringify(keypress));
    if (keypress.ctrl && keypress.name === "c") {
      process.exit();
    }
  },
);
