#!/usr/bin/env node

"use strict";

const colorette = require("colorette");
const pty = require("node-pty");
const readline = require("readline");

const KEYS = {
  kill: "ctrl+c",
  restart: "enter ", // Extra space for alignment.
  dashboard: "ctrl+z",
};

const KEY_CODES = {
  kill: "\x03",
  restart: "\r",
  dashboard: "\x1a",
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const LABEL_GROUPS = ["123456789", ALPHABET, ALPHABET.toUpperCase()];
const ALL_LABELS = LABEL_GROUPS.join("");

const runningIndicator = "🟢";

const killingIndicator = "⭕";

const exitIndicator = (exitCode) => (exitCode === 0 ? "⚪" : "🔴");

const shortcut = (string) => colorette.blue(colorette.bold(string));

const runPty = shortcut("run-pty");
const pc = colorette.gray("%");
const at = colorette.gray("@");

const help = `
Run several commands concurrently.
Show output for one command at a time.
Kill all at once.

    ${shortcut(summarizeLabels(ALL_LABELS.split("")))} focus command
    ${shortcut(KEYS.dashboard)} dashboard
    ${shortcut(KEYS.kill)} kill focused/all
    ${shortcut(KEYS.restart)} restart killed/exited command

Separate the commands with a character of choice:

    ${runPty} ${pc} npm start ${pc} make watch ${pc} some_command arg1 arg2 arg3

    ${runPty} ${at} ./report_progress.bash --root / --unit % ${at} ping localhost

Note: All arguments are strings and passed as-is – no shell script execution.
`.trim();

function killAllLabel(commands) {
  return commands.some((command) => command.status.tag === "Killing")
    ? "force kill all"
    : commands.every((command) => command.status.tag === "Exit")
    ? "exit"
    : "kill all";
}

function drawDashboard(commands, width) {
  const lines = commands.map((command) => [
    colorette.bgWhite(
      colorette.black(colorette.bold(` ${command.label || " "} `))
    ),
    statusText(command.status),
    command.name,
  ]);

  const widestStatus = Math.max(
    0,
    ...lines.map(([, status]) => Array.from(status).length)
  );

  const finalLines = lines
    .map(([label, status, name]) =>
      truncate([label, padEnd(status, widestStatus), name].join("  "), width)
    )
    .join("\n");

  const label = summarizeLabels(commands.map((command) => command.label));

  return `
${finalLines}

${shortcut(padEnd(label, KEYS.kill.length))} focus command
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
`.trim();
}

function firstHistoryLine(name) {
  return `${runningIndicator} ${name}\n`;
}

// Newlines at the end are wanted here.
const startText = `
${shortcut(KEYS.kill)} kill
${shortcut(KEYS.dashboard)} dashboard

`.trimStart();

// Newlines at the start/end are wanted here.
function killingText(commandName) {
  return `
${killingIndicator} ${commandName}
killing…

${shortcut(KEYS.kill)} force kill
${shortcut(KEYS.dashboard)} dashboard
`;
}

function exitShortcuts(commands) {
  return `
${shortcut(KEYS.restart)} restart
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
${shortcut(KEYS.dashboard)} dashboard
`.trim();
}

// Newlines at the start/end are wanted here.
function exitText(commands, commandName, exitCode) {
  return `
${exitIndicator(exitCode)} ${commandName}
exit ${exitCode}

${exitShortcuts(commands)}
`;
}

function statusText(status) {
  switch (status.tag) {
    case "Running":
      return `${runningIndicator} pid ${status.terminal.pid}`;

    case "Killing":
      return `${killingIndicator} pid ${status.terminal.pid}`;

    case "Exit":
      return `${exitIndicator(status.exitCode)} exit ${status.exitCode}`;

    default:
      throw new Error(`Unknown command status: ${status.tag}`);
  }
}

function removeColor(string) {
  // eslint-disable-next-line no-control-regex
  return string.replace(/\x1b\[\d+m/g, "");
}

function truncate(string, maxLength) {
  const diff = removeColor(string).length - maxLength;
  return diff <= 0 ? string : `${string.slice(0, -(diff + 2))}…`;
}

function padEnd(string, maxLength) {
  const chars = Array.from(string);
  return chars
    .concat(
      Array.from({ length: Math.max(0, maxLength - chars.length) }, () => " ")
    )
    .join("");
}

function commandToPresentationName(command) {
  return command
    .map((part) =>
      /^[\w./-]+$/.test(part) ? part : `'${part.replace(/'/g, "’")}'`
    )
    .join(" ");
}

function summarizeLabels(labels) {
  const numLabels = labels.length;
  return LABEL_GROUPS.map((group, index) => {
    const previousLength = LABEL_GROUPS.slice(0, index).reduce(
      (sum, previousGroup) => sum + previousGroup.length,
      0
    );
    const currentLength = previousLength + group.length;
    return numLabels > previousLength
      ? numLabels < currentLength
        ? group.slice(0, numLabels - previousLength)
        : group
      : undefined;
  })
    .filter(Boolean)
    .map((group) =>
      group.length === 1 ? group[0] : `${group[0]}-${group[group.length - 1]}`
    )
    .join("/");
}

function parseArgs(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    return { tag: "Help" };
  }

  const delimiter = args[0];

  if (/^[\w-]*$/.test(delimiter)) {
    return {
      tag: "Error",
      message: [
        "The first argument is the delimiter to use between commands.",
        "It must not be empty or a-z/0-9/underscores/dashes only.",
        "Maybe try % as delimiter?",
      ].join("\n"),
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
    if (this.status.tag !== "Exit") {
      throw new Error(
        `Cannot start pty with pid ${this.status.terminal.pid} because not exited for: ${this.name}`
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
      const lastIsKillingText =
        this.status.tag === "Killing" &&
        this.history.length === this.status.historyLengthWhenStartedKilling;
      this.status = { tag: "Exit", exitCode };
      this.onExit(exitCode, lastIsKillingText);
    });

    this.status = { tag: "Running", terminal };
  }

  kill() {
    // node-pty does not support kill signals on Windows.
    // This is the same check that node-pty uses.
    const isWindows = process.platform === "win32";

    // https://www.gnu.org/software/libc/manual/html_node/Termination-Signals.html
    switch (this.status.tag) {
      case "Running":
        this.log(killingText(this.name));
        this.status = {
          tag: "Killing",
          terminal: this.status.terminal,
          historyLengthWhenStartedKilling: this.history.length,
        };
        if (isWindows) {
          this.status.terminal.kill();
        } else {
          // SIGHUP causes a silent exit for `npm run`.
          this.status.terminal.kill("SIGHUP");
          // SIGTERM is needed for some programs (but is noisy for `npm run`).
          this.status.terminal.kill("SIGTERM");
        }
        break;

      case "Killing":
        if (isWindows) {
          this.status.terminal.kill();
        } else {
          this.status.terminal.kill("SIGKILL");
        }
        break;

      case "Exit":
        throw new Error(
          `Cannot kill pty with pid ${this.status.terminal.pid} because already exited for: ${this.name}`
        );

      default:
        throw new Error(`Unknown command status ${this.status.tag}`);
    }
  }

  log(data) {
    this.history.push(data);
    this.onData(data);
  }
}

function runCommands(rawCommands) {
  let current = { tag: "Dashboard" };
  let attemptedKillAll = false;

  const printHistoryAndStartText = (command) => {
    process.stdout.write(startText);
    for (const data of command.history) {
      process.stdout.write(data);
    }
  };

  const switchToDashboard = () => {
    current = { tag: "Dashboard" };
    console.clear();
    console.log(drawDashboard(commands, process.stdout.columns));
  };

  const switchToCommand = (index) => {
    const command = commands[index];
    current = { tag: "Command", index };
    console.clear();
    printHistoryAndStartText(command);
  };

  const killAll = () => {
    attemptedKillAll = true;
    const notExited = commands.filter(
      (command) => command.status.tag !== "Exit"
    );
    if (notExited.length === 0) {
      process.exit(0);
    } else {
      for (const command of notExited) {
        command.kill();
      }
    }
  };

  const commands = rawCommands.map(
    ([file, ...args], index) =>
      new Command({
        label: ALL_LABELS[index] || "",
        file,
        args,
        onData: (data) => {
          if (current.tag === "Command" && current.index === index) {
            process.stdout.write(data);
          }
        },
        onExit: (exitCode, lastIsKillingText) => {
          const command = commands[index];

          // Remove killing text.
          if (lastIsKillingText) {
            command.history.pop();
            if (current.tag === "Command" && current.index === index) {
              readline.moveCursor(
                process.stdout,
                0,
                -killingText(command.name).split("\n").length + 1
              );
              readline.clearScreenDown(process.stdout);
            }
          }

          command.log(exitText(commands, command.name, exitCode));

          if (current.tag === "Dashboard") {
            // Redraw dashboard.
            switchToDashboard();
          }

          // Exit the whole program if all commands are killed.
          if (
            attemptedKillAll &&
            commands.every((command2) => command2.status.tag === "Exit")
          ) {
            process.exit(0);
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

  process.stdin.on("data", (data) => {
    onStdin(
      data,
      current,
      commands,
      switchToDashboard,
      switchToCommand,
      killAll,
      printHistoryAndStartText
    );
  });

  if (commands.length === 1) {
    switchToCommand(0);
  } else {
    switchToDashboard();
  }
}

function onStdin(
  data,
  current,
  commands,
  switchToDashboard,
  switchToCommand,
  killAll,
  printHistoryAndStartText
) {
  switch (current.tag) {
    case "Command": {
      const command = commands[current.index];
      switch (command.status.tag) {
        case "Running":
          switch (data) {
            case KEY_CODES.kill:
              command.kill();
              break;

            case KEY_CODES.dashboard:
              switchToDashboard();
              break;

            default:
              command.status.terminal.write(data);
              break;
          }
          break;

        case "Killing":
          switch (data) {
            case KEY_CODES.kill:
              command.kill();
              break;

            case KEY_CODES.dashboard:
              switchToDashboard();
              break;
          }
          break;

        case "Exit":
          switch (data) {
            case KEY_CODES.kill:
              killAll();
              // Update exit shortcuts.
              readline.moveCursor(
                process.stdout,
                0,
                -exitShortcuts(commands).split("\n").length
              );
              readline.clearScreenDown(process.stdout);
              process.stdout.write(`${exitShortcuts(commands)}\n`);
              break;

            case KEY_CODES.dashboard:
              switchToDashboard();
              break;

            case KEY_CODES.restart:
              command.start();
              readline.moveCursor(
                process.stdout,
                0,
                -exitShortcuts(commands).split("\n").length
              );
              readline.clearScreenDown(process.stdout);
              printHistoryAndStartText(command);
              break;
          }
          break;

        default:
          throw new Error(`Unknown command status: ${command.status.tag}`);
      }
      break;
    }

    case "Dashboard":
      switch (data) {
        case KEY_CODES.kill:
          killAll();
          // Redraw dashboard.
          switchToDashboard();
          break;

        default: {
          const commandIndex = commands.findIndex(
            (command) => command.label === data
          );
          if (commandIndex !== -1) {
            switchToCommand(commandIndex);
          }
          break;
        }
      }
      break;

    default:
      throw new Error(`Unknown current state: ${current.tag}`);
  }
}

function run() {
  if (!process.stdin.isTTY) {
    console.error(
      "run-pty must be connected to a terminal (“is TTY”) to run properly."
    );
    process.exit(1);
  }

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

if (require.main === module) {
  run();
}

module.exports = {
  __forTests: {
    ALL_LABELS,
    commandToPresentationName,
    drawDashboard,
    exitText,
    help,
    parseArgs,
    summarizeLabels,
  },
};
