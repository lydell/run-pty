"use strict";
for (let i = 0; i < 20; i++) {
  console.log("stuff");
}
require("readline").moveCursor(process.stdout, 0, -10);
process.stdout.write("final print");
setTimeout(Function.prototype, 1000);
