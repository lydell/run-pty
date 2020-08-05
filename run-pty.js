#!/usr/bin/env node

"use strict";

const pty = require("node-pty");
// const crossSpawnParse = require("cross-spawn/lib/parse");

/**
 * @typedef {
    | { tag: "Running", terminal: import("node-pty").IPty }
    | { tag: "Killing", terminal: import("node-pty").IPty, slow: boolean }
    | { tag: "Exit", exitCode: number }
   } Status
 *
 * @typedef {
    | { tag: "Command", index: number }
    | { tag: "Dashboard" }
   } Current
 */

// node-pty does not support kill signals on Windows.
// This is the same check that node-pty uses.
const IS_WINDOWS = process.platform === "win32";

const MAX_HISTORY_DEFAULT = 1000000;

const MAX_HISTORY = (() => {
  const env = process.env.RUN_PTY_MAX_HISTORY;
  return env !== undefined && /^\d+$/.test(env)
    ? Number(env)
    : MAX_HISTORY_DEFAULT;
})();

const NO_COLOR = "NO_COLOR" in process.env;

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

const HIDE_CURSOR = "\x1B[?25l";
const SHOW_CURSOR = "\x1B[?25h";
const DISABLE_ALTERNATE_SCREEN = "\x1B[?1049l";
const DISABLE_BRACKETED_PASTE_MODE = "\x1B[?2004l";
const RESET_COLOR = "\x1B[0m";
const CLEAR = IS_WINDOWS ? "\x1B[2J\x1B[0f" : "\x1B[2J\x1B[3J\x1B[H";

const runningIndicator = IS_WINDOWS ? ">" : "🟢";

const killingIndicator = IS_WINDOWS ? "@" : "⭕";

/**
 * @param {number} exitCode
 * @returns {string}
 */
const exitIndicator = (exitCode) =>
  exitCode === 0 ? (IS_WINDOWS ? "." : "⚪") : IS_WINDOWS ? "!" : "🔴";

/**
 * @param {string} string
 * @returns {string}
 */
const bold = (string) => (NO_COLOR ? string : `\x1B[1m${string}${RESET_COLOR}`);

/**
 * @param {string} string
 * @returns {string}
 */
const dim = (string) => (NO_COLOR ? string : `\x1B[2m${string}${RESET_COLOR}`);

/**
 * @param {string} string
 * @param {{ pad?: boolean }} pad
 */
const shortcut = (string, { pad = true } = {}) =>
  dim("[") +
  bold(string) +
  dim("]") +
  (pad ? " ".repeat(Math.max(0, KEYS.kill.length - string.length)) : "");

const runPty = bold("run-pty");
const pc = dim("%");
const at = dim("@");

/**
 * @param {Array<string>} labels
 * @returns {string}
 */
const summarizeLabels = (labels) => {
  const numLabels = labels.length;
  return LABEL_GROUPS.flatMap((group, index) => {
    const previousLength = LABEL_GROUPS.slice(0, index).reduce(
      (sum, previousGroup) => sum + previousGroup.length,
      0
    );
    const currentLength = previousLength + group.length;
    return numLabels > previousLength
      ? numLabels < currentLength
        ? group.slice(0, numLabels - previousLength)
        : group
      : [];
  })
    .map((group) =>
      group.length === 1 ? group[0] : `${group[0]}-${group[group.length - 1]}`
    )
    .join("/");
};

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
Use ${bold("sh -c '...'")} or similar if you need that.

Environment variables:

    ${bold("RUN_PTY_MAX_HISTORY")}
        Number of characters of output to remember.
        Higher → more command scrollback
        Lower  → faster switching between commands
        Default: ${MAX_HISTORY_DEFAULT}

    ${bold("NO_COLOR")}
        Disable colored output.
`.trim();

/**
 * @param {Array<Command>} commands
 * @returns {string}
 */
const killAllLabel = (commands) =>
  commands.some((command) => command.status.tag === "Killing")
    ? "force kill all"
    : commands.every((command) => command.status.tag === "Exit")
    ? "exit"
    : "kill all";

/**
 * @param {Array<Command>} commands
 * @param {number} width
 * @param {boolean} attemptedKillAll
 */
const drawDashboard = (commands, width, attemptedKillAll) => {
  const lines = commands.map((command) => [
    shortcut(command.label || " ", { pad: false }),
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

  // Newlines at the end are wanted here.
  return `
${finalLines}

${shortcut(label)} focus command
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
`.trimStart();
};

/**
 * @param {string} name
 * @returns {string}
 */
const firstHistoryLine = (name) => `${runningIndicator} ${name}\n`;

// Newlines at the start/end are wanted here.
const runningText = `
${shortcut(KEYS.kill)} kill
${shortcut(KEYS.dashboard)} dashboard

`;

/**
 * @param {string} commandName
 * @returns {string}
 */
const killingText = (commandName) =>
  // Newlines at the start/end are wanted here.
  `
${killingIndicator} ${commandName}
killing…

${shortcut(KEYS.kill)} force kill
${shortcut(KEYS.dashboard)} dashboard
`;

/**
 * @param {Array<Command>} commands
 * @param {string} commandName
 * @param {number} exitCode
 * @returns {string}
 */
const exitText = (commands, commandName, exitCode) =>
  // Newlines at the start/end are wanted here.
  `
${exitIndicator(exitCode)} ${commandName}
exit ${exitCode}

${shortcut(KEYS.restart)} restart
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
${shortcut(KEYS.dashboard)} dashboard
`;

/**
 * @param {Status} status
 * @returns {string}
 */
const statusText = (status) => {
  switch (status.tag) {
    case "Running":
      return `${runningIndicator} pid ${status.terminal.pid}`;

    case "Killing":
      return `${killingIndicator} pid ${status.terminal.pid}`;

    case "Exit":
      return `${exitIndicator(status.exitCode)} exit ${status.exitCode}`;
  }
};

/**
 * @param {string} string
 * @returns {string}
 */
const removeColor = (string) =>
  // eslint-disable-next-line no-control-regex
  string.replace(/\x1B\[\d+m/g, "");

/**
 * @param {string} string
 * @param {number} maxLength
 * @returns {string}
 */
const truncate = (string, maxLength) => {
  const diff = removeColor(string).length - maxLength;
  return diff <= 0 ? string : `${string.slice(0, -(diff + 2))}…`;
};

/**
 * @param {string} string
 * @param {number} maxLength
 * @returns {string}
 */
const padEnd = (string, maxLength) => {
  const chars = Array.from(string);
  return chars
    .concat(
      Array.from({ length: Math.max(0, maxLength - chars.length) }, () => " ")
    )
    .join("");
};

/**
 * @param {Array<string>} command
 * @returns {string}
 */
const commandToPresentationName = (command) =>
  command
    .map((part) =>
      /^[\w.,:/=@%+-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`
    )
    .join(" ");

/**
 * @typedef {
    | { tag: "Help" }
    | { tag: "Error", message: string }
    | { tag: "Parsed", commands: Array<Array<string>> }
   } ParseResult
 */

/**
 * @param {Array<string>} args
 * @returns {ParseResult}
 */
const parseArgs = (args) => {
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
};

class Command {
  /**
   * @param {{
      label: string,
      file: string,
      args: Array<string>,
      onData: (data: string) => undefined,
      onExit: () => undefined,
     }} commandInit
   */
  constructor({ label, file, args, onData, onExit }) {
    this.label = label;
    this.file = file;
    this.args = args;
    this.name = commandToPresentationName([file, ...args]);
    this.onData = onData;
    this.onExit = onExit;
    /** @type {string} */
    this.history = "";
    /** @type {Status} */
    this.status = { tag: "Exit", exitCode: 0 };
    this.start();
  }

  /**
   * @returns {void}
   */
  start() {
    if (this.status.tag !== "Exit") {
      throw new Error(
        `Cannot start pty with pid ${this.status.terminal.pid} because not exited for: ${this.name}`
      );
    }

    this.history = firstHistoryLine(this.name);

    // const { command: file, args } = crossSpawnParse(this.file, this.args, {});
    const [file, args] = IS_WINDOWS
      ? ["", ["/d", "/s", "/q", "/c", ...this.args]]
      : [this.file, this.args];
    const terminal = pty.spawn(file, args, {
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

  /**
   * @returns {undefined}
   */
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
        return undefined;

      case "Killing":
        if (IS_WINDOWS) {
          this.status.terminal.kill();
        } else {
          this.status.terminal.kill("SIGKILL");
        }
        return undefined;

      case "Exit":
        throw new Error(`Cannot kill already exited pty for: ${this.name}`);
    }
  }

  /**
   * @param {string} data
   * @returns {void}
   */
  pushHistory(data) {
    this.history += data;
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }
}

/**
 * @param {Array<Array<string>>} rawCommands
 */
const runCommands = (rawCommands) => {
  /** @type {Current} */
  let current = { tag: "Dashboard" };
  let attemptedKillAll = false;

  /**
   * @param {Command} command
   * @returns {undefined}
   */
  const printHistoryAndExtraText = (command) => {
    process.stdout.write(
      SHOW_CURSOR +
        DISABLE_ALTERNATE_SCREEN +
        RESET_COLOR +
        CLEAR +
        command.history
    );

    switch (command.status.tag) {
      case "Running":
        if (command.history.endsWith("\n")) {
          process.stdout.write(RESET_COLOR + runningText);
        }
        return undefined;

      case "Killing":
        if (command.status.slow) {
          process.stdout.write(
            HIDE_CURSOR + RESET_COLOR + killingText(command.name)
          );
        }
        return undefined;

      case "Exit":
        process.stdout.write(
          HIDE_CURSOR +
            RESET_COLOR +
            exitText(commands, command.name, command.status.exitCode)
        );
        return undefined;
    }
  };

  /**
   * @returns {void}
   */
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

  /**
   * @param {number} index
   * @returns {void}
   */
  const switchToCommand = (index) => {
    const command = commands[index];
    current = { tag: "Command", index };
    printHistoryAndExtraText(command);
  };

  /**
   * @returns {void}
   */
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

  /** @type {Array<Command>} */
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
                return undefined;

              case "Killing":
                // Redraw with killingText at the bottom.
                printHistoryAndExtraText(command);
                return undefined;

              case "Exit":
                throw new Error(
                  `Received unexpected output from already exited pty for: ${command.name}\n${data}`
                );
            }
          } else {
            return undefined;
          }
        },
        onExit: () => {
          // Exit the whole program if all commands are killed.
          if (
            attemptedKillAll &&
            commands.every((command2) => command2.status.tag === "Exit")
          ) {
            switchToDashboard();
            process.exit(0);
          }

          switch (current.tag) {
            case "Command":
              if (current.index === index) {
                const command = commands[index];
                // Redraw current command.
                printHistoryAndExtraText(command);
              }
              return undefined;

            case "Dashboard":
              // Redraw dashboard.
              switchToDashboard();
              return undefined;
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

  process.stdin.on("data", (data) => {
    onStdin(
      data.toString("utf8"),
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
    process.on(signal, killAll);
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
};

/**
 * @param {string} data
 * @param {Current} current
 * @param {Array<Command>} commands
 * @param {() => void} switchToDashboard
 * @param {(index: number) => void} switchToCommand
 * @param {() => void} killAll
 * @param {(command: Command) => void} printHistoryAndExtraText
 * @returns {undefined}
 */
const onStdin = (
  data,
  current,
  commands,
  switchToDashboard,
  switchToCommand,
  killAll,
  printHistoryAndExtraText
) => {
  switch (current.tag) {
    case "Command": {
      const command = commands[current.index];
      switch (command.status.tag) {
        case "Running":
          switch (data) {
            case KEY_CODES.kill:
              command.kill();
              return undefined;

            case KEY_CODES.dashboard:
              switchToDashboard();
              return undefined;

            default:
              command.status.terminal.write(data);
              return undefined;
          }

        case "Killing":
          switch (data) {
            case KEY_CODES.kill:
              command.kill();
              return undefined;

            case KEY_CODES.dashboard:
              switchToDashboard();
              return undefined;

            default:
              return undefined;
          }

        case "Exit":
          switch (data) {
            case KEY_CODES.kill:
              killAll();
              return undefined;

            case KEY_CODES.dashboard:
              switchToDashboard();
              return undefined;

            case KEY_CODES.restart:
              command.start();
              printHistoryAndExtraText(command);
              return undefined;

            default:
              return undefined;
          }
      }
    }

    case "Dashboard":
      switch (data) {
        case KEY_CODES.kill:
          killAll();
          return undefined;

        default: {
          const commandIndex = commands.findIndex(
            (command) => command.label === data
          );
          if (commandIndex !== -1) {
            switchToCommand(commandIndex);
          }
          return undefined;
        }
      }
  }
};

/**
 * @returns {undefined}
 */
const run = () => {
  if (!process.stdin.isTTY) {
    console.error("run-pty requires stdin to be a TTY to run properly.");
    process.exit(1);
  }

  const parseResult = parseArgs(process.argv.slice(2));

  switch (parseResult.tag) {
    case "Help":
      console.log(help);
      process.exit(0);

    case "Parsed":
      runCommands(parseResult.commands);
      return undefined;

    case "Error":
      console.error(parseResult.message);
      process.exit(1);
  }
};

// @ts-ignore
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
