"use strict";

const CURSOR_FORWARD_3 = "\x1B[3C";
const CURSOR_BACK = "\x1B[D";
const CURSOR_AT_9 = "\x1B[9G";
const CLEAR_LINE = "\x1B[2K";

process.stdout.write("First");
process.stdout.write(CLEAR_LINE);
process.stdout.write("Trixxy xxsiness");
process.stdout.write(CURSOR_AT_9);
process.stdout.write("ck");
process.stdout.write(CURSOR_FORWARD_3);
process.stdout.write(CURSOR_BACK);
process.stdout.write("bu");

process.stdin.resume();
