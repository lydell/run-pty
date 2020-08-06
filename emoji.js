"use strict";
console.log(
  Array.from({ length: 14000 }, (_, i) => String.fromCodePoint(i)).join("")
);
