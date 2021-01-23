#!/usr/bin/env node

"use strict";

const fs = require("fs");
const pty = require("node-pty");

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
const RESET_COLOR = "\x1B[m";
const CLEAR = IS_WINDOWS ? "\x1B[2J\x1B[0f" : "\x1B[2J\x1B[3J\x1B[H";
const CLEAR_RIGHT = "\x1B[K";

const runningIndicator = NO_COLOR
  ? "›"
  : IS_WINDOWS
  ? `\x1B[92m●${RESET_COLOR}`
  : "🟢";

const killingIndicator = NO_COLOR
  ? "○"
  : IS_WINDOWS
  ? `\x1B[91m○${RESET_COLOR}`
  : "⭕";

/**
 * @param {number} exitCode
 * @returns {string}
 */
const exitIndicator = (exitCode) =>
  exitCode === 0
    ? NO_COLOR
      ? "●"
      : IS_WINDOWS
      ? `\x1B[97m●${RESET_COLOR}`
      : "⚪"
    : NO_COLOR
    ? "×"
    : IS_WINDOWS
    ? `\x1B[91m●${RESET_COLOR}`
    : "🔴";

/**
 * @param {number} n
 * @returns {string}
 */
const cursorHorizontalAbsolute = (n) => `\x1B[${n}G`;

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
  const lines = commands.map((command) => {
    const [icon, status] = statusText(command.status, command.statusFromRules);
    return {
      label: shortcut(command.label || " ", { pad: false }),
      icon,
      status,
      title: command.title,
    };
  });

  const widestStatus = Math.max(0, ...lines.map(({ status }) => status.length));

  const finalLines = lines
    .map(({ label, icon, status, title }) => {
      const separator = "  ";
      const start = truncate([label, icon].join(separator), width);
      const end = [status.padEnd(widestStatus, " "), title].join(separator);
      const iconWidth = IS_WINDOWS || NO_COLOR ? 1 : 2;
      const cursor = cursorHorizontalAbsolute(
        removeGraphicRenditions(label).length + separator.length + iconWidth + 1
      );
      return truncate(
        `${start}${cursor}${separator}${CLEAR_RIGHT}${end}`,
        width
      );
    })
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
 * @param {string | undefined} statusFromRules
 * @returns {[string, string]}
 */
const statusText = (status, statusFromRules = runningIndicator) => {
  switch (status.tag) {
    case "Running":
      return [statusFromRules, `pid ${status.terminal.pid}`];

    case "Killing":
      return [killingIndicator, `pid ${status.terminal.pid}`];

    case "Exit":
      return [exitIndicator(status.exitCode), `exit ${status.exitCode}`];
  }
};

/**
 * @param {string} string
 * @returns {string}
 */
const removeGraphicRenditions = (string) =>
  // eslint-disable-next-line no-control-regex
  string.replace(/\x1B\[(?:\d+(?:;\d+)*)?m/g, "");

/**
 * @param {string} string
 * @param {number} maxLength
 * @returns {string}
 */
const truncate = (string, maxLength) => {
  const diff = removeGraphicRenditions(string).length - maxLength;
  return diff <= 0 ? string : `${string.slice(0, -(diff + 2))}…`;
};

/**
 * @param {Array<string>} command
 * @returns {string}
 */
const commandToPresentationName = (command) =>
  command
    .map((part) =>
      part === ""
        ? "''"
        : part
            .split(/(')/)
            .map((subPart) =>
              subPart === ""
                ? ""
                : subPart === "'"
                ? "\\'"
                : /^[\w.,:/=@%+-]+$/.test(subPart)
                ? subPart
                : `'${subPart}'`
            )
            .join("")
    )
    .join(" ");

/**
 * @param {string} arg
 * @returns {string}
 */
const cmdEscapeMetaChars = (arg) =>
  // https://qntm.org/cmd
  arg.replace(/[()%!^"<>&|;, ]/g, "^$&");

/**
 * @param {string} arg
 * @returns {string}
 */
const cmdEscapeArg = (arg) =>
  // https://qntm.org/cmd
  cmdEscapeMetaChars(
    `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
  );

/**
 * @typedef {
    | { tag: "Help" }
    | { tag: "NoCommands" }
    | { tag: "Error", message: string }
    | { tag: "Parsed", commands: Array<CommandDescription> }
   } ParseResult
 *
 * @typedef {{
    title: string,
    cwd: string,
    command: Array<string>,
    status: Array<[RegExp, [string, string] | undefined]>
    defaultStatus: [string, string] | undefined
   }} CommandDescription
 */

/**
 * @param {Array<string>} args
 * @returns {ParseResult}
 */
const parseArgs = (args) => {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    return { tag: "Help" };
  }

  if (args.length === 1) {
    try {
      const commands = parseInputFile(fs.readFileSync(args[0], "utf8"));
      return commands.length === 0
        ? { tag: "NoCommands" }
        : { tag: "Parsed", commands };
    } catch (errorAny) {
      /** @type {Error & {code?: string} | undefined} */
      const error = errorAny instanceof Error ? errorAny : undefined;
      return {
        tag: "Error",
        message:
          error === undefined
            ? "An unknown error occurred when reading command descriptions file."
            : typeof error.code === "string"
            ? [
                "The first argument is either the delimiter to use between commands,",
                "or the path to a JSON file that describes the commands.",
                "If you meant to use a file, make sure it exists.",
                "Otherwise, choose a delimiter like % and provide at least one command.",
                error.message,
              ].join("\n")
            : [
                "Failed to read command descriptions file as JSON:",
                error.message,
              ].join("\n"),
      };
    }
  }

  const delimiter = args[0];

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
    return { tag: "NoCommands" };
  }

  return {
    tag: "Parsed",
    commands: commands.map((command2) => ({
      title: commandToPresentationName(command2),
      cwd: ".",
      command: command2,
      status: [],
      defaultStatus: undefined,
    })),
  };
};

/**
 * @param {string} string
 * @returns {Array<CommandDescription>}
 */
const parseInputFile = (string) => {
  const first = string.trimStart().slice(0, 1);
  switch (first) {
    case "[": {
      /** @type {unknown} */
      const json = JSON.parse(string);
      if (!Array.isArray(json)) {
        throw new Error(`Expected an array but got: ${JSON.stringify(json)}`);
      }

      return json.map((item, index) => {
        try {
          return parseInputItem(item);
        } catch (error) {
          throw new Error(
            `Index ${index}: ${
              error instanceof Error ? error.message : "Unknown parse error"
            }`
          );
        }
      });
    }

    case "{":
      return string.split("\n").flatMap((line, lineIndex) => {
        const trimmed = line.trim();
        if (trimmed === "") {
          return [];
        }

        try {
          return parseInputItem(JSON.parse(trimmed));
        } catch (error) {
          throw new Error(
            `Line ${lineIndex + 1}: ${
              error instanceof Error ? error.message : "Unknown parse error"
            }`
          );
        }
      });

    default:
      throw new Error(
        `Expected input to start with [ or { but got: ${first || "nothing"}`
      );
  }
};

/**
 * @param {unknown} json
 * @returns {CommandDescription}
 */
const parseInputItem = (json) => {
  if (typeof json !== "object" || Array.isArray(json) || json === null) {
    throw new Error(`Expected a JSON object but got: ${JSON.stringify(json)}`);
  }

  /** @type {Partial<CommandDescription>} */
  const commandDescription = {};

  for (const [key, value] of Object.entries(json)) {
    switch (key) {
      case "title":
        if (typeof value !== "string") {
          throw new Error(
            `title: Expected a string but got: ${JSON.stringify(value)}`
          );
        }
        commandDescription.title = value;
        break;

      case "cwd":
        if (typeof value !== "string") {
          throw new Error(
            `cwd: Expected a string but got: ${JSON.stringify(value)}`
          );
        }
        commandDescription.cwd = value;
        break;

      case "command": {
        if (!Array.isArray(value)) {
          throw new Error(
            `command: Expected an array but got: ${JSON.stringify(value)}`
          );
        }

        const command = [];
        for (const [index, item] of value.entries()) {
          if (typeof item !== "string") {
            throw new Error(
              `command[${index}]: Expected a string but got: ${JSON.stringify(
                value
              )}`
            );
          }
          command.push(item);
        }

        if (command.length === 0) {
          throw new Error("command: Expected a non-empty array");
        }

        commandDescription.command = command;
        break;
      }

      case "status": {
        if (typeof json !== "object" || Array.isArray(json) || json === null) {
          throw new Error(
            `status: Expected an object but got: ${JSON.stringify(value)}`
          );
        }

        /** @type {Array<[RegExp, [string, string] | undefined]>} */
        const status = [];
        for (const [key2, value2] of Object.entries(value)) {
          try {
            status.push([RegExp(key2, "u"), parseStatus(value2)]);
          } catch (error) {
            throw new Error(
              `status[${JSON.stringify(key2)}]: ${
                error instanceof SyntaxError
                  ? `This key is not a valid regex: ${error.message}`
                  : error instanceof Error
                  ? error.message
                  : "Unknown error"
              }`
            );
          }
        }

        commandDescription.status = status;
        break;
      }

      case "defaultStatus":
        try {
          commandDescription.defaultStatus = parseStatus(value);
        } catch (error) {
          throw new Error(
            `defaultStatus: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
        break;

      default:
        throw new Error(`Unknown key: ${key}`);
    }
  }

  if (commandDescription.command === undefined) {
    throw new Error("command: This field is required, but was not provided.");
  }

  const {
    command,
    title = commandToPresentationName(command),
    cwd = ".",
    status = [],
    defaultStatus,
  } = commandDescription;

  return { title, cwd, command, status, defaultStatus };
};

/**
 * @param {unknown} json
 * @returns {[string, string] | undefined}
 */
const parseStatus = (json) => {
  if (json === null) {
    return undefined;
  }

  if (!Array.isArray(json) || json.length !== 2) {
    throw new Error(
      `Expected an array of length 2 but got: ${JSON.stringify(json)}`
    );
  }

  /** @type {unknown} */
  const value1 = json[0];
  /** @type {unknown} */
  const value2 = json[1];

  if (typeof value1 !== "string" || typeof value2 !== "string") {
    throw new Error(`Expected two strings but got: ${JSON.stringify(json)}`);
  }

  return [value1, value2];
};

class Command {
  /**
   * @param {{
      label: string,
      commandDescription: CommandDescription,
      onData: (data: string, statusFromRulesChanged: boolean) => undefined,
      onExit: () => undefined,
     }} commandInit
   */
  constructor({
    label,
    commandDescription: {
      title,
      cwd,
      command: [file, ...args],
      status: statusRules,
      defaultStatus,
    },
    onData,
    onExit,
  }) {
    const formattedCommand = commandToPresentationName([file, ...args]);
    this.label = label;
    this.file = file;
    this.args = args;
    this.cwd = cwd;
    this.title = title;
    this.formattedCommandWithTitle =
      title === formattedCommand
        ? formattedCommand
        : `${bold(`${title}:`)} ${formattedCommand}`;
    this.onData = onData;
    this.onExit = onExit;
    /** @type {string} */
    this.history = "";
    /** @type {Status} */
    this.status = { tag: "Exit", exitCode: 0 };
    /** @type {string | undefined} */
    this.statusFromRules = extractStatus(defaultStatus);
    /** @type {[string, string] | undefined} */
    this.defaultStatus = defaultStatus;
    /** @type {Array<[RegExp, [string, string] | undefined]>} */
    this.statusRules = statusRules;
    this.start();
  }

  /**
   * @returns {void}
   */
  start() {
    if (this.status.tag !== "Exit") {
      throw new Error(
        `Cannot start pty with pid ${this.status.terminal.pid} because not exited for: ${this.title}`
      );
    }

    this.history = firstHistoryLine(this.formattedCommandWithTitle);
    this.statusFromRules = extractStatus(this.defaultStatus);

    const [file, args] = IS_WINDOWS
      ? [
          "cmd.exe",
          [
            "/d",
            "/s",
            "/q",
            "/c",
            cmdEscapeMetaChars(this.file),
            ...this.args.map(cmdEscapeArg),
          ].join(" "),
        ]
      : [this.file, this.args];
    const terminal = pty.spawn(file, args, {
      cwd: this.cwd,
      cols: process.stdout.columns,
      rows: process.stdout.rows,
      // Avoid conpty adding escape sequences to clear the screen:
      conptyInheritCursor: true,
    });

    if (IS_WINDOWS) {
      // Needed when using `conptyInheritCursor`. Otherwise the spawned
      // terminals hang and will not run their command.
      terminal.write("\x1B[1;1R");
    }

    const disposeOnData = terminal.onData((data) => {
      const statusFromRulesChanged = this.pushHistory(data);
      this.onData(data, statusFromRulesChanged);
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
            this.onData("", false);
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
        throw new Error(`Cannot kill already exited pty for: ${this.title}`);
    }
  }

  /**
   * @param {string} data
   * @returns {boolean}
   */
  pushHistory(data) {
    const statusFromRulesChanged = this.updateStatusFromRules(data);
    this.history += data;
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    return statusFromRulesChanged;
  }

  /**
   * @param {string} data
   * @returns {boolean}
   */
  updateStatusFromRules(data) {
    const previousStatusFromRules = this.statusFromRules;
    const lastLine = getLastLine(this.history);
    const lines = (lastLine + data).split(/(?:\r?\n|\r)/);

    for (const line of lines) {
      for (const [regex, status] of this.statusRules) {
        if (regex.test(removeGraphicRenditions(line))) {
          this.statusFromRules = extractStatus(status);
        }
      }
    }

    return this.statusFromRules !== previousStatusFromRules;
  }
}

/**
 * @param {[string, string] | undefined} status
 * @returns {string | undefined}
 */
const extractStatus = (status) =>
  status === undefined
    ? undefined
    : NO_COLOR
    ? removeGraphicRenditions(status[1])
    : IS_WINDOWS
    ? status[1]
    : status[0];

/**
 * @param {string} string
 * @returns {string}
 */
const getLastLine = (string) => {
  let index = string.length - 1;
  while (index >= 0) {
    const char = string[index];
    if (char === "\n" || char === "\r") {
      break;
    }
    index--;
  }
  return string.slice(index + 1);
};

/**
 * @param {Array<CommandDescription>} commandDescriptions
 * @returns {void}
 */
const runCommands = (commandDescriptions) => {
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
        if (
          command.history.endsWith("\n") ||
          command.history.endsWith(`\n${RESET_COLOR}`)
        ) {
          process.stdout.write(RESET_COLOR + runningText);
        }
        return undefined;

      case "Killing":
        if (command.status.slow) {
          process.stdout.write(
            HIDE_CURSOR +
              RESET_COLOR +
              killingText(command.formattedCommandWithTitle)
          );
        }
        return undefined;

      case "Exit":
        process.stdout.write(
          HIDE_CURSOR +
            RESET_COLOR +
            exitText(
              commands,
              command.formattedCommandWithTitle,
              command.status.exitCode
            )
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
  const commands = commandDescriptions.map(
    (commandDescription, index) =>
      new Command({
        label: ALL_LABELS[index] || "",
        commandDescription,
        onData: (data, statusFromRulesChanged) => {
          switch (current.tag) {
            case "Command":
              if (current.index === index) {
                const command = commands[index];
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
                      `Received unexpected output from already exited pty for: ${command.title}\n${data}`
                    );
                }
              }
              return undefined;

            case "Dashboard":
              if (statusFromRulesChanged) {
                // Redraw dashboard.
                switchToDashboard();
              }
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

    case "NoCommands":
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
