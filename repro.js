"use strict";
console.log("start");
setTimeout(() => {
  console.log("end");
  process.exit(Number(process.argv[2]));
}, 700);
