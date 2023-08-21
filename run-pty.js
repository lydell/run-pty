#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const pty = require("node-pty");
const Codec = require("tiny-decoders");

/**
 * @typedef {
    | { tag: "Waiting" }
    | { tag: "Running", terminal: import("node-pty").IPty }
    | { tag: "Killing", terminal: import("node-pty").IPty, slow: boolean, lastKillPress: number | undefined, restartAfterKill: boolean }
    | { tag: "Exit", exitCode: number, wasKilled: boolean }
   } Status
 *
 * @typedef {
    | { tag: "Command", index: number }
    | { tag: "Dashboard", previousRender: Array<string> }
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
  navigate: "↑↓←→",
  navigateVerticallyOnly: "↑↓",
  enter: "enter",
  unselect: "escape",
};

const KEY_CODES = {
  kill: "\x03",
  restart: "\r",
  dashboard: "\x1a",
  up: "\x1B[A",
  down: "\x1B[B",
  left: "\x1B[D",
  right: "\x1B[C",
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
          ]).map((rest) => [first, ...rest]),
        );

  const variants = [
    ...permutations([clearScreen, clearScrollback, goToTopLeft]),
    [clearScrollback, goToTopLeft, clearDown],
    [goToTopLeft, clearDown, clearScrollback],
    [goToTopLeft, clearScrollback, clearDown],
  ].map((parts) => parts.map((part) => `\\x1B\\[${part.source}`).join(""));

  return RegExp(`(?:${variants.join("|")})`);
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

const restartingIndicator = NO_COLOR
  ? "◌"
  : !SUPPORTS_EMOJI
  ? `\x1B[96m◌${RESET_COLOR}`
  : "🔄";

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
 * @param {number} y
 * @param {number} x
 * @returns {string}
 */
const cursorAbsolute = (y, x) => `\x1B[${y};${x}H`;

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
      0,
    );
    const currentLength = previousLength + group.length;
    return numLabels > previousLength
      ? numLabels < currentLength
        ? group.slice(0, numLabels - previousLength)
        : group
      : [];
  })
    .map((group) =>
      group.length === 1 ? group[0] : `${group[0]}-${group[group.length - 1]}`,
    )
    .join("/");
};

const autoExitHelp = `
    --auto-exit=<number>   auto exit when done, with at most <number> parallel processes
    --auto-exit=auto       uses the number of logical CPU cores
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

Alternatively, specify the commands in a JSON file:

    ${runPty} run-pty.json

You can tell run-pty to exit once all commands have exited with status 0:

    ${runPty} --auto-exit ${pc} npm ci ${pc} dotnet restore ${et} node build.js

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
  { width, useSeparateKilledIndicator },
) => {
  const lines = commands.map((command) => {
    const [icon, status] = statusText(command.status, {
      statusFromRules: command.statusFromRules ?? runningIndicator,
      useSeparateKilledIndicator,
    });
    const { label = " " } = command;
    return {
      label: shortcut(label, { pad: false }),
      icon,
      status,
      title: command.titlePossiblyWithGraphicRenditions,
    };
  });

  const separator = "  ";

  const widestStatus = Math.max(
    0,
    ...lines.map(({ status }) => (status === undefined ? 0 : status.length)),
  );

  const selectedIndicator =
    selection.tag === "ByIndicator" ? selection.indicator : undefined;

  return lines.map(({ label, icon, status, title }, index) => {
    const finalIcon =
      icon === selectedIndicator
        ? NO_COLOR
          ? `${separator.slice(0, -1)}→${icon}`
          : // Add spaces at the end to make sure that two terminal slots get
            // inverted, no matter the actual width of the icon (which may even
            // be the empty string).
            `${separator.slice(0, -1)}${invert(
              ` ${icon}${" ".repeat(ICON_WIDTH)}`,
            )}`
        : `${separator}${icon}`;
    const start = truncate(`${label}${finalIcon}`, width);
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
    const highlightedSeparator =
      icon === selectedIndicator && !NO_COLOR
        ? invert(" ") + separator.slice(1)
        : separator;
    const finalEnd =
      (selection.tag === "Mousedown" || selection.tag === "Keyboard") &&
      index === selection.index
        ? NO_COLOR
          ? `${highlightedSeparator.slice(0, -1)}→${truncatedEnd}`
          : `${highlightedSeparator}${invert(truncatedEnd)}`
        : `${highlightedSeparator}${truncatedEnd}`;
    return {
      line: `${start}${RESET_COLOR}${cursorHorizontalAbsolute(
        startLength + 1,
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
    },
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

  const enter =
    selection.tag === "Keyboard"
      ? `${shortcut(KEYS.enter)} focus selected${getPid(
          commands[selection.index],
        )}\n${shortcut(KEYS.unselect)} unselect`
      : selection.tag === "ByIndicator"
      ? `${shortcut(KEYS.enter)} ${
          commands.some(
            (command) =>
              getIndicatorChoice(command) === selection.indicator &&
              command.status.tag === "Killing",
          )
            ? "force "
            : ""
        }restart selected\n${shortcut(KEYS.unselect)} unselect`
      : autoExit.tag === "AutoExit"
      ? commands.some(
          (command) =>
            command.status.tag === "Exit" &&
            (command.status.exitCode !== 0 || command.status.wasKilled),
        )
        ? `${shortcut(KEYS.enter)} restart failed`
        : ""
      : commands.some((command) => command.status.tag === "Exit")
      ? `${shortcut(KEYS.enter)} restart exited`
      : "";

  const navigationKeys =
    autoExit.tag === "AutoExit" ? KEYS.navigateVerticallyOnly : KEYS.navigate;

  const sessionEnds = "The session ends automatically once all commands are ";
  const autoExitText =
    autoExit.tag === "AutoExit"
      ? [
          enter === "" ? undefined : "",
          `At most ${autoExit.maxParallel} ${
            autoExit.maxParallel === 1 ? "command runs" : "commands run"
          } at a time.`,
          `${sessionEnds}${exitIndicator(0)}${cursorHorizontalAbsolute(
            sessionEnds.length + ICON_WIDTH + 1,
          )} ${bold("exit 0")}.`,
        ]
          .filter((x) => x !== undefined)
          .join("\n")
      : "";

  return `
${finalLines}

${shortcut(label)} focus command${click}
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
${shortcut(navigationKeys)} move selection
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
      !command.status.wasKilled,
  )
    ? "success"
    : commands.some(
        (command) =>
          command.status.tag === "Exit" &&
          command.status.exitCode !== 0 &&
          !command.status.wasKilled,
      )
    ? "failure"
    : "aborted";
  const lines = commands.map((command) => {
    const [indicator, status] = statusText(command.status, {
      statusFromRules: runningIndicator,
      useSeparateKilledIndicator: true,
    });
    return `${indicator}${EMOJI_WIDTH_FIX} ${
      status === undefined ? "" : `${status} `
    }${command.titlePossiblyWithGraphicRenditions}${RESET_COLOR}`;
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
        command.status.tag === "Exit" &&
        command.status.exitCode === 0 &&
        !command.status.wasKilled,
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
 * @param {Command} command
 * @returns {string}
 */
const getIndicatorChoice = (command) =>
  statusText(command.status, {
    statusFromRules: command.statusFromRules ?? runningIndicator,
    useSeparateKilledIndicator: false,
  })[0];

/**
 * @param {Array<Command>} commands
 * @returns {Array<string>}
 */
const getIndicatorChoices = (commands) => [
  ...new Set(commands.map(getIndicatorChoice)),
];

/**
 * @typedef {Pick<Command, "formattedCommandWithTitle" | "title" | "titlePossiblyWithGraphicRenditions" | "cwd" | "history">} CommandText
 */

/**
 * @param {CommandText} command
 * @returns {string}
 */
const cwdText = (command) =>
  path.resolve(command.cwd) === process.cwd()
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
 * Used in interactive mode.
 *
 * @param {string} indicator
 * @param {CommandText} command
 * @returns {string}
 */
const commandTitleWithIndicator = (indicator, command) =>
  `${indicator}${EMOJI_WIDTH_FIX} ${command.formattedCommandWithTitle}${RESET_COLOR}`;

/**
 * Similar to `commandTitleWithIndicator`. Used in non-interactive mode. This
 * does not print the full command, only the title. In interactive mode, the
 * dashboard only prints the title too – if you want the full thing, you need to
 * enter that command, because the command can be very long. In non-interactive
 * mode, it can be very spammy if a long command is printed once when started,
 * once when exited and once in the summary – interesting output (such as
 * errors) gets lost in a sea of command stuff.
 *
 * @param {string} indicator
 * @param {CommandText} command
 * @returns {string}
 */
const commandTitleOnlyWithIndicator = (indicator, command) =>
  `${indicator}${EMOJI_WIDTH_FIX} ${command.titlePossiblyWithGraphicRenditions}${RESET_COLOR}`;

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
 * @param {Extract<Status, {tag: "Exit"}>} status
 * @param {AutoExit} autoExit
 * @returns {string}
 */
const exitText = (commands, command, status, autoExit) => {
  const titleWithIndicator = commandTitleWithIndicator(
    status.wasKilled && autoExit.tag === "AutoExit"
      ? abortedIndicator
      : exitIndicator(status.exitCode),
    command,
  );
  const restart =
    autoExit.tag === "AutoExit" && status.exitCode === 0 && !status.wasKilled
      ? ""
      : `${shortcut(KEYS.enter)} restart\n`;
  return `
${titleWithIndicator}
${cwdText(command)}exit ${status.exitCode}

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
${commandTitleOnlyWithIndicator(exitIndicator(exitCode), command)}
${cwdText(command)}${command.history}${CLEAR_DOWN}${newline}${bold(
    `exit ${exitCode}`,
  )} ${dim(`(${numExited}/${numTotal} exited)`)}

`.trimStart();
};

/**
 * @param {Status} status
 * @param {{ statusFromRules: string, useSeparateKilledIndicator: boolean }} options
 * @returns {[string, string | undefined]}
 */
const statusText = (
  status,
  { statusFromRules, useSeparateKilledIndicator },
) => {
  switch (status.tag) {
    case "Waiting":
      return [waitingIndicator, undefined];

    case "Running":
      return [statusFromRules, undefined];

    case "Killing":
      return [
        status.restartAfterKill ? restartingIndicator : killingIndicator,
        undefined,
      ];

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
// - A, B: Cursor up/down. Moving down should be safe. So is `\n1A` (move to
//         start of new line, then up one line) – docker-compose does that
//         to update the previous line. We always print on the next line so it’s safe.
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
//
// This includes the regexes for clearing the screen, since they also affect “is
// simple log”: They reset it to `true` sometimes.
const NOT_SIMPLE_LOG_ESCAPE_RAW =
  /(\x1B\[0?J)|\x1B\[(?:\d*[FLMST]|[su]|(?!(?:[01](?:;[01])?)?[fH]\x1B\[[02]?J)(?:\d+(?:;\d+)?)?[fH])|(?!\n\x1B\[1?A)(?:^|[^])\x1B\[\d*A/;
const NOT_SIMPLE_LOG_ESCAPE = RegExp(
  `(${CLEAR_REGEX.source})|${NOT_SIMPLE_LOG_ESCAPE_RAW.source}`,
  "g",
);

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
// requests and responses this way. The pty then writes a cursor move like
// `5;1H`. The line (5) varies depending on how many lines have been printed so
// far. The column seems to always be 1. For some reason, replacing this cursor
// move with two newlines seems to always make the cursor end up where we want,
// in my testing. Note: The `5;1H` stuff seems to only be triggered when using
// `npm run`. `run-pty % npx prettier --check .` does not trigger it, but
// `run-pty % npm run prettier` (with `"prettier": "prettier --check ."` in
// package.json) does. `run-pty % timeout 3` also uses 6n and cursor moves, and
// should not be affected by this workaround.
//
// https://xfree86.org/current/ctlseqs.html
//
// - 6n and ?6n: Report Cursor Position. Reply uses `R` instead of `n`.
// - t: Report window position, size, title etc.
// - ]10;? and ]11;?: Report foreground/background color. https://unix.stackexchange.com/a/172674
// - ]4;NUM;?: Report color NUM in the palette.
const ESCAPES_REQUEST =
  /(\x1B\[(?:\??6n|\d*(?:;\d*){0,2}t)|\x1B\](?:1[01]|4;\d+);\?(?:\x07|\x1B\\))/g;
const ESCAPES_RESPONSE =
  /(\x1B\[(?:\??\d+;\d+R|\d*(?:;\d*){0,2}t)|\x1B\](?:1[01]|4;\d+);[^\x07\x1B]+(?:\x07|\x1B\\))/g;
const CURSOR_POSITION_RESPONSE = /(\x1B\[\??)\d+;\d+R/g;
const CONPTY_CURSOR_MOVE = /\x1B\[\d+;1H/;
const CONPTY_CURSOR_MOVE_REPLACEMENT = "\n\n";

/**
 * @param {string} request
 * @returns {string}
 */
const respondToRequestFake = (request) =>
  request.endsWith("6n")
    ? "\x1B[1;1R"
    : request.endsWith("t")
    ? "\x1B[3;0;0t"
    : request.startsWith("\x1B]10;") || request.startsWith("\x1B]4;")
    ? request.replace("?", "rgb:ffff/ffff/ffff")
    : request.startsWith("\x1B]11;")
    ? request.replace("?", "rgb:0000/0000/0000")
    : "";

// Inspired by this well researched Stack Overflow answer:
// https://stackoverflow.com/a/14693789
//
// First, let’s talk about ANSI escapes. They start with `\x1B`.
//
// - Some escapes are followed by just one more character.
// - CSI escapes have a `[` and then 0 or more parameter characters, followed by
//   a final character. There is no overlap between the parameter characters and
//   the final character.
// - OSC escapes have a `]` and then 1 or more characters, followed by either
//   `\x07` or `\x1B\\`.
//
// So a `\x1B` followed by zero or more parameter characters at the very end
// indicates an unfinished escape. But if that’s followed by anything else
// (valid or invalid final character), it’s finished.
//
// This is needed because we can’t print any extra things in the middle of an
// unfinished escape: That breaks the escape and causes things like “6m” to be
// printed – parts of the escape ends up as text. The Elm compiler does this:
// Run `elm make --output=/dev/null MyFile.elm` where MyFile.elm has a syntax
// error, and most of the time you’ll get color codes split in half. It prints
// the next half the same millisecond.
//
// It’s also needed because it is valid to print half an escape code for moving
// the cursor up, and then the other half. By buffering the escape code, we can
// pretend that escape codes always come in full in the rest of the code.
//
// Note: The terminals I’ve tested with seem to wait forever for the end of
// escape sequences – they don’t have a timeout or anything.
const UNFINISHED_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*|\][^\x1B\x07]*)?$/;

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
                : `'${subPart}'`,
            )
            .join(""),
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
    `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`,
  );

const AUTO_EXIT_REGEX = /^--auto-exit(?:=(\d+|auto))?$/;

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
    defaultStatus?: [string, string] | undefined,
    killAllSequence: string,
   }} CommandDescription
 *
 * @typedef {
    | { tag: "NoAutoExit" }
    | { tag: "AutoExit", maxParallel: number }
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
    if (flag === "-h" || flag === "--help") {
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
      autoExit = {
        tag: "AutoExit",
        maxParallel,
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
  const result = Codec.parse(Codec.array(commandDescriptionCodec), string);
  switch (result.tag) {
    case "Valid":
      return result.value;
    case "DecoderError":
      throw new Error(Codec.formatAll(result.errors));
  }
};

const statusCodec = Codec.map(
  Codec.orNull(Codec.tuple([Codec.string, Codec.string])),
  {
    decoder: (value) => value ?? undefined,
    encoder: (value) => value ?? null,
  },
);

/**
 * @type {Codec.Codec<CommandDescription>}
 */
const commandDescriptionCodec = Codec.map(
  Codec.fields(
    {
      command: nonEmptyArray(Codec.string),
      title: Codec.optional(Codec.string),
      cwd: Codec.optional(Codec.string),
      status: Codec.optional(
        Codec.flatMap(Codec.record(statusCodec), {
          decoder: (record) => {
            /** @type {Array<[RegExp, Codec.Infer<typeof statusCodec>]>} */
            const result = [];
            /** @type {Array<Codec.DecoderError>} */
            const errors = [];
            for (const [key, value] of Object.entries(record)) {
              try {
                result.push([RegExp(key, "u"), value]);
              } catch (error) {
                errors.push({
                  tag: "custom",
                  message:
                    error instanceof Error ? error.message : String(error),
                  got: key,
                  path: [key],
                });
              }
            }
            const [firstError, ...restErrors] = errors;
            return firstError === undefined
              ? { tag: "Valid", value: result }
              : {
                  tag: "DecoderError",
                  errors: [firstError, ...restErrors],
                };
          },
          /**
           * @param {Array<[RegExp, Codec.Infer<typeof statusCodec>]>} items
           * @returns {Record<string, Codec.Infer<typeof statusCodec>>}
           */
          encoder: (items) =>
            Object.fromEntries(
              items.map(([key, value]) => [key.source, value]),
            ),
        }),
      ),
      defaultStatus: Codec.optional(statusCodec),
      killAllSequence: Codec.optional(Codec.string),
    },
    { disallowExtraFields: true },
  ),
  {
    decoder: ({
      command,
      title = commandToPresentationName(command),
      cwd = ".",
      status = [],
      killAllSequence = KEY_CODES.kill,
      ...rest
    }) => ({ ...rest, command, title, cwd, status, killAllSequence }),
    encoder: (value) => value,
  },
);

/**
 * @template Decoded
 * @param {Codec.Codec<Decoded>} decoder
 * @returns {Codec.Codec<Array<Decoded>>}
 */
function nonEmptyArray(decoder) {
  return Codec.flatMap(Codec.array(decoder), {
    decoder: (arr) =>
      arr.length === 0
        ? {
            tag: "DecoderError",
            errors: [
              {
                tag: "custom",
                message: "Expected a non-empty array",
                got: arr,
                path: [],
              },
            ],
          }
        : { tag: "Valid", value: arr },
    encoder: (value) => value,
  });
}

/**
 * @param {Command} command
 * @returns {string}
 */
const joinHistory = (command) =>
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
      addHistoryStart: boolean,
      commandDescription: CommandDescription,
      onData: (data: string, statusFromRulesChanged: boolean) => undefined,
      onRequest: (data: string) => undefined,
      onExit: (exitCode: number) => undefined,
     }} commandInit
   */
  constructor({
    label,
    addHistoryStart,
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
    this.titlePossiblyWithGraphicRenditions = NO_COLOR
      ? removeGraphicRenditions(title)
      : title;
    this.formattedCommandWithTitle =
      title === formattedCommand
        ? formattedCommand
        : NO_COLOR
        ? `${removeGraphicRenditions(title)}: ${formattedCommand}`
        : `${bold(title)}: ${formattedCommand}`;
    this.onData = onData;
    this.onRequest = onRequest;
    this.onExit = onExit;
    this.addHistoryStart = addHistoryStart;
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
    this.windowsConptyCursorMoveWorkaround = false;
    this.unfinishedEscapeBuffer = "";

    // When adding --auto-exit, I first tried to always set `this.history = ""`
    // and add `historyStart()` in `joinHistory`. However, that doesn’t work
    // properly because `this.history` can be truncated based on `CLEAR_REGEX`
    // and `MAX_HISTORY` – and that should include the `historyStart` bit.
    // (We don’t want `historyStart` for --auto-exit.)
    /** @type {string} */
    this.history = addHistoryStart ? historyStart(waitingIndicator, this) : "";
    this.historyAlternateScreen = "";
  }

  /**
   * @param {{ needsToWait: boolean }} options
   * @returns {void}
   */
  start({ needsToWait }) {
    if ("terminal" in this.status) {
      throw new Error(
        `Cannot start command because the command is ${this.status.tag} with pid ${this.status.terminal.pid} for: ${this.title}`,
      );
    }

    this.history = this.addHistoryStart
      ? historyStart(needsToWait ? waitingIndicator : runningIndicator, this)
      : "";
    this.historyAlternateScreen = "";
    this.isSimpleLog = true;
    this.isOnAlternateScreen = false;
    this.statusFromRules = extractStatus(this.defaultStatus);
    // See the comment for `CONPTY_CURSOR_MOVE`.
    this.windowsConptyCursorMoveWorkaround = IS_WINDOWS;

    if (needsToWait) {
      this.status = { tag: "Waiting" };
      return;
    }

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

    const disposeOnData = terminal.onData((rawData) => {
      const rawDataWithBuffer = this.unfinishedEscapeBuffer + rawData;
      const match = UNFINISHED_ESCAPE.exec(rawDataWithBuffer);
      const [data, unfinishedEscapeBuffer] =
        match === null
          ? [rawDataWithBuffer, ""]
          : [rawDataWithBuffer.slice(0, match.index), match[0]];
      this.unfinishedEscapeBuffer = unfinishedEscapeBuffer;
      for (const [index, rawPart] of data.split(ESCAPES_REQUEST).entries()) {
        let part = rawPart;
        if (
          this.windowsConptyCursorMoveWorkaround &&
          CONPTY_CURSOR_MOVE.test(rawPart)
        ) {
          part = rawPart.replace(
            CONPTY_CURSOR_MOVE,
            CONPTY_CURSOR_MOVE_REPLACEMENT,
          );
          this.windowsConptyCursorMoveWorkaround = false;
        }
        if (index % 2 === 0) {
          if (part !== "") {
            const statusFromRulesChanged = this.pushHistory(part);
            this.onData(part, statusFromRulesChanged);
          }
        } else {
          this.onRequest(part);
        }
      }
    });

    const disposeOnExit = terminal.onExit(({ exitCode }) => {
      disposeOnData.dispose();
      disposeOnExit.dispose();

      const previousStatus = this.status;
      this.status = {
        tag: "Exit",
        exitCode,
        wasKilled: this.status.tag === "Killing",
      };
      if (previousStatus.tag === "Killing" && previousStatus.restartAfterKill) {
        this.start({ needsToWait: false });
      }
      this.onExit(exitCode);
    });

    this.status = { tag: "Running", terminal };
  }

  /**
   * @params {{ restartAfterKill?: boolean }} options
   * @returns {undefined}
   */
  kill({ restartAfterKill = false } = {}) {
    switch (this.status.tag) {
      case "Running":
        this.status = {
          tag: "Killing",
          terminal: this.status.terminal,
          slow: false,
          lastKillPress: undefined,
          restartAfterKill,
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
        this.status.restartAfterKill = restartAfterKill;
        return undefined;
      }

      case "Waiting":
      case "Exit":
        throw new Error(
          `Cannot kill ${this.status.tag} pty for: ${this.title}`,
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
                  -MAX_HISTORY,
                );
              }
            }
          } else {
            this.history += part;
            // Take one extra character so `NOT_SIMPLE_LOG_ESCAPE` can match the
            // `\n${CURSOR_UP}` pattern.
            const matches = this.history
              .slice(-part.length - 1)
              .matchAll(NOT_SIMPLE_LOG_ESCAPE);
            for (const match of matches) {
              const clearAll = match[1] !== undefined;
              const clearDown = match[2] !== undefined;
              if (clearAll) {
                this.history = "";
                this.isSimpleLog = true;
              } else {
                this.isSimpleLog = clearDown;
              }
            }
            if (this.history.length > MAX_HISTORY) {
              this.history = this.history.slice(-MAX_HISTORY);
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
      this.isOnAlternateScreen ? this.historyAlternateScreen : this.history,
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
    | { tag: "ByIndicator", indicator: string, keyboardIndex: number }
   } Selection
 */

/**
 * @param {Array<CommandDescription>} commandDescriptions
 * @param {AutoExit} autoExit
 * @returns {void}
 */
const runInteractively = (commandDescriptions, autoExit) => {
  /** @type {Current} */
  let current = { tag: "Dashboard", previousRender: [] };
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
    { ignoreAlternateScreen = false } = {},
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
          1,
        )}${RESET_COLOR}${CLEAR_LEFT}${CLEAR_DOWN}${RESTORE_CURSOR}`,
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
      if (
        command.isSimpleLog &&
        (!isBadWindows ||
          removeGraphicRenditions(getLastLine(command.history)) === "")
      ) {
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
            RESTORE_CURSOR,
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
            : runningText(command.status.terminal.pid),
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
            CLEAR_DOWN +
            newlines +
            (command.status.tag === "Waiting"
              ? waitingText(commands)
              : exitText(commands, command, command.status, autoExit)),
        );

        extraTextPrinted = false;
        return undefined;
      }
    }
  };

  /**
   * @param {{ forceClearScrollback?: boolean }} options
   * @returns {void}
   */
  const switchToDashboard = ({ forceClearScrollback = false } = {}) => {
    const previousRender =
      current.tag === "Dashboard" &&
      current.previousRender.length <= process.stdout.rows &&
      Math.max(...current.previousRender.map((line) => line.length)) <=
        process.stdout.columns &&
      !forceClearScrollback
        ? current.previousRender
        : [];

    const currentRender = drawDashboard({
      commands,
      width: process.stdout.columns,
      attemptedKillAll,
      autoExit,
      selection,
    })
      .split("\n")
      .slice(0, process.stdout.rows);

    const clear = previousRender.length === 0 ? CLEAR : "";
    const numLinesToClear = previousRender.length - currentRender.length;

    current = { tag: "Dashboard", previousRender: currentRender };
    process.stdout.write(
      HIDE_CURSOR +
        DISABLE_ALTERNATE_SCREEN +
        DISABLE_APPLICATION_CURSOR_KEYS +
        ENABLE_MOUSE +
        RESET_COLOR +
        clear +
        currentRender
          .map((line, index) =>
            line === previousRender[index]
              ? ""
              : cursorAbsolute(index + 1, 1) + CLEAR_RIGHT + line,
          )
          .join("") +
        Array.from(
          { length: numLinesToClear },
          (_, index) =>
            cursorAbsolute(currentRender.length + index + 1, 1) + CLEAR_RIGHT,
        ).join(""),
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
        CLEAR,
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
  const hideSelection = () => {
    selection = {
      tag: "Invisible",
      index:
        selection.tag === "ByIndicator"
          ? selection.keyboardIndex
          : selection.index,
    };
  };

  /**
   * @returns {void}
   */
  const killAll = () => {
    attemptedKillAll = true;
    hideSelection();
    for (const command of commands) {
      if (command.status.tag === "Killing") {
        command.status.restartAfterKill = false;
      }
    }
    const notExited = commands.filter(
      (command) => "terminal" in command.status,
    );
    if (notExited.length === 0) {
      switchToDashboard({ forceClearScrollback: true });
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
   * @param {number} index
   * @param {Extract<Status, {tag: "Exit"}>} status
   * @returns {void}
   */
  const restart = (index, status) => {
    const command = commands[index];
    if (autoExit.tag === "AutoExit") {
      if (!(status.exitCode === 0 && !status.wasKilled)) {
        const numRunning = commands.filter(
          (command2) => "terminal" in command2.status,
        ).length;
        attemptedKillAll = false;
        command.start({
          needsToWait: numRunning >= autoExit.maxParallel,
        });
        switchToCommand(index);
      }
    } else {
      attemptedKillAll = false;
      command.start({ needsToWait: false });
      switchToCommand(index);
    }
  };

  /**
   * @returns {void}
   */
  const restartExited = () => {
    if (autoExit.tag === "AutoExit") {
      const exited = commands.filter(
        (command) =>
          command.status.tag === "Exit" &&
          (command.status.exitCode !== 0 || command.status.wasKilled),
      );
      if (exited.length > 0) {
        const numRunning = commands.filter(
          (command2) => "terminal" in command2.status,
        ).length;
        attemptedKillAll = false;
        for (const [index, command] of exited.entries()) {
          command.start({
            needsToWait: numRunning + index >= autoExit.maxParallel,
          });
        }
      }
    } else {
      const exited = commands.filter(
        (command) => command.status.tag === "Exit",
      );
      if (exited.length > 0) {
        attemptedKillAll = false;
        for (const command of exited) {
          command.start({ needsToWait: false });
        }
      }
    }

    // Redraw dashboard.
    switchToDashboard();
  };

  /**
   * @param {string} indicator
   * @returns {void}
   */
  const restartByIndicator = (indicator) => {
    attemptedKillAll = false;
    hideSelection();
    const matchingCommands = commands.filter(
      (command) => getIndicatorChoice(command) === indicator,
    );
    for (const command of matchingCommands) {
      switch (command.status.tag) {
        case "Exit":
          command.start({ needsToWait: false });
          break;
        case "Waiting":
          break;
        case "Running":
          command.kill({ restartAfterKill: true });
          break;
        case "Killing":
          command.status.lastKillPress = Date.now(); // Force kill.
          command.kill({ restartAfterKill: true });
          break;
      }
    }

    // Redraw dashboard.
    switchToDashboard();
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
        addHistoryStart: true,
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
                      `Received unexpected output from ${command.status.tag} pty for: ${command.title}\n${data}`,
                    );
                }
              }
              return undefined;

            case "Dashboard":
              if (
                selection.tag === "ByIndicator" &&
                !getIndicatorChoices(commands).includes(selection.indicator)
              ) {
                selection = {
                  tag: "Invisible",
                  index: selection.keyboardIndex,
                };
                // Redraw dashboard.
                switchToDashboard();
              } else if (statusFromRulesChanged) {
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
        onExit: () => {
          // Exit the whole program if all commands have exited.
          if (isDone({ commands, attemptedKillAll, autoExit })) {
            switchToDashboard({ forceClearScrollback: true });
            process.exit(
              autoExit.tag === "AutoExit" && attemptedKillAll ? 1 : 0,
            );
          }

          const nextWaitingIndex = commands.findIndex(
            (command) => command.status.tag === "Waiting",
          );
          if (nextWaitingIndex !== -1 && !attemptedKillAll) {
            commands[nextWaitingIndex].start({ needsToWait: false });
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
              if (
                selection.tag === "ByIndicator" &&
                !getIndicatorChoices(commands).includes(selection.indicator)
              ) {
                selection = {
                  tag: "Invisible",
                  index: selection.keyboardIndex,
                };
              }
              // Redraw dashboard.
              switchToDashboard();
              return undefined;
          }
        },
      }),
  );

  process.stdout.on("resize", () => {
    for (const command of commands) {
      if ("terminal" in command.status) {
        command.status.terminal.resize(
          process.stdout.columns,
          process.stdout.rows,
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
                command.status.terminal.write(part);
                break;
              // In the dashboard, make an educated guess where the cursor would be in the command.
              case "Dashboard": {
                const numLines = (
                  command.isOnAlternateScreen
                    ? command.historyAlternateScreen
                    : command.history
                ).split("\n").length;
                const likelyRow = Math.min(numLines, process.stdout.rows);
                command.status.terminal.write(
                  part.replace(CURSOR_POSITION_RESPONSE, `$1${likelyRow};1R`),
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
      } else if (part !== "") {
        onStdin(
          part,
          autoExit,
          current,
          commands,
          selection,
          switchToDashboard,
          switchToCommand,
          setSelection,
          killAll,
          restart,
          restartExited,
          restartByIndicator,
        );
      }
    }
  });

  process.on("exit", () => {
    process.stdout.write(
      SHOW_CURSOR + DISABLE_BRACKETED_PASTE_MODE + DISABLE_MOUSE + RESET_COLOR,
    );
  });

  const maxParallel =
    autoExit.tag === "AutoExit" ? autoExit.maxParallel : Infinity;
  for (const [index, command] of commands.entries()) {
    command.start({ needsToWait: index >= maxParallel });
  }

  if (commandDescriptions.length === 1) {
    switchToCommand(0);
  } else {
    switchToDashboard();
  }
};

/**
 * @param {string} data
 * @param {AutoExit} autoExit
 * @param {Current} current
 * @param {Array<Command>} commands
 * @param {Selection} selection
 * @param {() => void} switchToDashboard
 * @param {(index: number, options?: { hideSelection?: boolean }) => void} switchToCommand
 * @param {(newSelection: Selection) => void} setSelection
 * @param {() => void} killAll
 * @param {(index: number, status: Extract<Status, {tag: "Exit"}>) => void} restart
 * @param {() => void} restartExited
 * @param {(indicator: string) => void} restartByIndicator
 * @returns {undefined}
 */
const onStdin = (
  data,
  autoExit,
  current,
  commands,
  selection,
  switchToDashboard,
  switchToCommand,
  setSelection,
  killAll,
  restart,
  restartExited,
  restartByIndicator,
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
              restart(current.index, command.status);
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
          switch (selection.tag) {
            case "Invisible":
              restartExited();
              return undefined;
            case "Mousedown":
            case "Keyboard":
              switchToCommand(selection.index);
              return undefined;
            case "ByIndicator":
              restartByIndicator(selection.indicator);
              return undefined;
          }

        case KEY_CODES.up:
          if (selection.tag === "ByIndicator") {
            const indicators = getIndicatorChoices(commands);
            const index = indicators.indexOf(selection.indicator);
            const newIndex = index === 0 ? indicators.length - 1 : index - 1;
            setSelection({
              tag: "ByIndicator",
              indicator: indicators[newIndex],
              keyboardIndex: selection.keyboardIndex,
            });
          } else {
            setSelection({
              tag: "Keyboard",
              index:
                selection.tag === "Invisible"
                  ? selection.index
                  : selection.index === 0
                  ? commands.length - 1
                  : selection.index - 1,
            });
          }
          return undefined;

        case KEY_CODES.down:
          if (selection.tag === "ByIndicator") {
            const indicators = getIndicatorChoices(commands);
            const index = indicators.indexOf(selection.indicator);
            const newIndex =
              index === undefined || index === indicators.length - 1
                ? 0
                : index + 1;
            setSelection({
              tag: "ByIndicator",
              indicator: indicators[newIndex],
              keyboardIndex: selection.keyboardIndex,
            });
          } else {
            setSelection({
              tag: "Keyboard",
              index:
                selection.tag === "Invisible"
                  ? selection.index
                  : selection.index === commands.length - 1
                  ? 0
                  : selection.index + 1,
            });
          }
          return undefined;

        case KEY_CODES.left:
        case KEY_CODES.right: {
          if (autoExit.tag === "NoAutoExit") {
            if (selection.tag === "ByIndicator") {
              setSelection({
                tag: "Keyboard",
                index: selection.keyboardIndex,
              });
            } else {
              setSelection({
                tag: "ByIndicator",
                indicator: getIndicatorChoice(commands[selection.index]),
                keyboardIndex: selection.index,
              });
            }
          }
          return undefined;
        }

        case KEY_CODES.esc:
          setSelection({
            tag: "Invisible",
            index:
              selection.tag === "ByIndicator"
                ? selection.keyboardIndex
                : selection.index,
          });
          return undefined;

        default: {
          const commandIndex = commands.findIndex(
            (command) => command.label === data,
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
            mousePosition,
          );

          switch (mousePosition.type) {
            case "mousedown":
              if (index !== undefined) {
                setSelection({ tag: "Mousedown", index });
              }
              return undefined;

            case "mouseup": {
              switch (selection.tag) {
                case "Invisible":
                case "ByIndicator":
                  return undefined;
                case "Mousedown":
                case "Keyboard":
                  if (index !== undefined && index === selection.index) {
                    switchToCommand(index, { hideSelection: true });
                  } else {
                    setSelection({ tag: "Invisible", index: selection.index });
                  }
                  return undefined;
              }
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
    },
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
 * @returns {void}
 */
const runNonInteractively = (commandDescriptions, maxParallel) => {
  let attemptedKillAll = false;

  /**
   * @returns {void}
   */
  const killAll = () => {
    attemptedKillAll = true;
    const notExited = commands.filter(
      (command) => "terminal" in command.status,
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
          `${commandTitleOnlyWithIndicator(killingIndicator, command)}\n\n`,
        );
      }
    }
  };

  /** @type {Array<Command>} */
  const commands = commandDescriptions.map((commandDescription, index) => {
    const thisCommand = new Command({
      label: ALL_LABELS[index],
      addHistoryStart: false,
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
          (command) => "terminal" in command.status,
        ).length;
        const numExit = commands.filter(
          (command) => command.status.tag === "Exit",
        ).length;
        const numExit0 = commands.filter(
          (command) =>
            command.status.tag === "Exit" &&
            command.status.exitCode === 0 &&
            !command.status.wasKilled,
        ).length;

        process.stdout.write(
          exitTextAndHistory({
            command: thisCommand,
            exitCode,
            numExited: numExit,
            numTotal: commands.length,
          }),
        );

        // Exit the whole program if all commands have exited.
        if (
          (attemptedKillAll && numRunning === 0) ||
          numExit === commands.length
        ) {
          process.stdout.write(drawSummary(commands));
          process.exit(attemptedKillAll || numExit0 !== numExit ? 1 : 0);
        }

        const nextWaitingIndex = commands.findIndex(
          (command) => command.status.tag === "Waiting",
        );
        if (nextWaitingIndex !== -1 && !attemptedKillAll) {
          const command = commands[nextWaitingIndex];
          command.start({ needsToWait: false });
          process.stdout.write(
            `${commandTitleOnlyWithIndicator(runningIndicator, command)}\n\n`,
          );
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
          process.stdout.rows,
        );
      }
    }
  });

  setupSignalHandlers(commands, killAll);

  for (const [index, command] of commands.entries()) {
    const needsToWait = index >= maxParallel;
    command.start({ needsToWait });
    process.stdout.write(
      `${commandTitleOnlyWithIndicator(
        needsToWait ? waitingIndicator : runningIndicator,
        command,
      )}\n\n`,
    );
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
        );
      } else {
        console.error(
          "run-pty requires stdin to be a TTY to run properly (unless --auto-exit is used).",
        );
        process.exit(1);
      }
      return undefined;

    case "Error":
      console.error(parseResult.message);
      process.exit(1);
  }
};

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
