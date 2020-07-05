"use strict";

const pty = require("node-pty");
const readline = require("readline");

const labels = "123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const help = `
Run several commands concurrently.
Show output for one command at a time – switch via ctrl+z.
Kill all at once with ctrl+c.

Examples:

run-pty % npm start % make watch % some_command arg1 arg2 arg3

run-pty @ ./compile.bash --root / @ ./report_progress.bash --unit % @ ping localhost

Note: A command is a file followed by arguments – not shell script code.
`.trim();

const runningIndicator = "🟢";

const exitIndicator = (exitCode) => (exitCode === 0 ? "⚪" : "🔴");

function firstHistoryLine(name) {
  return `${runningIndicator} ${name}\n`;
}

// Newlines at start/end are wanted here.
function exitText(commandName, exitCode) {
  return `
${exitIndicator(exitCode)} ${commandName}
exit ${exitCode}

Press Enter to restart.
Press ctrl+z to go to the dashboard.
Press ctrl+c to exit all.
`;
}

function statusText(status) {
  switch (status.tag) {
    case "Running":
      return `${runningIndicator} pid ${status.terminal.pid}`;

    case "Exit":
      return `${exitIndicator(status.exitCode)} exit ${status.exitCode}`;

    default:
      throw new Error("Unknown command status", status);
  }
}

function drawDashboard(commands) {
  const lines = commands.map((command) =>
    truncate(
      [command.label, statusText(command.status), command.name].join("  "),
      process.stdout.columns
    )
  );

  return `
${lines.join("\n")}

Press the digit/letter of a command to switch to it.
Press ctrl+c to exit all.
`.trim();
}

function truncate(string, maxLength) {
  return string.length <= maxLength
    ? string
    : `${string.slice(0, maxLength - 1)}…`;
}

function commandToPresentationName(command) {
  return command
    .map((part) =>
      /^[\w./-]+$/.test(part) ? part : `'${part.replace(/'/g, "’")}'`
    )
    .join(" ");
}

function keypressToString(keypress) {
  const name = keypress.name || keypress.sequence || "unknown";
  return keypress.ctrl ? `ctrl+${name}` : name;
}

function parseArgs(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    return { tag: "Help" };
  }

  const delimiter = args[0];

  if (/^[\w-]*$/.test(delimiter)) {
    return {
      tag: "Error",
      message:
        "The first argument is the delimiter to use between commands.\nIt must not be empty or a-z/0-9/underscores/dashes only.\nMaybe try % as delimiter?",
    };
  }

  let command = [];
  const commands = [];

  for (const arg of args) {
    if (arg === delimiter) {
      if (command.length > 0) {
        commands.push(command);
        command = [];
      }
    } else {
      command.push(arg);
    }
  }

  if (command.length > 0) {
    commands.push(command);
  }

  if (commands.length === 0) {
    return {
      tag: "Error",
      message: "You must specify at least one command to run.",
    };
  }

  return {
    tag: "Parsed",
    commands,
  };
}

class Command {
  constructor({ label, file, args, onData, onExit }) {
    this.label = label;
    this.file = file;
    this.args = args;
    this.name = commandToPresentationName([file, ...args]);
    this.onData = onData;
    this.onExit = onExit;
    this.history = [];
    this.status = { tag: "Exit", exitCode: 0 };
    this.start();
  }

  start() {
    if (this.status.tag === "Running") {
      throw new Error(
        `pty already running with pid ${this.status.terminal.pid} for: ${this.name}`
      );
    }

    this.history = [firstHistoryLine(this.name)];

    const terminal = pty.spawn(this.file, this.args, {
      cols: process.stdout.columns,
      rows: process.stdout.rows,
    });

    const disposeOnData = terminal.onData((data) => {
      this.history.push(data);
      this.onData(data);
    });

    const disposeOnExit = terminal.onExit(({ exitCode }) => {
      disposeOnData.dispose();
      disposeOnExit.dispose();
      this.status = { tag: "Exit", exitCode };
      this.onExit(exitCode);
    });

    this.status = { tag: "Running", terminal };
  }

  log(data) {
    this.history.push(data);
    this.onData(data);
  }
}

function runCommands(rawCommands) {
  let current = { tag: "Dashboard" };

  const switchToDashboard = () => {
    current = { tag: "Dashboard" };
    console.clear();
    console.log(drawDashboard(commands));
  };

  const switchToCommand = (index) => {
    const command = commands[index];
    current = { tag: "Command", index };
    console.clear();
    for (const data of command.history) {
      process.stdout.write(data);
    }
  };

  const killAll = () => {
    for (const command of commands) {
      if (command.status.tag === "Running") {
        command.status.terminal.kill();
      }
    }
    process.exit(0);
  };

  const commands = rawCommands.map(
    ([file, ...args], index) =>
      new Command({
        label: labels[index] || "",
        file,
        args,
        onData: (data) => {
          if (current.tag === "Command" && current.index === index) {
            process.stdout.write(data);
          }
        },
        onExit: (exitCode) => {
          switch (current.tag) {
            case "Command": {
              const command = commands[current.index];
              command.log(exitText(command.name, exitCode));
              break;
            }

            case "Dashboard":
              // Redraw dashboard.
              switchToDashboard();
              break;

            default:
              throw new Error("Unknown current", current);
          }
        },
      })
  );

  process.stdout.on("resize", () => {
    for (const command of commands) {
      if (command.status.tag === "Running") {
        command.status.terminal.resize(
          process.stdout.columns,
          process.stdout.rows
        );
      }
    }

    if (current.tag === "Dashboard") {
      // Redraw dashboard.
      switchToDashboard();
    }
  });

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  readline.emitKeypressEvents(process.stdin);

  process.stdin.on("data", (data) => {
    if (
      current.tag === "Command" &&
      commands[current.index].status.tag === "Running"
    ) {
      commands[current.index].status.terminal.write(data);
    }
  });

  process.stdin.on("keypress", (_, keypress) => {
    onKeypress(
      keypress,
      current,
      commands,
      switchToDashboard,
      switchToCommand,
      killAll
    );
  });

  if (commands.length === 1) {
    switchToCommand(0);
  } else {
    switchToDashboard();
  }
}

function onKeypress(
  keypress,
  current,
  commands,
  switchToDashboard,
  switchToCommand,
  killAll
) {
  const keypressString = keypressToString(keypress);

  switch (current.tag) {
    case "Command": {
      const command = commands[current.index];
      switch (command.status.tag) {
        case "Running":
          switch (keypressString) {
            case "ctrl+c":
              command.status.terminal.kill();
              break;

            case "ctrl+z":
              switchToDashboard();
              break;
          }
          break;

        case "Exit":
          switch (keypressString) {
            case "ctrl+c":
              killAll();
              break;

            case "ctrl+z":
              switchToDashboard();
              break;

            case "return":
              command.start();
              command.history.unshift("\n");
              for (const data of command.history) {
                process.stdout.write(data);
              }
              break;
          }
          break;

        default:
          throw new Error("Unknown command status", command);
      }
      break;
    }

    case "Dashboard":
      switch (keypressString) {
        case "ctrl+c":
          killAll();
          break;

        default: {
          const commandIndex = commands.findIndex(
            (command) => command.label === keypressString
          );
          if (commandIndex !== -1) {
            switchToCommand(commandIndex);
          }
          break;
        }
      }
      break;

    default:
      throw new Error("Unknown current", current);
  }
}

function run() {
  const parseResult = parseArgs(process.argv.slice(2));

  switch (parseResult.tag) {
    case "Help":
      console.log(help);
      process.exit(0);
      break;

    case "Parsed":
      runCommands(parseResult.commands);
      break;

    case "Error":
      console.error(parseResult.message);
      process.exit(1);
      break;

    default:
      console.error("Unknown parseResult", parseResult);
      process.exit(1);
      break;
  }
}

run();
