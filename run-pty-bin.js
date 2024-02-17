#!/usr/bin/env node

"use strict";

// Workaround for:
// https://github.com/lydell/run-pty/issues/45
// https://github.com/lydell/run-pty/issues/53
if (process.platform === "linux" && !("UV_USE_IO_URING" in process.env)) {
  require("child_process")
    .spawn(
      process.execPath,
      [`${__dirname}/run-pty.js`, ...process.argv.slice(2)],
      {
        stdio: "inherit",
        env: { ...process.env, UV_USE_IO_URING: "0" },
      },
    )
    .on("exit", process.exit);
} else {
  require("./run-pty.js").__internalRun();
}
