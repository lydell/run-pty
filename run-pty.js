#!/usr/bin/env node

"use strict";

const colorette = require("colorette");
const pty = require("node-pty");

// node-pty does not support kill signals on Windows.
// This is the same check that node-pty uses.
const IS_WINDOWS = process.platform === "win32";

const MAX_HISTORY_DEFAULT = 10000;

const MAX_HISTORY = (() => {
  const env = process.env.RUN_PTY_MAX_HISTORY;
  return /^\d+$/.test(env) ? Number(env) : MAX_HISTORY_DEFAULT;
})();

const KEYS = {
  kill: "ctrl+c",
  restart: "enter",
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

const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const DISABLE_ALTERNATE_SCREEN = "\u001B[?1049l";
const DISABLE_BRACKETED_PASTE_MODE = "\u001B[?2004l";
const RESET_COLOR = "\u001B[0m";
const CLEAR = IS_WINDOWS ? "\u001B[2J\u001B[0f" : "\u001B[2J\u001B[3J\u001B[H";

const runningIndicator = "🟢";

const killingIndicator = "⭕";

const exitIndicator = (exitCode) => (exitCode === 0 ? "⚪" : "🔴");

const hl = (string) => colorette.blue(colorette.bold(string));
const dim = colorette.gray;

const shortcut = (string, pad = true) =>
  dim("[") +
  hl(string) +
  dim("]") +
  (pad ? " ".repeat(Math.max(0, KEYS.kill.length - string.length)) : "");

const runPty = hl("run-pty");
const pc = dim("%");
const at = dim("@");

const help = `
Run several commands concurrently.
Show output for one command at a time.
Kill all at once.

    ${hl(summarizeLabels(ALL_LABELS.split("")))} focus command
    ${shortcut(KEYS.dashboard)} dashboard
    ${shortcut(KEYS.kill)} kill focused/all
    ${shortcut(KEYS.restart)} restart killed/exited command

Separate the commands with a character of choice:

    ${runPty} ${pc} npm start ${pc} make watch ${pc} some_command arg1 arg2 arg3

    ${runPty} ${at} ./report_progress.bash --root / --unit % ${at} ping localhost

Note: All arguments are strings and passed as-is – no shell script execution.
Use ${hl("sh -c '...'")} or similar if you need that.

Environment variables:

    ${hl("RUN_PTY_MAX_HISTORY")}
        Higher → more command scrollback
        Lower  → faster switching between commands
        Default: ${MAX_HISTORY_DEFAULT} (writes ≈ lines)

    ${hl("NO_COLOR")} and ${hl("FORCE_COLOR")}
        Disable or force colored output.
`.trim();

function killAllLabel(commands) {
  return commands.some((command) => command.status.tag === "Killing")
    ? "force kill all"
    : commands.every((command) => command.status.tag === "Exit")
    ? "exit"
    : "kill all";
}

// Newlines at the end are wanted here.
function drawDashboard(commands, width, attemptedKillAll) {
  const lines = commands.map((command) => [
    shortcut(command.label, false),
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

  if (
    attemptedKillAll &&
    commands.every((command) => command.status.tag === "Exit")
  ) {
    return `${finalLines}\n`;
  }

  return `
${finalLines}

${shortcut(label)} focus command
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
`.trimStart();
}

function firstHistoryLine(name) {
  return `${runningIndicator} ${name}\n`;
}

// Newlines at the start/end are wanted here.
const runningText = `
${shortcut(KEYS.kill)} kill
${shortcut(KEYS.dashboard)} dashboard

`;

// Newlines at the start/end are wanted here.
function killingText(commandName) {
  return `
${killingIndicator} ${commandName}
killing…

${shortcut(KEYS.kill)} force kill
${shortcut(KEYS.dashboard)} dashboard
`;
}

// Newlines at the start/end are wanted here.
function exitText(commands, commandName, exitCode) {
  return `
${exitIndicator(exitCode)} ${commandName}
exit ${exitCode}

${shortcut(KEYS.restart)} restart
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
${shortcut(KEYS.dashboard)} dashboard
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
      /^[\w.,:/=@%+-]+$/.test(part) ? part : `'${part.replace(/'/g, "’")}'`
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
      this.pushHistory(data);
      this.onData(data);
    });

    const disposeOnExit = terminal.onExit(({ exitCode }) => {
      disposeOnData.dispose();
      disposeOnExit.dispose();
      this.status = { tag: "Exit", exitCode };
      this.onExit();
    });

    this.status = { tag: "Running", terminal };
  }

  kill() {
    // https://www.gnu.org/software/libc/manual/html_node/Termination-Signals.html
    switch (this.status.tag) {
      case "Running":
        this.status = {
          tag: "Killing",
          terminal: this.status.terminal,
          slow: false,
        };
        setTimeout(() => {
          if (this.status.tag === "Killing") {
            this.status.slow = true;
            // Ugly way to redraw:
            this.onData("");
          }
        }, 100);
        if (IS_WINDOWS) {
          this.status.terminal.kill();
        } else {
          // SIGHUP causes a silent exit for `npm run`.
          this.status.terminal.kill("SIGHUP");
          // SIGTERM is needed for some programs (but is noisy for `npm run`).
          this.status.terminal.kill("SIGTERM");
        }
        break;

      case "Killing":
        if (IS_WINDOWS) {
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

  pushHistory(data) {
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
    this.history.push(data);
  }
}

function runCommands(rawCommands) {
  let current = { tag: "Dashboard" };
  let attemptedKillAll = false;

  const printHistoryAndExtraText = (command) => {
    process.stdout.write(
      SHOW_CURSOR + DISABLE_ALTERNATE_SCREEN + RESET_COLOR + CLEAR
    );

    for (const data of command.history) {
      process.stdout.write(data);
    }

    switch (command.status.tag) {
      case "Running":
        if (
          command.history.length > 0 &&
          command.history[command.history.length - 1].endsWith("\n")
        ) {
          process.stdout.write(RESET_COLOR + runningText);
        }
        break;

      case "Killing":
        if (command.status.slow) {
          process.stdout.write(
            HIDE_CURSOR + RESET_COLOR + killingText(command.name)
          );
        }
        break;

      case "Exit":
        process.stdout.write(
          HIDE_CURSOR +
            RESET_COLOR +
            exitText(commands, command.name, command.status.exitCode)
        );
        break;

      default:
        throw new Error(`Unknown command status: ${command.status.tag}`);
    }
  };

  const switchToDashboard = () => {
    current = { tag: "Dashboard" };
    process.stdout.write(
      HIDE_CURSOR +
        DISABLE_ALTERNATE_SCREEN +
        RESET_COLOR +
        CLEAR +
        drawDashboard(commands, process.stdout.columns, attemptedKillAll)
    );
  };

  const switchToCommand = (index) => {
    const command = commands[index];
    current = { tag: "Command", index };
    printHistoryAndExtraText(command);
  };

  const killAll = () => {
    attemptedKillAll = true;
    const notExited = commands.filter(
      (command) => command.status.tag !== "Exit"
    );
    if (notExited.length === 0) {
      switchToDashboard();
      process.exit(0);
    } else {
      for (const command of notExited) {
        command.kill();
      }
      // So you can see how killing other commands go:
      switchToDashboard();
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
            const command = commands[current.index];
            switch (command.status.tag) {
              case "Running":
                process.stdout.write(data);
                break;

              case "Killing":
                // Redraw with killingText at the bottom.
                printHistoryAndExtraText(command);
                break;

              case "Exit":
                throw new Error(
                  `Received unexpected output from pty with pid ${this.status.terminal.pid} which already exited for: ${this.name}\n${data}`
                );

              default:
                throw new Error(
                  `Unknown command status: ${command.status.tag}`
                );
            }
          }
        },
        onExit: () => {
          switch (current.tag) {
            case "Command":
              if (current.index === index) {
                const command = commands[index];
                // Redraw current command.
                printHistoryAndExtraText(command);
              }
              break;

            case "Dashboard":
              // Redraw dashboard.
              switchToDashboard();
              break;

            default:
              throw new Error(`Unknown current state: ${current.tag}`);
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
      printHistoryAndExtraText
    );
  });

  // Clean up all commands if someone tries to kill run-pty.
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      killAll();
    });
  }

  // Don’t leave running processes behind in case of an unexpected error.
  for (const event of ["uncaughtException", "unhandledRejection"]) {
    process.on(event, (error) => {
      console.error(error);
      for (const command of commands) {
        if (command.status.tag !== "Exit") {
          if (IS_WINDOWS) {
            command.status.terminal.kill();
          } else {
            command.status.terminal.kill("SIGKILL");
          }
        }
      }
      process.exit(1);
    });
  }

  process.on("exit", () => {
    process.stdout.write(
      SHOW_CURSOR + DISABLE_BRACKETED_PASTE_MODE + RESET_COLOR
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
  printHistoryAndExtraText
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
              break;

            case KEY_CODES.dashboard:
              switchToDashboard();
              break;

            case KEY_CODES.restart:
              command.start();
              printHistoryAndExtraText(command);
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
    help,
    parseArgs,
    summarizeLabels,
  },
};
