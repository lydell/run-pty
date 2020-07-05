const pty = require("node-pty");

const options = {
  cols: process.stdout.columns,
  rows: process.stdout.rows,
};

// const terminal = pty.spawn("nvim", [], options);
// const terminal = pty.spawn("pwd", ["-P"], options);
const terminal = pty.spawn("./slow.bash", [], options);
console.clear();
console.log(terminal.pid, terminal.process);

process.stdout.on("resize", () => {
  terminal.resize(process.stdout.columns, process.stdout.rows);
});

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data === "\x03") {
    terminal.kill();
  } else {
    terminal.write(data);
  }
});

terminal.on("data", (data) => {
  process.stdout.write(data);
});

terminal.on("exit", (exitCode, signal) => {
  console.log("Exit", exitCode, signal);
  process.exit(exitCode);
});
