const pty = require("node-pty");

const options = {
  cols: process.stdout.columns,
  rows: process.stdout.rows - 1,
};

const history = [];
const terminal = pty.spawn("nvim", [], options);
// const terminal = pty.spawn("ls", ["-l", "-a", "-h"], options);
// const terminal = pty.spawn("npm", ["run", "watch"], options);
// const terminal = pty.spawn("./slow.bash", [], options);
// const terminal = pty.spawn("./std.bash", [], options);
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
  } else if (data === "\t") {
    console.clear();
    for (const data of history) {
      process.stdout.write(data);
    }
  } else {
    terminal.write(data);
  }
});

const dispose1 = terminal.onData((data) => {
  history.push(data);
  process.stdout.write(data);
});

const dispose2 = terminal.onExit(({ exitCode, signal }) => {
  console.log("Exit", exitCode, signal);
  process.exit(exitCode);
});
