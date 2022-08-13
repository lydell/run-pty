#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const pty = require("node-pty");
const Decode = require("tiny-decoders");

/**
 * @typedef {
    | { tag: "Waiting" }
    | { tag: "Running", terminal: import("node-pty").IPty }
    | { tag: "Killing", terminal: import("node-pty").IPty, slow: boolean, lastKillPress: number | undefined }
    | { tag: "Exit", exitCode: number, wasKilled: boolean }
   } Status
 *
 * @typedef {
    | { tag: "Command", index: number }
    | { tag: "Dashboard" }
   } Current
 */

const IS_WINDOWS = process.platform === "win32";
const IS_WINDOWS_TERMINAL = "WT_SESSION" in process.env; // https://github.com/microsoft/terminal/issues/1040
const SUPPORTS_EMOJI = !IS_WINDOWS || IS_WINDOWS_TERMINAL;

// https://github.com/sindresorhus/ansi-escapes/blob/2b3b59c56ff77a2afdee946bff96f1779d10d775/index.js#L5
const IS_TERMINAL_APP = process.env.TERM_PROGRAM === "Apple_Terminal";

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
  unselect: "escape",
};

const KEY_CODES = {
  kill: "\x03",
  restart: "\r",
  dashboard: "\x1a",
  up: "\x1B[A",
  down: "\x1B[B",
  enter: "\r",
  esc: "\x1B",
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const LABEL_GROUPS = ["123456789", ALPHABET, ALPHABET.toUpperCase()];
const ALL_LABELS = LABEL_GROUPS.join("");

const HIDE_CURSOR = "\x1B[?25l";
const SHOW_CURSOR = "\x1B[?25h";
const ENABLE_ALTERNATE_SCREEN = "\x1B[?1049h";
const DISABLE_ALTERNATE_SCREEN = "\x1B[?1049l";
const ALTERNATE_SCREEN_REGEX = /(\x1B\[\?1049[hl])/;
const DISABLE_BRACKETED_PASTE_MODE = "\x1B[?2004l";
const DISABLE_APPLICATION_CURSOR_KEYS = "\x1B[?1l"; // https://www.vt100.net/docs/vt510-rm/DECCKM.html
const ENABLE_MOUSE = "\x1B[?1000;1006h";
const DISABLE_MOUSE = "\x1B[?1000;1006l";
const RESET_COLOR = "\x1B[m";
const CLEAR = "\x1B[2J\x1B[3J\x1B[H";
const CLEAR_LEFT = "\x1B[1K";
const CLEAR_RIGHT = "\x1B[K";
const CLEAR_DOWN = "\x1B[J";
const CLEAR_DOWN_REGEX = /\x1B\[0?J$/;
// These save/restore cursor position _and graphic renditions._
const SAVE_CURSOR = IS_TERMINAL_APP ? "\u001B7" : "\x1B[s";
const RESTORE_CURSOR = IS_TERMINAL_APP ? "\u001B8" : "\x1B[u";

const CLEAR_REGEX = (() => {
  const goToTopLeft = /(?:[01](?:;[01])?)?[fH]/;
  const clearDown = /0?J/;
  const clearScreen = /2J/;
  const clearScrollback = /3J/;

  /**
   * @template T
   * @param {Array<T>} items
   * @returns {Array<Array<T>>}
   */
  const permutations = (items) =>
    items.length <= 1
      ? [items]
      : items.flatMap((first, index) =>
          permutations([
            ...items.slice(0, index),
            ...items.slice(index + 1),
          ]).map((rest) => [first, ...rest])
        );

  const variants = [
    ...permutations([clearScreen, clearScrollback, goToTopLeft]),
    [clearScrollback, goToTopLeft, clearDown],
    [goToTopLeft, clearDown, clearScrollback],
    [goToTopLeft, clearScrollback, clearDown],
  ].map((parts) => parts.map((part) => `\\x1B\\[${part.source}`).join(""));

  return RegExp(`(?:${variants.join("|")})$`);
})();

const waitingIndicator = NO_COLOR
  ? "■"
  : !SUPPORTS_EMOJI
  ? `\x1B[93m■${RESET_COLOR}`
  : "🥱";

const runningIndicator = NO_COLOR
  ? "›"
  : !SUPPORTS_EMOJI
  ? `\x1B[92m●${RESET_COLOR}`
  : "🟢";

const killingIndicator = NO_COLOR
  ? "○"
  : !SUPPORTS_EMOJI
  ? `\x1B[91m○${RESET_COLOR}`
  : "⭕";

const abortedIndicator = NO_COLOR
  ? "▲"
  : !SUPPORTS_EMOJI
  ? `\x1B[91m▲${RESET_COLOR}`
  : "⛔️";

/**
 * @param {number} exitCode
 * @returns {string}
 */
const exitIndicator = (exitCode) =>
  // 130 commonly means exit by ctrl+c.
  exitCode === 0 || exitCode === 130
    ? NO_COLOR
      ? "●"
      : !SUPPORTS_EMOJI
      ? `\x1B[97m●${RESET_COLOR}`
      : "⚪"
    : NO_COLOR
    ? "×"
    : !SUPPORTS_EMOJI
    ? `\x1B[91m●${RESET_COLOR}`
    : "🔴";

const folder = NO_COLOR
  ? "⌂"
  : !SUPPORTS_EMOJI
  ? `\x1B[2m⌂${RESET_COLOR}`
  : "📂";

/**
 * @param {number} n
 * @returns {string}
 */
const cursorUp = (n) => `\x1B[${n}A`;

/**
 * @param {number} n
 * @returns {string}
 */
const cursorDown = (n) => `\x1B[${n}B`;

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
    // Split on RESET_COLOR and stop invert (27).
    .split(/(\x1B\[(?:0?|27)m)/)
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
const et = dim("&&");

const [ICON_WIDTH, EMOJI_WIDTH_FIX] =
  !SUPPORTS_EMOJI || NO_COLOR ? [1, ""] : [2, cursorHorizontalAbsolute(3)];

/**
 * @param {Array<string | undefined>} labels
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

const autoExitHelp = `
    --auto-exit=<number>   auto exit when done, with at most <number> parallel processes
    --auto-exit=<number>.  the period (full stop) means to stop early when a command fails
    --auto-exit=1.         run sequentially
    --auto-exit=auto       uses the number of logical CPU cores
    --auto-exit=auto.      same thing but fail fast
    --auto-exit            defaults to auto
`
  .slice(1)
  .trimEnd();

const help = `
Run several commands concurrently.
Show output for one command at a time.
Kill all at once.

Separate the commands with a character of choice:

    ${runPty} ${pc} npm start ${pc} make watch ${pc} some_command arg1 arg2 arg3

    ${runPty} ${at} ./report_progress.bash --root / --unit % ${at} ping localhost

Note: All arguments are strings and passed as-is – no shell script execution.
Use ${bold("sh -c '...'")} or similar if you need that.

Alternatively, specify the commands in a JSON file:

    ${runPty} run-pty.json

You can tell run-pty to exit once all commands have exited with status 0:

    ${runPty} --auto-exit ${pc} npm ci ${pc} dotnet restore ${et} ./build.bash

${autoExitHelp}

Keyboard shortcuts:

    ${shortcut(KEYS.dashboard)} Dashboard
    ${shortcut(KEYS.kill)} Kill all or focused command
    Other keyboard shortcuts are shown as needed.

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
    : commands.every((command) => !("terminal" in command.status))
    ? "exit"
    : "kill all";

/**
 * @param {Array<Command>} commands
 * @param {Selection} selection
 * @param {{ width: number, useSeparateKilledIndicator: boolean }} options
 * @returns {Array<{ line: string, length: number }>}
 */
const drawDashboardCommandLines = (
  commands,
  selection,
  { width, useSeparateKilledIndicator }
) => {
  const lines = commands.map((command) => {
    const [icon, status] = statusText(command.status, {
      statusFromRules: command.statusFromRules,
      useSeparateKilledIndicator,
    });
    const { label = " " } = command;
    return {
      label: shortcut(label, { pad: false }),
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
      selection.tag !== "Invisible" && index === selection.index
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
 * @param {{
    commands: Array<Command>,
    width: number,
    attemptedKillAll: boolean,
    autoExit: AutoExit,
    selection: Selection,
   }} options
 * @returns {string}
 */
const drawDashboard = ({
  commands,
  width,
  attemptedKillAll,
  autoExit,
  selection,
}) => {
  const done = isDone({ commands, attemptedKillAll, autoExit });

  const finalLines = drawDashboardCommandLines(
    commands,
    done ? { tag: "Invisible", index: 0 } : selection,
    {
      width,
      useSeparateKilledIndicator: autoExit.tag === "AutoExit",
    }
  )
    .map(({ line }) => line)
    .join("\n");

  if (done) {
    return `${finalLines}\n`;
  }

  const label = summarizeLabels(commands.map((command) => command.label));

  // Clicks might be supported in Windows 11, but not Windows 10.
  // https://github.com/microsoft/terminal/issues/376
  const click = IS_WINDOWS ? "" : ` ${dim("(or click)")}`;

  const pid =
    selection.tag === "Keyboard"
      ? getPid(commands[selection.index])
      : undefined;

  const enter =
    pid === undefined
      ? autoExit.tag === "AutoExit"
        ? commands.some(
            (command) =>
              command.status.tag === "Exit" && command.status.exitCode !== 0
          )
          ? `${shortcut(KEYS.enter)} restart failed`
          : ""
        : commands.some((command) => command.status.tag === "Exit")
        ? `${shortcut(KEYS.enter)} restart exited`
        : ""
      : `${shortcut(KEYS.enter)} focus selected${pid}\n${shortcut(
          KEYS.unselect
        )} unselect`;

  const autoExitText =
    autoExit.tag === "AutoExit"
      ? [
          enter === "" ? undefined : "",
          `At most ${autoExit.maxParallel} ${
            autoExit.maxParallel === 1 ? "command runs" : "commands run"
          } at a time.`,
          `The session ends automatically once all commands are ${bold(
            "exit 0"
          )}${
            autoExit.failFast
              ? `,\nor when a command fails (${bold("exit non-0")}).`
              : "."
          }`,
        ]
          .filter((x) => x !== undefined)
          .join("\n")
      : "";

  return `
${finalLines}

${shortcut(label)} focus command${click}
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
${shortcut(KEYS.navigate)} move selection
${enter}
${autoExitText}
`.trim();
};

/**
 * @param {Array<Command>} commands
 * @returns {string}
 */
const drawSummary = (commands) => {
  const summary = commands.every(
    (command) =>
      command.status.tag === "Exit" &&
      command.status.exitCode === 0 &&
      !command.status.wasKilled
  )
    ? "success"
    : commands.some(
        (command) =>
          command.status.tag === "Exit" &&
          command.status.exitCode !== 0 &&
          !command.status.wasKilled
      )
    ? "failure"
    : "aborted";
  const lines = commands.map((command) => {
    const [indicator, status] = statusText(command.status, {
      useSeparateKilledIndicator: true,
    });
    return `${indicator}${EMOJI_WIDTH_FIX} ${
      status === undefined ? "" : `${status} `
    }${command.formattedCommandWithTitle}${RESET_COLOR}`;
  });
  return `${bold(`Summary – ${summary}:`)}\n${lines.join("\n")}\n`;
};

/**
 * @param {{
    commands: Array<Command>,
    attemptedKillAll: boolean,
    autoExit: AutoExit,
   }} options
 * @returns {boolean}
 */
const isDone = ({ commands, attemptedKillAll, autoExit }) =>
  // All commands are killed:
  (attemptedKillAll &&
    commands.every((command) => !("terminal" in command.status))) ||
  // --auto-exit and all commands are “exit 0”:
  (autoExit.tag === "AutoExit" &&
    commands.every(
      (command) =>
        command.status.tag === "Exit" && command.status.exitCode === 0
    ));

/**
 * @param {Command} command
 * @returns {string}
 */
const getPid = (command) =>
  "terminal" in command.status
    ? ` ${dim(`(pid ${command.status.terminal.pid})`)}`
    : "";

/**
 * @typedef {Pick<Command, "formattedCommandWithTitle" | "title" | "cwd" | "history">} CommandText
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
 * @param {string} indicator
 * @param {CommandText} command
 * @returns {string}
 */
const historyStart = (indicator, command) =>
  `${commandTitleWithIndicator(indicator, command)}\n${cwdText(command)}`;

/**
 * @param {string} indicator
 * @param {CommandText} command
 * @returns {string}
 */
const commandTitleWithIndicator = (indicator, command) =>
  `${indicator}${EMOJI_WIDTH_FIX} ${command.formattedCommandWithTitle}${RESET_COLOR}`;

/**
 * @param {Array<Command>} commands
 * @returns {string}
 */
const waitingText = (commands) =>
  `
Waiting for other commands to finish before starting.

${shortcut(KEYS.kill)} ${killAllLabel(commands)}
${shortcut(KEYS.dashboard)} dashboard
`.trim();

/**
 * @param {number} pid
 * @returns {string}
 */
const runningText = (pid) =>
  `
${shortcut(KEYS.kill)} kill ${dim(`(pid ${pid})`)}
${shortcut(KEYS.dashboard)} dashboard
`.trim();

/**
 * @param {number} pid
 * @returns {string}
 */
const killingText = (pid) =>
  `
${shortcut(KEYS.kill)} kill ${dim(`(double-press to force) (pid ${pid})`)}
${shortcut(KEYS.dashboard)} dashboard
`.trim();

/**
 * @param {Array<Command>} commands
 * @param {CommandText} command
 * @param {number} exitCode
 * @param {AutoExit} autoExit
 * @returns {string}
 */
const exitText = (commands, command, exitCode, autoExit) => {
  const restart =
    autoExit.tag === "AutoExit" && exitCode === 0
      ? ""
      : `${shortcut(KEYS.enter)} restart\n`;
  return `
${commandTitleWithIndicator(exitIndicator(exitCode), command)}
${cwdText(command)}exit ${exitCode}

${restart}${shortcut(KEYS.kill)} ${killAllLabel(commands)}
${shortcut(KEYS.dashboard)} dashboard
`.trim();
};

/**
 * @param {{ command: CommandText, exitCode: number, numExited: number, numTotal: number }} options
 * @returns {string}
 */
const exitTextAndHistory = ({ command, exitCode, numExited, numTotal }) => {
  const lastLine = removeGraphicRenditions(getLastLine(command.history));
  const newline =
    // If the last line is empty, no extra newline is needed.
    lastLine.trim() === "" ? "" : "\n";
  return `
${commandTitleWithIndicator(exitIndicator(exitCode), command)}
${cwdText(command)}${command.history}${newline}${bold(
    `exit ${exitCode}`
  )} ${dim(`(${numExited}/${numTotal} exited)`)}

`.trimStart();
};

/**
 * @param {Status} status
 * @param {{ statusFromRules?: string, useSeparateKilledIndicator?: boolean }} options
 * @returns {[string, string | undefined]}
 */
const statusText = (
  status,
  {
    statusFromRules = runningIndicator,
    useSeparateKilledIndicator = false,
  } = {}
) => {
  switch (status.tag) {
    case "Waiting":
      return [waitingIndicator, undefined];

    case "Running":
      return [statusFromRules, undefined];

    case "Killing":
      return [killingIndicator, undefined];

    case "Exit":
      return [
        status.wasKilled && useSeparateKilledIndicator
          ? abortedIndicator
          : exitIndicator(status.exitCode),
        bold(`exit ${status.exitCode}`),
      ];
  }
};

// If a command moves the cursor to another line it’s not considered a “simple
// log”. Then it’s not safe to print the keyboard shortcuts.
//
// - A, B: Cursor up/down. Moving down should be safe.
// - C, D: Cursor left/right. Should be safe! Parcel does this.
// - E, F: Cursor down/up, and to the start of the line. Moving down should be safe.
// - G: Cursor absolute position within line. Should be safe! Again, Parcel.
// - H, f: Cursor absolute position, both x and y. Exception: Moving to the
//         top-left corner and clearing the screen (ctrl+l).
// - I, Z: Cursor forward/backward by tab stops. Should be safe.
// - J: Clear the screen in different ways. Should be safe.
// - K: Erase in line. Should be safe.
// - L: Insert lines.
// - M: Delete lines.
// - S: Scroll up.
// - T: Scroll down.
// - s: Save cursor position.
// - u: Restore cursor position.
const NOT_SIMPLE_LOG_ESCAPE =
  /\x1B\[(?:\d*[AFLMST]|[su]|(?!(?:[01](?:;[01])?)?[fH]\x1B\[[02]?J)(?:\d+(?:;\d+)?)?[fH])/;

// These escapes should be printed when they first occur, but not when
// re-printing history. They result in getting a response on stdin. The
// commands might not be in a state where they expect such stdin at the time we
// re-print history. For example, Vim asks for the terminal
// background/foreground colors on startup.  But if it receives such a response
// later, it treats it as if the user typed those characters.
//
// When using `conptyInheritCursor` (Windows only), the pty writes a 6n escape
// to get the cursor position, and then waits for the response before actually
// starting the command. There used to be a problem where the commands
// effectively wouldn’t start executing until focused. That’s solved by handling
// requests and responses this way. The pty then writes a cursor move like `5;1H`.
// The line (5) varies depending on what we replied to that first 6n escape and
// how many lines have been printed so far. The column seems to always be 1. So
// on Windows, we always reply with `1;1` to the first 6n request, and then
// translate the absolute `5;1H` cursor move to a relative cursor move, the
// appropriate amount of lines down. Note: The `5;1H` stuff seems to only be
// triggered when using `npm run`. `run-pty % npx prettier --check .` does not
// trigger it, but `run-pty % npm run prettier` (with `"prettier": "prettier
// --check ."` in package.json) does.
//
// https://xfree86.org/current/ctlseqs.html
//
// - 6n and ?6n: Report Cursor Position. Reply uses `R` instead of `n`.
// - t: Report window position, size, title etc.
// - ]10;? and ]11;?: Report foreground/background color. https://unix.stackexchange.com/a/172674
const ESCAPES_REQUEST =
  /(\x1B\[(?:\??6n|\d*(?:;\d*){0,2}t)|\x1B\]1[01];\?\x07)/g;
const ESCAPES_RESPONSE =
  /(\x1B\[(?:\??\d+;\d+R|\d*(?:;\d*){0,2}t)|\x1B\]1[01];[^\x07]+\x07)/g;
const CURSOR_POSITION_RESPONSE = /(\x1B\[\??)\d+;\d+R/g;
const CONPTY_CURSOR_MOVE = /\x1B\[(\d+);1H/;

/**
 * @param {string} request
 * @returns {string}
 */
const respondToRequestFake = (request) =>
  request.endsWith("6n")
    ? "\x1B[1;1R"
    : request.endsWith("t")
    ? "\x1B[3;0;0t"
    : request.startsWith("\x1B]10;")
    ? "\x1B]10;rgb:ffff/ffff/ffff\x07"
    : request.startsWith("\x1B]11;")
    ? "\x1B]11;rgb:0000/0000/0000\x07"
    : "";

const GRAPHIC_RENDITIONS = /(\x1B\[(?:\d+(?:;\d+)*)?m)/g;

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

const AUTO_EXIT_REGEX = /^--auto-exit(?:=(\d+|auto)(\.?))?$/;

/**
 * @typedef {
    | { tag: "Help" }
    | { tag: "NoCommands" }
    | { tag: "Error", message: string }
    | { tag: "Parsed", commands: Array<CommandDescription>, autoExit: AutoExit }
   } ParseResult
 *
 * @typedef {{
    title: string,
    cwd: string,
    command: Array<string>,
    status: Array<[RegExp, [string, string] | undefined]>,
    defaultStatus?: [string, string],
    killAllSequence: string,
   }} CommandDescription
 *
 * @typedef {
    | { tag: "NoAutoExit" }
    | { tag: "AutoExit", maxParallel: number, failFast: boolean }
   } AutoExit
 */

/**
 * @param {Array<string>} args
 * @returns {ParseResult}
 */
const parseArgs = (args) => {
  if (args.length === 0) {
    return { tag: "Help" };
  }

  const [flags, restArgs] = partitionArgs(args);

  /** @type {AutoExit} */
  let autoExit = { tag: "NoAutoExit" };

  for (const flag of flags) {
    if (args[0] === "-h" || args[0] === "--help") {
      return { tag: "Help" };
    }
    const match = AUTO_EXIT_REGEX.exec(flag);
    if (match !== null) {
      const maxParallel =
        match[1] === undefined || match[1] === "auto"
          ? os.cpus().length
          : Number(match[1]);
      if (maxParallel === 0) {
        return { tag: "Error", message: "--auto-exit=0 will never finish." };
      }
      const failFast = match[2] === ".";
      autoExit = {
        tag: "AutoExit",
        maxParallel,
        failFast,
      };
    } else {
      return {
        tag: "Error",
        message: [
          `Bad flag: ${flag}`,
          "Only these forms are accepted:",
          autoExitHelp,
        ].join("\n"),
      };
    }
  }

  if (restArgs.length === 1) {
    try {
      const commands = parseInputFile(fs.readFileSync(restArgs[0], "utf8"));
      return commands.length === 0
        ? { tag: "NoCommands" }
        : { tag: "Parsed", commands, autoExit };
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

  const delimiter = restArgs[0];

  let command = [];
  const commands = [];

  for (const arg of restArgs) {
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
      killAllSequence: KEY_CODES.kill,
    })),
    autoExit,
  };
};

const LOOKS_LIKE_FLAG = /^--?\w/;

/**
 * @param {Array<string>} args
 * @returns {[Array<string>, Array<string>]}
 */
const partitionArgs = (args) => {
  let index = 0;
  while (index < args.length && LOOKS_LIKE_FLAG.test(args[index])) {
    index++;
  }
  return [args.slice(0, index), args.slice(index)];
};

/**
 * @param {string} string
 * @returns {Array<CommandDescription>}
 */
const parseInputFile = (string) => {
  try {
    return Decode.array(commandDescriptionDecoder)(JSON.parse(string));
  } catch (error) {
    throw error instanceof Decode.DecoderError
      ? new Error(error.format())
      : error;
  }
};

/**
 * @type {Decode.Decoder<CommandDescription>}
 */
const commandDescriptionDecoder = Decode.fields(
  /** @returns {CommandDescription} */
  (field) => {
    const command = field("command", nonEmptyArray(Decode.string));

    return {
      title: field(
        "title",
        Decode.optional(Decode.string, commandToPresentationName(command))
      ),
      cwd: field("cwd", Decode.optional(Decode.string, ".")),
      command,
      status: field(
        "status",
        Decode.optional(
          Decode.chain(Decode.record(statusDecoder), (record) =>
            Object.entries(record).map(([key, value]) => {
              try {
                return [RegExp(key, "u"), value];
              } catch (error) {
                throw Decode.DecoderError.at(error, key);
              }
            })
          ),
          []
        )
      ),
      defaultStatus: field("defaultStatus", Decode.optional(statusDecoder)),
      killAllSequence: field(
        "killAllSequence",
        Decode.optional(Decode.string, KEY_CODES.kill)
      ),
    };
  },
  { exact: "throw" }
);

/**
 * @template T
 * @param {Decode.Decoder<T>} decoder
 * @returns {Decode.Decoder<Array<T>>}
 */
function nonEmptyArray(decoder) {
  return Decode.chain(Decode.array(decoder), (arr) => {
    if (arr.length === 0) {
      throw new Decode.DecoderError({
        message: "Expected a non-empty array",
        value: arr,
      });
    }
    return arr;
  });
}

const statusDecoder = Decode.nullable(
  Decode.tuple([Decode.string, Decode.string]),
  undefined
);

/**
 * @param {Command} command
 * @returns {string}
 */
const joinHistory = (command) =>
  historyStart(
    command.status.tag === "Waiting" ? waitingIndicator : runningIndicator,
    command
  ) +
  command.history +
  (command.historyAlternateScreen === ""
    ? command.isOnAlternateScreen
      ? ENABLE_ALTERNATE_SCREEN
      : ""
    : ENABLE_ALTERNATE_SCREEN +
      command.historyAlternateScreen +
      (command.isOnAlternateScreen ? "" : DISABLE_ALTERNATE_SCREEN));

/**
 * @typedef {Command} CommandTypeForTest
 */
class Command {
  /**
   * @param {{
      label: string | undefined,
      commandDescription: CommandDescription,
      onData: (data: string, statusFromRulesChanged: boolean) => undefined,
      onRequest: (data: string) => undefined,
      onExit: (exitCode: number) => undefined,
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
      killAllSequence,
    },
    onData,
    onRequest,
    onExit,
  }) {
    const formattedCommand = commandToPresentationName([file, ...args]);
    this.label = label;
    this.file = file;
    this.args = args;
    this.cwd = cwd;
    this.killAllSequence = killAllSequence;
    this.title = removeGraphicRenditions(title);
    this.titleWithGraphicRenditions = title;
    this.formattedCommandWithTitle =
      title === formattedCommand
        ? formattedCommand
        : NO_COLOR
        ? `${removeGraphicRenditions(title)}: ${formattedCommand}`
        : `${bold(`${title}${RESET_COLOR}:`)} ${formattedCommand}`;
    this.onData = onData;
    this.onRequest = onRequest;
    this.onExit = onExit;
    this.history = "";
    this.historyAlternateScreen = "";
    this.isSimpleLog = true;
    this.isOnAlternateScreen = false;
    /** @type {Status} */
    this.status = { tag: "Waiting" };
    /** @type {string | undefined} */
    this.statusFromRules = extractStatus(defaultStatus);
    /** @type {[string, string] | undefined} */
    this.defaultStatus = defaultStatus;
    /** @type {Array<[RegExp, [string, string] | undefined]>} */
    this.statusRules = statusRules;
    // See the comment for `CONPTY_CURSOR_MOVE`.
    this.windowsConptyCursorMoveWorkaround = IS_WINDOWS;
  }

  /**
   * @returns {void}
   */
  start() {
    if ("terminal" in this.status) {
      throw new Error(
        `Cannot start pty with pid ${this.status.terminal.pid} because ${this.status.tag} for: ${this.title}`
      );
    }

    this.history = "";
    this.historyAlternateScreen = "";
    this.isSimpleLog = true;
    this.isOnAlternateScreen = false;
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
      cwd: path.resolve(this.cwd),
      cols: process.stdout.columns,
      rows: process.stdout.rows,
      // Avoid conpty adding escape sequences to clear the screen:
      conptyInheritCursor: true,
    });

    const disposeOnData = terminal.onData((data) => {
      for (const [index, rawPart] of data.split(ESCAPES_REQUEST).entries()) {
        let part = rawPart;
        if (
          this.windowsConptyCursorMoveWorkaround &&
          CONPTY_CURSOR_MOVE.test(rawPart)
        ) {
          part = rawPart.replace(
            CONPTY_CURSOR_MOVE,
            (_, n) =>
              `\x1B[${Number(n) - (this.history + rawPart).split("\n").length}E`
          );
          this.windowsConptyCursorMoveWorkaround = false;
        }
        if (index % 2 === 0) {
          const statusFromRulesChanged = this.pushHistory(part);
          this.onData(part, statusFromRulesChanged);
        } else {
          this.onRequest(part);
        }
      }
    });

    const disposeOnExit = terminal.onExit(({ exitCode }) => {
      disposeOnData.dispose();
      disposeOnExit.dispose();
      this.status = {
        tag: "Exit",
        exitCode,
        wasKilled: this.status.tag === "Killing",
      };
      this.onExit(exitCode);
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
        this.status.terminal.write(this.killAllSequence);
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
          this.status.terminal.write(this.killAllSequence);
        }
        this.status.lastKillPress = now;
        return undefined;
      }

      case "Waiting":
      case "Exit":
        throw new Error(
          `Cannot kill ${this.status.tag} pty for: ${this.title}`
        );
    }
  }

  /**
   * @param {string} data
   * @returns {boolean}
   */
  pushHistory(data) {
    const previousStatusFromRules = this.statusFromRules;

    for (const part of data.split(ALTERNATE_SCREEN_REGEX)) {
      switch (part) {
        case ENABLE_ALTERNATE_SCREEN:
          this.isOnAlternateScreen = true;
          break;
        case DISABLE_ALTERNATE_SCREEN:
          this.isOnAlternateScreen = false;
          break;
        default:
          this.updateStatusFromRules(part);
          if (this.isOnAlternateScreen) {
            this.historyAlternateScreen += part;
            if (CLEAR_REGEX.test(this.historyAlternateScreen)) {
              this.historyAlternateScreen = "";
            } else {
              if (this.historyAlternateScreen.length > MAX_HISTORY) {
                this.historyAlternateScreen = this.historyAlternateScreen.slice(
                  -MAX_HISTORY
                );
              }
            }
          } else {
            this.history += part;
            if (CLEAR_REGEX.test(this.history)) {
              this.history = "";
              this.isSimpleLog = true;
            } else {
              if (CLEAR_DOWN_REGEX.test(this.history)) {
                this.isSimpleLog = true;
              }
              if (this.history.length > MAX_HISTORY) {
                this.history = this.history.slice(-MAX_HISTORY);
              }
              if (this.isSimpleLog && NOT_SIMPLE_LOG_ESCAPE.test(part)) {
                this.isSimpleLog = false;
              }
            }
          }
      }
    }

    const statusFromRulesChanged =
      this.statusFromRules !== previousStatusFromRules;

    return statusFromRulesChanged;
  }

  /**
   * @param {string} data
   * @returns {void}
   */
  updateStatusFromRules(data) {
    const lastLine = getLastLine(
      this.isOnAlternateScreen ? this.historyAlternateScreen : this.history
    );
    const lines = (lastLine + data).split(/(?:\r?\n|\r)/);

    for (const line of lines) {
      for (const [regex, status] of this.statusRules) {
        if (regex.test(removeGraphicRenditions(line))) {
          this.statusFromRules = extractStatus(status);
        }
      }
    }
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
    : !SUPPORTS_EMOJI
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
 * @typedef {
    | { tag: "Invisible", index: number }
    | { tag: "Mousedown", index: number }
    | { tag: "Keyboard", index: number }
   } Selection
 */

/**
 * @param {Array<CommandDescription>} commandDescriptions
 * @param {AutoExit} autoExit
 * @returns {void}
 */
const runInteractively = (commandDescriptions, autoExit) => {
  /** @type {Current} */
  let current = { tag: "Dashboard" };
  let attemptedKillAll = false;
  /** @type {Selection} */
  let selection = { tag: "Invisible", index: 0 };
  let extraTextPrinted = false;

  /**
   * @param {Command} command
   * @param {string} data
   * @param {{ ignoreAlternateScreen?: boolean }} options
   * @returns {undefined}
   */
  const printDataWithExtraText = (
    command,
    data,
    { ignoreAlternateScreen = false } = {}
  ) => {
    // Note: For a simple log (no complicating cursor movements or anything) we
    // can _always_ show extra text. Otherwise, it’s better not to print
    // anything extra in. We don’t want to put something in the middle of the
    // command’s output.

    if (extraTextPrinted) {
      // `RESET_COLOR` is needed because `CLEAR_LEFT` and `CLEAR_DOWN` paint the
      // area they clear with the current background color otherwise. Since we
      // use `RESET_COLOR`, we also have to use `SAVE_CURSOR` and
      // `RESTORE_CURSOR` to restore the current colors when done.
      process.stdout.write(
        `${SAVE_CURSOR}${cursorDown(
          1
        )}${RESET_COLOR}${CLEAR_LEFT}${CLEAR_DOWN}${RESTORE_CURSOR}`
      );
      extraTextPrinted = false;
    }

    if (command.isOnAlternateScreen && !ignoreAlternateScreen) {
      process.stdout.write(data);
      return undefined;
    }

    /**
     * @param {string} extraText
     * @returns {void}
     */
    const helper = (extraText) => {
      const isBadWindows = IS_WINDOWS && !IS_WINDOWS_TERMINAL;
      if (command.isSimpleLog && (!isBadWindows || data.endsWith("\n"))) {
        const numLines = extraText.split("\n").length;
        // `\x1BD` (IND) is like `\n` except the cursor column is preserved on
        // the new line. We print the INDs so that if we’re at the bottom of the
        // terminal window, empty space is created for `extraText`. However, if
        // there’s currently a background color, the new lines will be colored.
        // We can’t solve that with doing `RESET_COLOR` and `SAVE_CURSOR`
        // earlier, because the INDs might cause scrolling but `SAVE_CURSOR` and
        // `RESTORE_CURSOR` are relative to the screen, not the content. As a
        // workaround we let the lines be colored, and later clear that using
        // `CLEAR_DOWN`. (There’s no text to clear at that point; only color.)
        // Note: On Linux and macOS (at least in the terminals I’ve tested),
        // `\f` works the same way as `\x1BD`. However, cmd.exe prints `\f` as
        // “♀”, and Windows Terminal treats it as `\n`. Linux, macOS and Windows
        // Terminal do support IND. I have not found any way to do this in cmd.exe
        // and the old PowerShell app, so there we only print the extra text only if
        // we’re at the start of a new line.
        // https://github.com/microsoft/terminal/issues/3189
        // https://github.com/microsoft/terminal/pull/3271/files#diff-6d7a2ad03ef14def98192607612a235f881368c3828b3b732abdf8f8ecf9b03bR4322
        process.stdout.write(
          data +
            (isBadWindows ? "\n" : "\x1BD").repeat(numLines) +
            cursorUp(numLines) +
            SAVE_CURSOR +
            RESET_COLOR +
            "\n".repeat(1) +
            CLEAR_DOWN +
            extraText +
            RESTORE_CURSOR
        );
        extraTextPrinted = true;
      } else {
        process.stdout.write(data);
      }
    };

    switch (command.status.tag) {
      case "Running":
        helper(runningText(command.status.terminal.pid));
        return undefined;

      case "Killing":
        helper(
          command.status.slow
            ? killingText(command.status.terminal.pid)
            : runningText(command.status.terminal.pid)
        );
        return undefined;

      case "Waiting":
      case "Exit": {
        const lastLine = removeGraphicRenditions(getLastLine(command.history));
        const newlines =
          // If the last line is empty, no extra newline is needed.
          lastLine.trim() === "" ? "\n" : "\n\n";

        // This has the side effect of moving the cursor, so only do it if needed.
        const disableAlternateScreen = command.isOnAlternateScreen
          ? DISABLE_ALTERNATE_SCREEN
          : "";

        process.stdout.write(
          data +
            HIDE_CURSOR +
            RESET_COLOR +
            disableAlternateScreen +
            newlines +
            (command.status.tag === "Waiting"
              ? waitingText(commands)
              : exitText(commands, command, command.status.exitCode, autoExit))
        );

        extraTextPrinted = false;
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
        DISABLE_APPLICATION_CURSOR_KEYS +
        ENABLE_MOUSE +
        RESET_COLOR +
        CLEAR +
        drawDashboard({
          commands,
          width: process.stdout.columns,
          attemptedKillAll,
          autoExit,
          selection,
        })
    );
  };

  /**
   * @param {number} index
   * @returns {void}
   */
  const switchToCommand = (index, { hideSelection = false } = {}) => {
    const command = commands[index];
    current = { tag: "Command", index };
    if (hideSelection) {
      selection = { tag: "Invisible", index };
    }

    process.stdout.write(
      SHOW_CURSOR +
        DISABLE_ALTERNATE_SCREEN +
        DISABLE_APPLICATION_CURSOR_KEYS +
        DISABLE_MOUSE +
        RESET_COLOR +
        CLEAR
    );

    extraTextPrinted = false;

    printDataWithExtraText(command, joinHistory(command));
  };

  /**
   * @param {Selection} newSelection
   * @returns {void}
   */
  const setSelection = (newSelection) => {
    selection = newSelection;
    // Redraw dashboard.
    switchToDashboard();
  };

  /**
   * @returns {void}
   */
  const killAll = () => {
    attemptedKillAll = true;
    const notExited = commands.filter(
      (command) => "terminal" in command.status
    );
    if (notExited.length === 0) {
      switchToDashboard();
      process.exit(autoExit.tag === "AutoExit" ? 1 : 0);
    } else {
      for (const command of notExited) {
        command.kill();
      }
      // So you can see how killing other commands go:
      switchToDashboard();
    }
  };

  /**
   * @returns {void}
   */
  const restartExited = () => {
    const exited =
      autoExit.tag === "AutoExit"
        ? commands.filter(
            (command) =>
              command.status.tag === "Exit" && command.status.exitCode !== 0
          )
        : commands.filter((command) => command.status.tag === "Exit");
    if (exited.length > 0) {
      for (const command of exited) {
        command.start();
      }
      // Redraw dashboard.
      switchToDashboard();
    }
  };

  /** @type {Array<{ commandIndex: number, data: string }>} */
  const requests = [];
  let requestInFlight = false;

  /**
   * @returns {void}
   */
  const handleNextRequest = () => {
    if (requestInFlight || requests.length === 0) {
      return;
    }
    const request = requests[0];
    process.stdout.write(request.data);
    requestInFlight = true;
  };

  /** @type {Array<Command>} */
  const commands = commandDescriptions.map(
    (commandDescription, index) =>
      new Command({
        label: ALL_LABELS[index],
        commandDescription,
        onData: (data, statusFromRulesChanged) => {
          switch (current.tag) {
            case "Command":
              if (current.index === index) {
                const command = commands[index];
                switch (command.status.tag) {
                  case "Running":
                  case "Killing":
                    printDataWithExtraText(command, data);
                    return undefined;
                  case "Waiting":
                  case "Exit":
                    throw new Error(
                      `Received unexpected output from ${command.status.tag} pty for: ${command.title}\n${data}`
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
        onRequest: (data) => {
          requests.push({ commandIndex: index, data });
          handleNextRequest();
          return undefined;
        },
        onExit: (exitCode) => {
          // Exit the whole program if all commands have exited.
          if (isDone({ commands, attemptedKillAll, autoExit })) {
            switchToDashboard();
            process.exit(
              autoExit.tag === "AutoExit" && attemptedKillAll ? 1 : 0
            );
          }

          if (
            autoExit.tag === "AutoExit" &&
            autoExit.failFast &&
            exitCode !== 0 &&
            !attemptedKillAll
          ) {
            killAll();
          }

          const nextWaitingIndex = commands.findIndex(
            (command) => command.status.tag === "Waiting"
          );
          if (nextWaitingIndex !== -1 && !attemptedKillAll) {
            commands[nextWaitingIndex].start();
            // If starting the command we’re currently on, redraw to remove `waitingText`.
            if (
              current.tag === "Command" &&
              current.index === nextWaitingIndex
            ) {
              switchToCommand(current.index);
            }
          }

          switch (current.tag) {
            case "Command":
              if (current.index === index) {
                const command = commands[index];
                printDataWithExtraText(command, "", {
                  ignoreAlternateScreen: true,
                });
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
      if ("terminal" in command.status) {
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

  setupSignalHandlers(commands, killAll);

  process.stdin.setRawMode(true);

  process.stdin.on("data", (data) => {
    for (const [index, part] of data
      .toString("utf8")
      .split(ESCAPES_RESPONSE)
      .entries()) {
      if (index % 2 === 1 && requests.length > 0) {
        const request = requests[0];
        const command = commands[request.commandIndex];
        switch (command.status.tag) {
          case "Running":
          case "Killing":
            switch (current.tag) {
              case "Command":
                command.status.terminal.write(
                  command.windowsConptyCursorMoveWorkaround
                    ? // Always respond with line 1 in the workaround.
                      part.replace(CURSOR_POSITION_RESPONSE, "$11;1R")
                    : part
                );
                break;
              // In the dashboard, make an educated guess where the cursor would be in the command.
              case "Dashboard": {
                const numLines = (
                  command.isOnAlternateScreen
                    ? command.historyAlternateScreen
                    : historyStart(waitingIndicator, command) + command.history
                ).split("\n").length;
                const likelyRow = command.windowsConptyCursorMoveWorkaround
                  ? 1 // Always respond with line 1 in the workaround.
                  : Math.min(numLines, process.stdout.rows);
                command.status.terminal.write(
                  part.replace(CURSOR_POSITION_RESPONSE, `$1${likelyRow};1R`)
                );
                break;
              }
            }
            break;
          case "Waiting":
          case "Exit":
            break;
        }
        requests.shift();
        requestInFlight = false;
        handleNextRequest();
      } else {
        onStdin(
          part,
          current,
          commands,
          selection,
          autoExit,
          switchToDashboard,
          switchToCommand,
          setSelection,
          killAll,
          restartExited
        );
      }
    }
  });

  process.on("exit", () => {
    process.stdout.write(
      SHOW_CURSOR + DISABLE_BRACKETED_PASTE_MODE + DISABLE_MOUSE + RESET_COLOR
    );
  });

  const maxParallel =
    autoExit.tag === "AutoExit" ? autoExit.maxParallel : Infinity;
  for (const command of commands.slice(0, maxParallel)) {
    command.start();
  }

  if (commandDescriptions.length === 1) {
    switchToCommand(0);
  } else {
    switchToDashboard();
  }
};

/**
 * @param {string} data
 * @param {Current} current
 * @param {Array<Command>} commands
 * @param {Selection} selection
 * @param {AutoExit} autoExit
 * @param {() => void} switchToDashboard
 * @param {(index: number, options?: { hideSelection?: boolean }) => void} switchToCommand
 * @param {(newSelection: Selection) => void} setSelection
 * @param {() => void} killAll
 * @param {() => void} restartExited
 * @returns {undefined}
 */
const onStdin = (
  data,
  current,
  commands,
  selection,
  autoExit,
  switchToDashboard,
  switchToCommand,
  setSelection,
  killAll,
  restartExited
) => {
  switch (current.tag) {
    case "Command": {
      const command = commands[current.index];
      switch (command.status.tag) {
        case "Waiting":
          switch (data) {
            case KEY_CODES.kill:
              killAll();
              return undefined;

            case KEY_CODES.dashboard:
              switchToDashboard();
              return undefined;

            default:
              return undefined;
          }

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
              if (
                !(autoExit.tag === "AutoExit" && command.status.exitCode === 0)
              ) {
                command.start();
                switchToCommand(current.index);
              }
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
          if (selection.tag === "Invisible") {
            restartExited();
          } else {
            switchToCommand(selection.index);
          }
          return undefined;

        case KEY_CODES.up:
          setSelection({
            tag: "Keyboard",
            index:
              selection.tag === "Invisible"
                ? selection.index
                : selection.index === 0
                ? commands.length - 1
                : selection.index - 1,
          });
          return undefined;

        case KEY_CODES.down:
          setSelection({
            tag: "Keyboard",
            index:
              selection.tag === "Invisible"
                ? selection.index
                : selection.index === commands.length - 1
                ? 0
                : selection.index + 1,
          });
          return undefined;

        case KEY_CODES.esc:
          setSelection({ tag: "Invisible", index: selection.index });
          return undefined;

        default: {
          const commandIndex = commands.findIndex(
            (command) => command.label === data
          );
          if (commandIndex !== -1) {
            switchToCommand(commandIndex, { hideSelection: true });
            return undefined;
          }

          const mousePosition = parseMouse(data);
          if (mousePosition === undefined) {
            return undefined;
          }

          const index = getCommandIndexFromMousePosition(
            commands,
            mousePosition
          );

          switch (mousePosition.type) {
            case "mousedown":
              if (index !== undefined) {
                setSelection({ tag: "Mousedown", index });
              }
              return undefined;

            case "mouseup": {
              if (index !== undefined && index === selection.index) {
                switchToCommand(index, { hideSelection: true });
              } else if (selection.tag !== "Invisible") {
                setSelection({ tag: "Invisible", index: selection.index });
              }
              return undefined;
            }
          }
        }
      }
  }
};

const MOUSE_REGEX = /\x1B\[<0;(\d+);(\d+)([Mm])/;

/**
 * @param {string} string
 * @returns {{ type: "mousedown" | "mouseup", x: number, y: number } | undefined}
 */
const parseMouse = (string) => {
  const match = MOUSE_REGEX.exec(string);
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
    {
      tag: "Invisible",
      index: 0,
    },
    {
      width: process.stdout.columns,
      useSeparateKilledIndicator: false,
    }
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
 * @param {Array<CommandDescription>} commandDescriptions
 * @param {number} maxParallel
 * @param {boolean} failFast
 * @returns {void}
 */
const runNonInteractively = (commandDescriptions, maxParallel, failFast) => {
  let attemptedKillAll = false;

  /**
   * @returns {void}
   */
  const killAll = () => {
    attemptedKillAll = true;
    const notExited = commands.filter(
      (command) => "terminal" in command.status
    );

    // Pressing ctrl+c prints `^C` to the terminal. Move the cursor back so we
    // overwrite that. We also need to clear since ⭕️ is see-through. `^C` will
    // be seen in each command history.
    process.stdout.write(`\r${CLEAR_RIGHT}`);

    if (notExited.length === 0) {
      process.stdout.write(drawSummary(commands));
      process.exit(1);
    } else {
      for (const command of notExited) {
        command.kill();
        process.stdout.write(
          `${commandTitleWithIndicator(killingIndicator, command)}\n\n`
        );
      }
    }
  };

  /** @type {Array<Command>} */
  const commands = commandDescriptions.map((commandDescription, index) => {
    const thisCommand = new Command({
      label: ALL_LABELS[index],
      commandDescription,
      onData: () => undefined,
      // `process.stdin.setRawMode(true)` is required to make real requests to
      // the terminal, but that is not possible when `process.stdin.isTTY === false`.
      // The best we can do is respond immediately with a fake response so
      // programs don’t get stuck. This is important on Windows – see the
      // comment for `ESCAPES_REQUEST`.
      onRequest: (data) => {
        if ("terminal" in thisCommand.status) {
          thisCommand.status.terminal.write(respondToRequestFake(data));
        }
        return undefined;
      },
      onExit: (exitCode) => {
        const numRunning = commands.filter(
          (command) => "terminal" in command.status
        ).length;
        const numExit = commands.filter(
          (command) => command.status.tag === "Exit"
        ).length;
        const numExit0 = commands.filter(
          (command) =>
            command.status.tag === "Exit" && command.status.exitCode === 0
        ).length;

        process.stdout.write(
          exitTextAndHistory({
            command: thisCommand,
            exitCode,
            numExited: numExit,
            numTotal: commands.length,
          })
        );

        // Exit the whole program if all commands have exited.
        if (
          (attemptedKillAll && numRunning === 0) ||
          numExit === commands.length
        ) {
          process.stdout.write(drawSummary(commands));
          process.exit(attemptedKillAll || numExit0 !== numExit ? 1 : 0);
        }

        if (!attemptedKillAll) {
          const nextWaitingIndex = commands.findIndex(
            (command) => command.status.tag === "Waiting"
          );
          if (failFast && exitCode !== 0) {
            killAll();
          } else if (nextWaitingIndex !== -1) {
            const command = commands[nextWaitingIndex];
            command.start();
            process.stdout.write(
              `${commandTitleWithIndicator(runningIndicator, command)}\n\n`
            );
          }
        }

        return undefined;
      },
    });

    return thisCommand;
  });

  process.stdout.on("resize", () => {
    for (const command of commands) {
      if ("terminal" in command.status) {
        command.status.terminal.resize(
          process.stdout.columns,
          process.stdout.rows
        );
      }
    }
  });

  setupSignalHandlers(commands, killAll);

  for (const [index, command] of commands.entries()) {
    if (index < maxParallel) {
      command.start();
      process.stdout.write(
        `${commandTitleWithIndicator(runningIndicator, command)}\n\n`
      );
    } else {
      process.stdout.write(
        `${commandTitleWithIndicator(waitingIndicator, command)}\n\n`
      );
    }
  }
};

/**
 * @param {Array<Command>} commands
 * @param {() => void} killAll
 * @returns {void}
 */
const setupSignalHandlers = (commands, killAll) => {
  let lastSignalTimestamp = 0;

  // Clean up all commands if someone tries to kill run-pty.
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      const now = Date.now();
      // When running via `npm run` or `npx`, one often gets two SIGINTs in a row
      // when pressing ctrl+c. https://stackoverflow.com/a/60273973
      if (now - lastSignalTimestamp > 10) {
        killAll();
      }
      lastSignalTimestamp = now;
    });
  }

  // Don’t leave running processes behind in case of an unexpected error.
  for (const event of ["uncaughtException", "unhandledRejection"]) {
    process.on(event, (error) => {
      console.error(error);
      for (const command of commands) {
        if ("terminal" in command.status) {
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
};

/**
 * @returns {undefined}
 */
const run = () => {
  const parseResult = parseArgs(process.argv.slice(2));

  switch (parseResult.tag) {
    case "Help":
      console.log(help);
      process.exit(0);

    case "NoCommands":
      process.exit(0);

    case "Parsed":
      if (process.stdin.isTTY) {
        runInteractively(parseResult.commands, parseResult.autoExit);
      } else if (parseResult.autoExit.tag === "AutoExit") {
        runNonInteractively(
          parseResult.commands,
          parseResult.autoExit.maxParallel,
          parseResult.autoExit.failFast
        );
      } else {
        console.error(
          "run-pty requires stdin to be a TTY to run properly (unless --auto-exit is used)."
        );
        process.exit(1);
      }
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
    drawSummary,
    exitText,
    exitTextAndHistory,
    help,
    historyStart,
    killingText,
    parseArgs,
    runningIndicator,
    runningText,
    summarizeLabels,
    waitingText,
  },
};
