#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const pty = require("node-pty");

/**
 * @typedef {
    | { tag: "Running", terminal: import("node-pty").IPty }
    | { tag: "Killing", terminal: import("node-pty").IPty, slow: boolean, lastKillPress: number | undefined }
    | { tag: "Exit", exitCode: number }
   } Status
 *
 * @typedef {
    | { tag: "Command", index: number }
    | { tag: "Dashboard" }
   } Current
 */

const IS_WINDOWS = process.platform === "win32";

const SLOW_KILL = 100; // ms

// This is apparently what Windows uses for double clicks.
const DOUBLE_PRESS = 500; // ms

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
  navigate: "↑/↓",
  enter: "enter",
};

const KEY_CODES = {
  kill: "\x03",
  restart: "\r",
  dashboard: "\x1a",
  // https://vi.stackexchange.com/questions/15324/up-arrow-key-code-why-a-becomes-oa
  up: "\x1B[A",
  upAlt: "\x1BOA",
  upVim: "k",
  down: "\x1B[B",
  downAlt: "\x1BOB",
  downVim: "j",
  enter: "\r",
  enterVim: "o",
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const LABEL_GROUPS = ["123456789", ALPHABET, ALPHABET.toUpperCase()];
const ALL_LABELS = LABEL_GROUPS.join("");

const HIDE_CURSOR = "\x1B[?25l";
const SHOW_CURSOR = "\x1B[?25h";
const CURSOR_UP = "\x1B[A";
const ENABLE_ALTERNATE_SCREEN = "\x1B[?1049h";
const DISABLE_ALTERNATE_SCREEN = "\x1B[?1049l";
const DISABLE_BRACKETED_PASTE_MODE = "\x1B[?2004l";
const ENABLE_MOUSE = "\x1B[?1000;1006h";
const DISABLE_MOUSE = "\x1B[?1000;1006l";
const RESET_COLOR = "\x1B[m";
const RESET_COLOR_REGEX = /(\x1B\[0?m)/;
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
  // 130 commonly means exit by ctrl+c.
  exitCode === 0 || exitCode === 130
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

const folder = NO_COLOR ? "⌂" : IS_WINDOWS ? `\x1B[2m⌂${RESET_COLOR}` : "📂";

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
 * @returns {string}
 */
const invert = (string) => {
  const inverted = string
    .split(RESET_COLOR_REGEX)
    .map((part, index) => (index % 2 === 0 ? `\x1B[7m${part}` : part))
    .join("");
  return NO_COLOR ? string : `${inverted}${RESET_COLOR}`;
};

/**
 * @param {string} string
 * @param {{ pad?: boolean, highlight?: boolean }} pad
 */
const shortcut = (string, { pad = true } = {}) =>
  dim("[") +
  bold(string) +
  dim("]") +
  (pad ? " ".repeat(Math.max(0, KEYS.kill.length - string.length)) : "");

const runPty = bold("run-pty");
const pc = dim("%");
const at = dim("@");

const [ICON_WIDTH, EMOJI_WIDTH_FIX] =
  IS_WINDOWS || NO_COLOR ? [1, ""] : [2, cursorHorizontalAbsolute(3)];

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

Separate the commands with a character of choice:

    ${runPty} ${pc} npm start ${pc} make watch ${pc} some_command arg1 arg2 arg3

    ${runPty} ${at} ./report_progress.bash --root / --unit % ${at} ping localhost

Note: All arguments are strings and passed as-is – no shell script execution.
Use ${bold("sh -c '...'")} or similar if you need that.

Alternatively, specify the commands in a JSON (or NDJSON) file:

    ${runPty} run-pty.json

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
    ? `kill all ${dim("(double-press to force) ")}`
    : commands.every((command) => command.status.tag === "Exit")
    ? "exit"
    : "kill all";

/**
 * @param {Array<Command>} commands
 * @param {number} width
 * @param {number | undefined} cursorIndex
 * @returns {Array<{ line: string, length: number }>}
 */
const drawDashboardCommandLines = (commands, width, cursorIndex) => {
  const lines = commands.map((command) => {
    const [icon, status] = statusText(command.status, command.statusFromRules);
    return {
      label: shortcut(command.label || " ", { pad: false }),
      icon,
      status,
      title: command.titleWithGraphicRenditions,
    };
  });

  const separator = "  ";

  const widestStatus = Math.max(
    0,
    ...lines.map(({ status }) => (status === undefined ? 0 : status.length))
  );

  return lines.map(({ label, icon, status, title }, index) => {
    const start = truncate(`${label}${separator}${icon}`, width);
    const startLength =
      removeGraphicRenditions(label).length + separator.length + ICON_WIDTH;
    const end =
      status === undefined
        ? title
        : `${status.padEnd(widestStatus, " ")}${separator}${title}`;
    const truncatedEnd = truncate(end, width - startLength - separator.length);
    const length =
      startLength +
      separator.length +
      removeGraphicRenditions(truncatedEnd).length;
    const finalEnd =
      index === cursorIndex
        ? NO_COLOR
          ? `${separator.slice(0, -1)}→${truncatedEnd}`
          : `${separator}${invert(truncatedEnd)}`
        : `${separator}${truncatedEnd}`;
    return {
      line: `${start}${RESET_COLOR}${cursorHorizontalAbsolute(
        startLength + 1
      )}${CLEAR_RIGHT}${finalEnd}${RESET_COLOR}`,
      length,
    };
  });
};

/**
 * @param {Array<Command>} commands
 * @param {number} width
 * @param {boolean} attemptedKillAll
 * @param {number | undefined} cursorIndex
 * @returns {string}
 */
const drawDashboard = (commands, width, attemptedKillAll, cursorIndex) => {
  const done =
    attemptedKillAll &&
    commands.every((command) => command.status.tag === "Exit");

  const finalLines = drawDashboardCommandLines(
    commands,
    width,
    done ? undefined : cursorIndex
  )
    .map(({ line }) => line)
    .join("\n");

  if (done) {
    return `${finalLines}\n`;
  }

  const label = summarizeLabels(commands.map((command) => command.label));

  // Newlines at the end are wanted here.
  return `
${finalLines}

${shortcut(label)} focus command ${dim("(or click)")}
${shortcut(KEYS.enter)} focus selected command
${shortcut(KEYS.navigate)} move selection
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
`.trimStart();
};

/**
 * @typedef {Pick<Command, "formattedCommandWithTitle" | "title" | "cwd">} CommandText
 */

/**
 * @param {CommandText} command
 * @returns {string}
 */
const cwdText = (command) =>
  path.resolve(command.cwd) === process.cwd() || command.cwd === command.title
    ? ""
    : `${folder}${EMOJI_WIDTH_FIX} ${dim(command.cwd)}\n`;

/**
 * @param {CommandText} command
 * @returns {string}
 */
const historyStart = (command) =>
  `${runningIndicator}${EMOJI_WIDTH_FIX} ${
    command.formattedCommandWithTitle
  }${RESET_COLOR}\n${cwdText(command)}`;

/**
 * @param {number} pid
 * @returns {string}
 */
const runningText = (pid) =>
  // Newlines at the start/end are wanted here.
  `
${shortcut(KEYS.kill)} kill ${dim(`(pid ${pid})`)}
${shortcut(KEYS.dashboard)} dashboard

`;

/**
 * @param {CommandText} command
 * @param {number} pid
 * @returns {string}
 */
const killingText = (command, pid) =>
  // Newlines at the start/end are wanted here.
  `
${killingIndicator}${EMOJI_WIDTH_FIX} ${
    command.formattedCommandWithTitle
  }${RESET_COLOR}
${cwdText(command)}killing…

${shortcut(KEYS.kill)} kill ${dim(`(double-press to force) (pid ${pid})`)}
${shortcut(KEYS.dashboard)} dashboard
`;

/**
 * @param {Array<Command>} commands
 * @param {CommandText} command
 * @param {number} exitCode
 * @returns {string}
 */
const exitText = (commands, command, exitCode) =>
  // Newlines at the start/end are wanted here.
  `
${exitIndicator(exitCode)}${EMOJI_WIDTH_FIX} ${
    command.formattedCommandWithTitle
  }${RESET_COLOR}
${cwdText(command)}exit ${exitCode}

${shortcut(KEYS.restart)} restart
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
${shortcut(KEYS.dashboard)} dashboard
`;

/**
 * @param {Status} status
 * @param {string | undefined} statusFromRules
 * @returns {[string, string | undefined]}
 */
const statusText = (status, statusFromRules = runningIndicator) => {
  switch (status.tag) {
    case "Running":
      return [statusFromRules, undefined];

    case "Killing":
      return [killingIndicator, undefined];

    case "Exit":
      return [exitIndicator(status.exitCode), bold(`exit ${status.exitCode}`)];
  }
};

const GRAPHIC_RENDITIONS = /(\x1B\[(?:\d+(?:;\d+)*)?m)/g;
const WINDOWS_HACK = IS_WINDOWS ? "\\0" : "";
const EMPTY_LAST_LINE = RegExp(
  `(?:^|[${WINDOWS_HACK}\\r\\n])(?:(?:[^\\S\\r\\n]|${GRAPHIC_RENDITIONS.source})*|\\^C)$`
);

/**
 * @param {string} string
 * @returns {string}
 */
const removeGraphicRenditions = (string) =>
  string.replace(GRAPHIC_RENDITIONS, "");

/**
 * @param {string} string
 * @param {number} maxLength
 * @returns {string}
 */
const truncate = (string, maxLength) => {
  let result = "";
  let length = 0;
  for (const [index, part] of string.split(GRAPHIC_RENDITIONS).entries()) {
    if (index % 2 === 0) {
      const diff = maxLength - length - part.length;
      if (diff < 0) {
        return `${result + part.slice(0, diff - 1)}…`;
      } else {
        result += part;
        length += part.length;
      }
    } else {
      result += part;
    }
  }
  return result;
};

/**
 * Assumes that `string` ends with a newline, the cursor is at the start of
 * the line and that it’s fine to clear even the first line.
 *
 * @param {string} string
 * @returns {string}
 */
const erase = (string) =>
  `${CURSOR_UP}${CLEAR_RIGHT}`.repeat(string.split("\n").length - 1);

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
      focusOnlyCommand: boolean,
      commandDescription: CommandDescription,
      onData: (data: string, statusFromRulesChanged: boolean) => undefined,
      onExit: () => undefined,
     }} commandInit
   */
  constructor({
    label,
    focusOnlyCommand,
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
    this.title = removeGraphicRenditions(title);
    this.titleWithGraphicRenditions = title;
    this.formattedCommandWithTitle =
      title === formattedCommand
        ? formattedCommand
        : NO_COLOR
        ? `${removeGraphicRenditions(title)}: ${formattedCommand}`
        : `${bold(`${title}${RESET_COLOR}:`)} ${formattedCommand}`;
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
    this.start({ isFocused: focusOnlyCommand });
  }

  /**
   * @param {{ isFocused: boolean }} options
   * @returns {void}
   */
  start({ isFocused }) {
    if (this.status.tag !== "Exit") {
      throw new Error(
        `Cannot start pty with pid ${this.status.terminal.pid} because not exited for: ${this.title}`
      );
    }

    this.history = historyStart(this);
    this.statusFromRules = extractStatus(this.defaultStatus);

    const [file, args] = IS_WINDOWS
      ? [
          "cmd.exe",
          [
            "/d",
            "/s",
            "/q",
            "/c",
            ...(!isFocused
              ? [
                  "node",
                  "-e",
                  cmdEscapeArg("process.stdout.write('\\0')"),
                  // "echo:",
                  "&&",
                ]
              : []),
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

    if (IS_WINDOWS && !isFocused) {
      // Needed when using `conptyInheritCursor`. Otherwise terminals spawned in
      // the background hang and will not run their command until focused.
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
    switch (this.status.tag) {
      case "Running":
        this.status = {
          tag: "Killing",
          terminal: this.status.terminal,
          slow: false,
          lastKillPress: undefined,
        };
        setTimeout(() => {
          if (this.status.tag === "Killing") {
            this.status.slow = true;
            // Ugly way to redraw:
            this.onData("", false);
          }
        }, SLOW_KILL);
        this.status.terminal.write(KEY_CODES.kill);
        return undefined;

      case "Killing": {
        const now = Date.now();
        if (
          this.status.lastKillPress !== undefined &&
          now - this.status.lastKillPress <= DOUBLE_PRESS
        ) {
          if (IS_WINDOWS) {
            this.status.terminal.kill();
          } else {
            this.status.terminal.kill("SIGKILL");
          }
        } else {
          this.status.terminal.write(KEY_CODES.kill);
        }
        this.status.lastKillPress = now;
        return undefined;
      }

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
  /** @type {number | undefined} */
  let cursorIndex = undefined;
  /** @type {string | undefined} */
  let lastExtraText = undefined;

  /**
   * @param {Command} command
   * @param {string} data
   * @returns {undefined}
   */
  const printExtraText = (command, data) => {
    const eraser = lastExtraText === undefined ? "" : erase(lastExtraText);

    switch (command.status.tag) {
      case "Running":
        lastExtraText = data.endsWith("\n")
          ? RESET_COLOR + runningText(command.status.terminal.pid)
          : undefined;
        process.stdout.write(
          eraser + data + (lastExtraText === undefined ? "" : lastExtraText)
        );
        return undefined;

      case "Killing":
        lastExtraText =
          data === "" && command.status.slow
            ? RESET_COLOR + killingText(command, command.status.terminal.pid)
            : undefined;
        process.stdout.write(
          eraser + data + (lastExtraText === undefined ? "" : lastExtraText)
        );
        return undefined;

      case "Exit": {
        const isOnAlternateScreen =
          command.history.lastIndexOf(ENABLE_ALTERNATE_SCREEN) >
          command.history.lastIndexOf(DISABLE_ALTERNATE_SCREEN);

        const maybeNewline =
          !isOnAlternateScreen && EMPTY_LAST_LINE.test(command.history)
            ? ""
            : "\n";

        // This has the side effect of moving the cursor, so only do it if needed.
        const disableAlternateScreen = isOnAlternateScreen
          ? DISABLE_ALTERNATE_SCREEN
          : "";

        lastExtraText =
          HIDE_CURSOR +
          RESET_COLOR +
          disableAlternateScreen +
          maybeNewline +
          exitText(commands, command, command.status.exitCode);

        process.stdout.write(eraser + data + lastExtraText);
        return undefined;
      }
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
        ENABLE_MOUSE +
        RESET_COLOR +
        CLEAR +
        drawDashboard(
          commands,
          process.stdout.columns,
          attemptedKillAll,
          cursorIndex
        )
    );
  };

  /**
   * @param {number} index
   * @returns {void}
   */
  const switchToCommand = (index, { viaMouse = false } = {}) => {
    const command = commands[index];
    current = { tag: "Command", index };
    if (viaMouse) {
      cursorIndex = undefined;
    }

    process.stdout.write(
      SHOW_CURSOR +
        DISABLE_ALTERNATE_SCREEN +
        DISABLE_MOUSE +
        RESET_COLOR +
        CLEAR
    );

    lastExtraText = undefined;

    printExtraText(command, command.history);
  };

  /**
   * @param {number | undefined} index
   * @returns {void}
   */
  const setCursor = (index) => {
    cursorIndex = index;
    // Redraw dashboard.
    switchToDashboard();
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

  const focusOnlyCommand = commandDescriptions.length === 1;

  /** @type {Array<Command>} */
  const commands = commandDescriptions.map(
    (commandDescription, index) =>
      new Command({
        label: ALL_LABELS[index] || "",
        focusOnlyCommand,
        commandDescription,
        onData: (data, statusFromRulesChanged) => {
          switch (current.tag) {
            case "Command":
              if (current.index === index) {
                const command = commands[index];
                switch (command.status.tag) {
                  case "Running":
                  case "Killing":
                    printExtraText(command, data);
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
                printExtraText(command, "");
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
      cursorIndex,
      switchToDashboard,
      switchToCommand,
      setCursor,
      killAll
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
      SHOW_CURSOR + DISABLE_BRACKETED_PASTE_MODE + DISABLE_MOUSE + RESET_COLOR
    );
  });

  if (focusOnlyCommand) {
    switchToCommand(0);
  } else {
    switchToDashboard();
  }
};

/**
 * @param {string} data
 * @param {Current} current
 * @param {Array<Command>} commands
 * @param {number | undefined} cursorIndex
 * @param {() => void} switchToDashboard
 * @param {(index: number, options?: { viaMouse?: boolean }) => void} switchToCommand
 * @param {(index: number | undefined) => void} setCursor
 * @param {() => void} killAll
 * @returns {undefined}
 */
const onStdin = (
  data,
  current,
  commands,
  cursorIndex,
  switchToDashboard,
  switchToCommand,
  setCursor,
  killAll
) => {
  switch (current.tag) {
    case "Command": {
      const command = commands[current.index];
      switch (command.status.tag) {
        case "Running":
        case "Killing":
          switch (data) {
            case KEY_CODES.kill:
              command.kill();
              return undefined;

            case KEY_CODES.dashboard:
              switchToDashboard();
              return undefined;

            default:
              command.status = {
                tag: "Running",
                terminal: command.status.terminal,
              };
              command.status.terminal.write(data);
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
              command.start({ isFocused: true });
              switchToCommand(current.index);
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

        case KEY_CODES.enter:
        case KEY_CODES.enterVim:
          if (cursorIndex !== undefined) {
            switchToCommand(cursorIndex);
          }
          return undefined;

        case KEY_CODES.up:
        case KEY_CODES.upAlt:
        case KEY_CODES.upVim:
          setCursor(
            cursorIndex === undefined || cursorIndex === 0
              ? commands.length - 1
              : cursorIndex - 1
          );
          return undefined;

        case KEY_CODES.down:
        case KEY_CODES.downAlt:
        case KEY_CODES.downVim:
          setCursor(
            cursorIndex === undefined || cursorIndex === commands.length - 1
              ? 0
              : cursorIndex + 1
          );
          return undefined;

        default: {
          const commandIndex = commands.findIndex(
            (command) => command.label === data
          );
          if (commandIndex !== -1) {
            switchToCommand(commandIndex);
            return undefined;
          }

          const mouseupPosition = parseMouse(data);
          if (mouseupPosition === undefined) {
            return undefined;
          }

          const index = getCommandIndexFromMousePosition(
            commands,
            mouseupPosition
          );

          switch (mouseupPosition.type) {
            case "mousedown":
              if (index !== undefined) {
                setCursor(index);
              }
              return undefined;

            case "mouseup": {
              if (index !== undefined && index === cursorIndex) {
                switchToCommand(index, { viaMouse: true });
              } else if (cursorIndex !== undefined) {
                setCursor(undefined);
              }
              return undefined;
            }
          }
        }
      }
  }
};

const MOUSEUP_REGEX = /\x1B\[<0;(\d+);(\d+)([Mm])/;

/**
 * @param {string} string
 * @returns {{ type: "mousedown" | "mouseup", x: number, y: number } | undefined}
 */
const parseMouse = (string) => {
  const match = MOUSEUP_REGEX.exec(string);
  if (match === null) {
    return undefined;
  }
  const [, x, y, type] = match;
  return {
    type: type === "M" ? "mousedown" : "mouseup",
    x: Number(x) - 1,
    y: Number(y) - 1,
  };
};

/**
 * @param {Array<Command>} commands
 * @param {{ x: number, y: number }} mousePosition
 */
const getCommandIndexFromMousePosition = (commands, { x, y }) => {
  const lines = drawDashboardCommandLines(
    commands,
    process.stdout.columns,
    undefined
  );

  if (y >= 0 && y < lines.length) {
    const line = lines[y];
    if (x >= 0 && x < line.length) {
      return y;
    }
  }

  return undefined;
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
    exitText,
    help,
    historyStart,
    killingText,
    parseArgs,
    runningText,
    summarizeLabels,
  },
};
