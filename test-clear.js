"use strict";

/**
 * @template T
 * @param {Array<T>} items
 * @returns {Array<Array<T>>}
 */
const permutations = (items) =>
  items.length <= 1
    ? [items]
    : items.flatMap((first, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
          (rest) => [first, ...rest]
        )
      );

const variants = [
  ...permutations(["\x1B[2J", "\x1B[3J", "\x1B[H"]).map((items) =>
    items.join("")
  ),
  ...permutations(["\x1B[2J", "\x1B[3J", "\x1B[0;0f"]).map((items) =>
    items.join("")
  ),
  ...permutations(["\x1B[2J", "\x1B[3J", "\x1B[1;1H"]).map((items) =>
    items.join("")
  ),
  () => {
    process.stdout.write("\x1B[3J");
    console.clear();
  },
  () => {
    console.clear();
    process.stdout.write("\x1B[3J");
  },
];

const index = Number(process.argv[2]) || 0;

console.log("Number of variants:", variants.length);
console.log("Chosen variant (CLI arg 1):", index);
console.log("Not a simple log");
process.stdout.write("\x1B[2A");

setTimeout(() => {
  const f = variants[index];

  if (f === undefined) {
    console.error("Out of bounds! Got:", index, "Max:", variants.length - 1);
    process.exit(1);
  }

  let string;

  if (typeof f === "string") {
    process.stdout.write(f);
    string = JSON.stringify(f);
  } else {
    f();
    string = f.toString();
  }

  console.log("Done!", string);
  process.stdin.resume();
}, 1000);
