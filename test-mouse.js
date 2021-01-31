"use strict";

process.stdin.setRawMode(true);

const ENABLE_MOUSE = "\x1B[?1000;1006h";
const DISABLE_MOUSE = "\x1B[?1000;1006l";

console.log(process.pid);
process.stdout.write(ENABLE_MOUSE);
process.on("exit", () => {
  process.stdout.write(DISABLE_MOUSE);
});

process.stdin.on("data", (buffer) => {
  const data = buffer.toString();
  console.log(JSON.stringify(data), parse(data));
  if (data === "\x03") {
    process.exit();
  }
});

// eslint-disable-next-line no-control-regex
const REGEX = /\x1B\[M([ #])(.+)/;
// eslint-disable-next-line no-control-regex
const REGEX_2 = /\x1B\[<0;(\d+);(\d+)([Mm])/;

/**
 * @param {string} data
 * @returns {string}
 */
function parse(data) {
  const match = REGEX.exec(data);
  if (match === null) {
    return parse2(data);
  }

  const [, upDownRaw, chars] = match;
  const upDown = upDownRaw === "#" ? "up" : "down";
  const nums = chars
    .split("")
    .map((c) => c.charCodeAt(0) - 32)
    .join(", ");
  return `${upDown}: ${nums}`;
}

/**
 * @param {string} data
 * @returns {string}
 */
function parse2(data) {
  const match = REGEX_2.exec(data);
  if (match === null) {
    return "(parse error)";
  }

  const [, x, y, upDownRaw] = match;
  const upDown = upDownRaw === "m" ? "up" : "down";
  return `${upDown}: ${x},${y}`;
}
