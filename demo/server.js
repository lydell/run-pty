"use strict";

console.log("Listening on port 1337");

const interval = Number(process.argv[2] ?? "1000");

setInterval(() => {
  console.log(new Date());
}, interval);
