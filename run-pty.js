#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const pty = require("@lydell/node-pty");
const Codec = require("tiny-decoders");

/**
 * @typedef {
    | { tag: "Waiting" }
    | { tag: "Running", terminal: import("@lydell/node-pty").IPty }
    | { tag: "Killing", terminal: import("@lydell/node-pty").IPty, slow: boolean, lastKillPress: number | undefined, sentSignals: Array<string>, restartAfterKill: boolean }
    | { tag: "Exit", exitCode: number, wasKilled: boolean }
   } Status
 *
 * @typedef {
    | { tag: "KillAllSequence", restartAfterKill: boolean }
    | { tag: "Signal", signal: string, restartAfterKill: boolean }
   } KillMode
 *
 * @typedef {
    | { tag: "Command", index: number }
    | { tag: "Dashboard", previousRender: Array<string>, previousWidth: number, visibleCommands: VisibleCommands }
   } Current
 *
 * @typedef {{ start: number, end: number, moreAbove: boolean, moreBelow: boolean }} VisibleCommands
 */

const IS_WINDOWS = process.platform === "win32";
const IS_WINDOWS_TERMINAL = "WT_SESSION" in process.env; // https://github.com/microsoft/terminal/issues/1040
const SUPPORTS_EMOJI = !IS_WINDOWS || IS_WINDOWS_TERMINAL;

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

/** @type {Record<string, string>} */
const WIN32_KEY_CODES = {
  38: KEY_CODES.up,
  40: KEY_CODES.down,
  37: KEY_CODES.left,
  39: KEY_CODES.right,
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
// https://vt100.net/docs/vt510-rm/DECAWM.html
const DISABLE_AUTO_WRAP = "\x1B[?7l";
const ENABLE_AUTO_WRAP = "\x1B[?7h";
const ENABLE_MOUSE = "\x1B[?1000;1006h";
const DISABLE_MOUSE = "\x1B[?1000;1006l";
// https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md
const BEGIN_SYNC_UPDATE = "\x1B[?2026h";
const END_SYNC_UPDATE = "\x1B[?2026l";
// https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands
// OSC 0 sets both the icon name and the window title. Some terminals use the
// former for tabs (iTerm2), others the latter.
const SET_TITLE_REGEX = /\x1B\][012];/;
// XTWINOPS 22;0t and 23;0t push and pop both titles on a stack.
const PUSH_TITLE = "\x1B[22;0t";
const POP_TITLE = "\x1B[23;0t";
const RESET_COLOR = "\x1B[m";
const CLEAR = "\x1B[2J\x1B[3J\x1B[H";
const CLEAR_RIGHT = "\x1B[K";
const CLEAR_DOWN = "\x1B[J";

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

const CLEAR_REGEX_GLOBAL = RegExp(CLEAR_REGEX.source, "g");

// The longest match of `CLEAR_REGEX` is `\x1B[2J\x1B[3J\x1B[1;1H` (14 chars).
const CLEAR_MAX_LENGTH = 20;

/**
 * Append `part` to `history`. If the command cleared the screen (including
 * the scrollback), there’s no need to keep anything before that. If the history
 * gets too long, remove the start of it.
 *
 * @param {string} history
 * @param {string} part
 * @param {number} maxHistory
 * @returns {string}
 */
const appendHistory = (history, part, maxHistory) => {
  let result = history + part;

  // The escapes for clearing might be split between the previous part and
  // this one, so look back a bit.
  const lookBackStart = Math.max(0, history.length - CLEAR_MAX_LENGTH);
  for (const match of result
    .slice(lookBackStart)
    .matchAll(CLEAR_REGEX_GLOBAL)) {
    result = match.input.slice(match.index + match[0].length);
  }

  if (result.length > maxHistory) {
    // Note: `.slice(-maxHistory)` would keep everything if `maxHistory` is 0.
    result = result.slice(result.length - maxHistory);
    // Don’t start in the middle of an escape (or a line, or a surrogate pair):
    // Skip to the next newline or escape.
    const index = result.search(/[\n\x1B]/);
    if (index !== -1) {
      result = result.slice(index);
    }
  }

  return result;
};

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
  // 130 (128 + 2 (SIGINT)) commonly means exit by ctrl+c.
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

// Without emoji support, some indicators are the same character in different
// colors. The tab title can’t have colors, so use the NO_COLOR characters there
// instead, which are all different.
const TITLE_INDICATORS =
  NO_COLOR || SUPPORTS_EMOJI
    ? /** @type {Map<string, string>} */ (new Map())
    : new Map([
        [runningIndicator, "›"],
        [exitIndicator(1), "×"],
      ]);

const folder = NO_COLOR
  ? "⌂"
  : !SUPPORTS_EMOJI
    ? `\x1B[2m⌂${RESET_COLOR}`
    : "📂";

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
 * @param {string} arrow
 * @param {Array<Command>} hiddenCommands
 * @param {{ width: number, selectedIndicator: string | undefined, useSeparateKilledIndicator: boolean }} options
 * @returns {string}
 */
const drawMoreCommandsLine = (
  arrow,
  hiddenCommands,
  { width, selectedIndicator, useSeparateKilledIndicator },
) => {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const command of hiddenCommands) {
    const [icon] = statusText(command.status, {
      statusFromRules: command.statusFromRules ?? runningIndicator,
      useSeparateKilledIndicator,
    });
    counts.set(icon, (counts.get(icon) ?? 0) + 1);
  }

  // As wide as the labels, so that the first icon lines up with the icons of
  // the commands.
  const text = ` ${arrow} `;
  let line = dim(text);
  let { length } = text;
  let separator = "  ";
  for (const [icon, count] of counts) {
    // Position the count explicitly, since the actual width of the icon may vary.
    const countColumn = length + 2 + ICON_WIDTH;
    const countText = ` ${count}`;
    // One extra column for the highlighted space after a selected count, so
    // that whether a count fits does not depend on the selection.
    if (countColumn + countText.length + 1 > width) {
      break;
    }
    const countStart = cursorHorizontalAbsolute(countColumn + 1);
    if (icon === selectedIndicator) {
      // Like in `drawDashboardCommandLines`: Highlight one space on either
      // side, since the actual width of the icon may vary.
      line += NO_COLOR
        ? `${separator.slice(0, -1)}→${icon}${countStart}${countText} `
        : `${separator.slice(0, -1)}${invert(
            ` ${icon}${" ".repeat(ICON_WIDTH)}`,
          )}${countStart}${invert(`${countText} `)}`;
      // The highlighted space after the count is the first space of the next
      // separator.
      separator = " ";
    } else {
      line += `${separator}${icon}${countStart}${countText}`;
      separator = "  ";
    }
    length = countColumn + countText.length;
  }
  return `${line}${RESET_COLOR}`;
};

// Room needed for a “more” line above, a command and a “more” line below.
// Below this, the help text is hidden to make room for commands.
const MIN_COMMAND_ROWS = 3;

/**
 * Which commands are visible when there are more than fit in `numRows`.
 * Hidden commands are replaced by a “more” line at the top and/or bottom.
 * `scrollTop` is the index of the first visible command.
 *
 * @param {number} numCommands
 * @param {number} numRows
 * @param {number} scrollTop
 * @returns {VisibleCommands}
 */
const getVisibleCommands = (numCommands, numRows, scrollTop) => {
  if (numCommands <= numRows) {
    return { start: 0, end: numCommands, moreAbove: false, moreBelow: false };
  }
  // Too little room for “more” lines – only show commands.
  if (numRows < MIN_COMMAND_ROWS) {
    const start = Math.max(0, Math.min(scrollTop, numCommands - numRows));
    return {
      start,
      end: start + numRows,
      moreAbove: false,
      moreBelow: false,
    };
  }
  const clamped = Math.max(0, Math.min(scrollTop, numCommands - numRows + 1));
  // A “1 more” line above would take the same row as the one command it hides.
  const start = clamped === 1 ? 0 : clamped;
  const available = start === 0 ? numRows : numRows - 1;
  const end =
    numCommands - start <= available ? numCommands : start + available - 1;
  return {
    start,
    end,
    moreAbove: start > 0,
    moreBelow: end < numCommands,
  };
};

/**
 * Scroll as little as possible to make the command at `index` visible.
 *
 * @param {number} numCommands
 * @param {number} numRows
 * @param {number} scrollTop
 * @param {number | undefined} index
 * @returns {number}
 */
const scrollToCommand = (numCommands, numRows, scrollTop, index) => {
  const { start, end } = getVisibleCommands(numCommands, numRows, scrollTop);
  return index === undefined || (index >= start && index < end)
    ? start
    : index < start
      ? getVisibleCommands(numCommands, numRows, index).start
      : getVisibleCommands(
          numCommands,
          numRows,
          // Make room for the “more” lines above and below, if any.
          index - numRows + (numRows < MIN_COMMAND_ROWS ? 1 : 3),
        ).start;
};

/**
 * Prefer a matching command that is already visible, to avoid scrolling.
 *
 * @param {Array<Command>} commands
 * @param {string} indicator
 * @param {VisibleCommands} visibleCommands
 * @returns {number}
 */
const getFirstIndicatorIndex = (commands, indicator, { start, end }) => {
  /**
   * @param {Command} command
   * @returns {boolean}
   */
  const matches = (command) => getIndicatorChoice(command) === indicator;
  const visibleIndex = commands.slice(start, end).findIndex(matches);
  return visibleIndex === -1
    ? commands.findIndex(matches)
    : start + visibleIndex;
};

/**
 * @param {{
    commands: Array<Command>,
    width: number,
    height: number,
    scrollTop: number,
    attemptedKillAll: boolean,
    autoExit: AutoExit,
    selection: Selection,
   }} options
 * @returns {{ text: string, scrollTop: number, visibleCommands: VisibleCommands }}
 */
const drawDashboard = ({
  commands,
  width,
  height,
  scrollTop,
  attemptedKillAll,
  autoExit,
  selection,
}) => {
  const done = isDone({ commands, attemptedKillAll, autoExit });
  const useSeparateKilledIndicator = autoExit.tag === "AutoExit";

  const commandLines = drawDashboardCommandLines(
    commands,
    done ? { tag: "Invisible", index: 0 } : selection,
    { width, useSeparateKilledIndicator },
  ).map(({ line }) => line);

  if (done) {
    // This is the final output, which ends up in the scrollback, so show all commands.
    return {
      text: `${commandLines.join("\n")}\n`,
      scrollTop,
      visibleCommands: {
        start: 0,
        end: commands.length,
        moreAbove: false,
        moreBelow: false,
      },
    };
  }

  const label = summarizeLabels(commands.map((command) => command.label));

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

  /**
   * @param {string} enterText
   * @returns {string}
   */
  const drawHelp = (enterText) => {
    const autoExitText =
      autoExit.tag === "AutoExit"
        ? [
            enterText === "" ? undefined : "",
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
${shortcut(label)} focus command ${dim("(or click)")}
${shortcut(KEYS.kill)} ${killAllLabel(commands)}
${shortcut(navigationKeys)} move selection
${enterText}
${autoExitText}
`.trim();
  };

  const helpText = drawHelp(enter);

  // Reserve room for the tallest help text (which has two enter lines when
  // something is selected), so that the commands don’t move when the help
  // text changes. One extra row for the empty line between the commands and
  // the help.
  const numHelpRows = drawHelp("enter\nunselect").split("\n").length + 1;
  const showHelp =
    commands.length + numHelpRows <= height ||
    height - numHelpRows >= MIN_COMMAND_ROWS;
  const numCommandRows = showHelp ? height - numHelpRows : height;

  const selectedIndex =
    selection.tag === "ByIndicator"
      ? getFirstIndicatorIndex(
          commands,
          selection.indicator,
          getVisibleCommands(commands.length, numCommandRows, scrollTop),
        )
      : selection.tag === "Invisible"
        ? -1
        : selection.index;
  const newScrollTop = scrollToCommand(
    commands.length,
    numCommandRows,
    scrollTop,
    selectedIndex === -1 ? undefined : selectedIndex,
  );
  const visibleCommands = getVisibleCommands(
    commands.length,
    numCommandRows,
    newScrollTop,
  );
  const moreOptions = {
    width,
    selectedIndicator:
      selection.tag === "ByIndicator" ? selection.indicator : undefined,
    useSeparateKilledIndicator,
  };

  const finalLines = [
    visibleCommands.moreAbove
      ? drawMoreCommandsLine(
          "↑",
          commands.slice(0, visibleCommands.start),
          moreOptions,
        )
      : undefined,
    ...commandLines.slice(visibleCommands.start, visibleCommands.end),
    visibleCommands.moreBelow
      ? drawMoreCommandsLine(
          "↓",
          commands.slice(visibleCommands.end),
          moreOptions,
        )
      : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  return {
    text: showHelp ? `${finalLines}\n\n${helpText}`.trim() : finalLines,
    scrollTop: newScrollTop,
    visibleCommands,
  };
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
 * The directory name followed by counts per indicator, like `my-app 🟢3 🔴1`,
 * so you can see what’s going on in the terminal tab title even when focusing
 * a command (or another tab). The directory name tells several run-pty tabs
 * apart. (Shells usually show something like that in the title, which we
 * replace.)
 *
 * @param {Array<Command>} commands
 * @param {string} directoryName
 * @returns {string}
 */
const titleText = (commands, directoryName) => {
  const indicators = commands.map(getIndicatorChoice);
  const counts = getIndicatorChoices(commands).map(
    (indicator) =>
      `${removeGraphicRenditions(TITLE_INDICATORS.get(indicator) ?? indicator)}${
        indicators.filter((other) => other === indicator).length
      }`,
  );
  return (
    [directoryName, ...counts]
      // Control characters could end the title early (BEL) or start other
      // escapes (ESC). Directory names and custom indicators can contain them.
      .map((part) => part.replace(/[\x00-\x1F\x7F-\x9F]/g, ""))
      .filter((part) => part !== "")
      .join(" ")
  );
};

/**
 * @param {string} title
 * @returns {string}
 */
const setTitle = (title) => `\x1B]0;${title}\x07`;

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
 * The keyboard shortcuts are printed once at the start, rather than below the
 * command output. Printing them in the middle of the command output (and
 * removing them again) can cause the output to be messed up.
 *
 * @param {CommandText} command
 * @returns {string}
 */
const historyStartRunning = (command) =>
  `${historyStart(runningIndicator, command)}${runningText}\n\n`;

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

const runningText = `
${shortcut(KEYS.kill)} kill ${dim("(then double-press to force)")}
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
// - 11t, 13t, 14t, 15t, 16t, 18t, 19t: Report window state, position, size
//   etc. Reply is also a `t` escape, but with other numbers (such as 1t or 2t
//   for 11t). Other `t` escapes, such as 22;2t and 23;2t (save/restore window
//   title, which Vim does), are not requests – there is no reply.
// - 20t, 21t: Report icon label and window title. Reply is `]L` and `]l`.
// - ]10;? and ]11;?: Report foreground/background color. https://unix.stackexchange.com/a/172674
// - ]4;NUM;?: Report color NUM in the palette.
// - `ESCAPES_REQUEST` also matches `BEGIN_SYNC_UPDATE` and `END_SYNC_UPDATE` at the end.
//
// Note: Terminals might not reply to all requests. For example, many terminals
// don’t reply to window reports by default. See `REQUEST_TIMEOUT`.
const ESCAPES_REQUEST =
  /(\x1B\[(?:\??6n|(?:1[13-689]|2[01])(?:;\d*)?t)|\x1B\](?:1[01]|4;\d+);\?(?:\x07|\x1B\\)|\x1B\[\?2026[hl])/g;
const ESCAPES_RESPONSE =
  /(\x1B\[(?:\??\d+;\d+(?:;\d+)?R|\d*(?:;\d*){0,2}t)|\x1B\](?:1[01]|4;\d+);[^\x07\x1B]+(?:\x07|\x1B\\)|\x1B\][Ll][^\x07\x1B]*(?:\x07|\x1B\\))/g;

// If the terminal does not reply to a request within this time, give up on it.
// Otherwise, an unanswered request would block all later requests (from all
// commands) forever. When giving up, also drop other queued requests of the
// same kind from the same command, since the terminal most likely won’t reply
// to those either (some programs ask for all 256 palette colors).
const REQUEST_TIMEOUT = 1000; // ms

/**
 * Which kind of request an escape is, or which kind of request a response
 * escape is a reply to. Used to make sure that a response is for the request
 * we’re waiting for (and not a late response for a timed out request).
 *
 * Note: All window reports are treated as the same kind, even though, for
 * example, `CSI 4 ; height ; width t` is only a response to `CSI 14 t`. So a
 * late response to one window report could be taken as the response to another.
 * That requires a terminal that replies after `REQUEST_TIMEOUT`, which is rare
 * (terminals that don’t support window reports usually don’t reply at all), so
 * it’s not worth the extra complexity to distinguish them.
 *
 * @param {string} escape
 * @returns {{ group: "cursor position" | "window" | "color" | "other", id: string }}
 */
const requestKind = (escape) => {
  if (escape.endsWith("n") || escape.endsWith("R")) {
    return { group: "cursor position", id: "" };
  }
  if (escape.endsWith("t") || /^\x1B\][Ll]/.test(escape)) {
    return { group: "window", id: "" };
  }
  const match = /^\x1B\]((?:4;)?\d+);/.exec(escape);
  return match === null
    ? { group: "other", id: escape }
    : { group: "color", id: match[1] };
};

/**
 * @param {string} response
 * @param {string} request
 * @returns {boolean}
 */
const isResponseTo = (response, request) => {
  const responseKind = requestKind(response);
  const expectedKind = requestKind(request);
  return (
    responseKind.group === expectedKind.group &&
    responseKind.id === expectedKind.id
  );
};
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
// Strings (OSC `ESC ]`, DCS `ESC P`, APC `ESC _`, PM `ESC ^` and SOS `ESC X`)
// are buffered until terminated by BEL or ST (`ESC \`). The ESC of ST can come
// in one chunk and the backslash in the next.
//
// Escapes with intermediate bytes (such as `ESC ( B`) are buffered until the
// final byte.
//
// Note: The terminals I’ve tested with seem to wait forever for the end of
// escape sequences – they don’t have a timeout or anything.
const UNFINISHED_ESCAPE =
  /\x1B(?:\[[0-?]*[ -/]*|[\]P_^X][^\x1B\x07]*\x1B?|[ -/]+)?$/;

const GRAPHIC_RENDITIONS = /(\x1B\[(?:\d+(?:;\d+)*)?m)/g;

/**
 * @param {string} string
 * @returns {string}
 */
const removeGraphicRenditions = (string) =>
  string.replace(GRAPHIC_RENDITIONS, "");

// https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md
// All fields are optional. These are the fields:
// 1. Virtual key code: Captured by the regex. Needed for the arrow keys.
// 2. Virtual scan code: Not interesting for us.
// 3. Unicode char: Captured by the regex. Needed for keys that have some sort of char output.
// 4. Keydown: Captured by the regex.
// 5. Modifier key state: Not interesting for us. (It doesn’t matter if the unicode char was produced with a modifier held or not.)
// 6. Repeat count: Not interesting for us.
const WIN32_INPUT_MODE_REGEX =
  /\x1B\[(\d*)(?:;\d*(?:;(?:(\d*)(?:;([01]?)(?:;\d*(?:;\d*)?)?)?)?)?)?_/g;

/**
 * https://dev.to/andylbrummer/taming-windows-terminals-win32-input-mode-in-go-conpty-applications-7gg
 * > writing PTY output to stdout causes Windows Terminal to enable win32-input-mode for the session
 * This translates some of the win32-input-mode escape sequences back to “normal” so that run-pty’s
 * keyboard shortcuts work.
 * @param {string} data
 * @returns {string}
 */
const convertWin32InputMode = (data) =>
  data.replace(
    WIN32_INPUT_MODE_REGEX,
    /**
     * @param {string} match
     * @param {string | undefined} keyCode
     * @param {string | undefined} unicodeChar
     * @param {string | undefined} keyDown
     */
    (match, keyCode = "0", unicodeChar = "0", keyDown = "0") =>
      // Only process keydown events (keyDown=1), ignore keyup (keyDown=0).
      keyDown === "1"
        ? unicodeChar === "0"
          ? (WIN32_KEY_CODES[keyCode] ?? match)
          : String.fromCodePoint(Number(unicodeChar))
        : match,
  );

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
  const result = Codec.JSON.parse(Codec.array(commandDescriptionCodec), string);
  switch (result.tag) {
    case "Valid":
      return result.value;
    case "DecoderError":
      throw new Error(Codec.format(result.error));
  }
};

const statusCodec = Codec.map(
  Codec.nullOr(Codec.tuple([Codec.string, Codec.string])),
  {
    decoder: (value) => value ?? undefined,
    encoder: (value) => value ?? null,
  },
);

const statusesCodec = Codec.flatMap(Codec.record(statusCodec), {
  decoder: (record) => {
    /** @type {Array<[RegExp, Codec.Infer<typeof statusCodec>]>} */
    const result = [];
    for (const [key, value] of Object.entries(record)) {
      try {
        result.push([RegExp(key, "u"), value]);
      } catch (error) {
        return {
          tag: "DecoderError",
          error: {
            tag: "custom",
            message: error instanceof Error ? error.message : String(error),
            got: key,
            path: [key],
          },
        };
      }
    }
    return { tag: "Valid", value: result };
  },
  encoder: (items) =>
    Object.fromEntries(items.map(([key, value]) => [key.source, value])),
});

/**
 * @type {Codec.Codec<CommandDescription>}
 */
const commandDescriptionCodec = Codec.map(
  Codec.fields(
    {
      command: nonEmptyArray(Codec.string),
      title: Codec.field(Codec.string, { optional: true }),
      cwd: Codec.field(Codec.string, { optional: true }),
      status: Codec.field(statusesCodec, { optional: true }),
      defaultStatus: Codec.field(statusCodec, { optional: true }),
      killAllSequence: Codec.field(Codec.string, { optional: true }),
    },
    { allowExtraFields: false },
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
            error: {
              tag: "custom",
              message: "Expected a non-empty array",
              got: arr,
              path: [],
            },
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
      onSynchronizedOutputChange: (data: string) => undefined,
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
    onSynchronizedOutputChange,
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
    this.onSynchronizedOutputChange = onSynchronizedOutputChange;
    this.onExit = onExit;
    this.addHistoryStart = addHistoryStart;
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
    // Whether the command has set the terminal title itself. If so, the
    // command’s title wins while it’s focused.
    this.hasSetTitle = false;

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
      ? needsToWait
        ? historyStart(waitingIndicator, this)
        : historyStartRunning(this)
      : "";
    this.historyAlternateScreen = "";
    this.isOnAlternateScreen = false;
    this.unfinishedEscapeBuffer = "";
    this.hasSetTitle = false;
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
            if (SET_TITLE_REGEX.test(part)) {
              this.hasSetTitle = true;
            }
            const statusFromRulesChanged = this.pushHistory(part);
            this.onData(part, statusFromRulesChanged);
          }
        } else if (part === BEGIN_SYNC_UPDATE || part === END_SYNC_UPDATE) {
          this.onSynchronizedOutputChange(part);
        } else {
          this.onRequest(part);
        }
      }
    });

    const disposeOnExit = terminal.onExit(
      ({ exitCode: actualExitCode, signal }) => {
        disposeOnData.dispose();
        disposeOnExit.dispose();

        // There’s a convention to use 128 + signal for the exit code when a
        // process is killed by a signal.
        const exitCode =
          signal === undefined || signal === 0 ? actualExitCode : 128 + signal;
        const previousStatus = this.status;
        this.status = {
          tag: "Exit",
          exitCode,
          wasKilled: this.status.tag === "Killing",
        };
        if (
          previousStatus.tag === "Killing" &&
          previousStatus.restartAfterKill
        ) {
          this.start({ needsToWait: false });
        }
        this.onExit(exitCode);
      },
    );

    this.status = { tag: "Running", terminal };
  }

  /**
   * @param {KillMode} killMode
   * @returns {undefined}
   */
  kill(killMode) {
    const { restartAfterKill } = killMode;
    switch (this.status.tag) {
      case "Running": {
        /** @type {Extract<Status, { tag: "Killing" }>} */
        const killingStatus = {
          tag: "Killing",
          terminal: this.status.terminal,
          slow: false,
          lastKillPress: undefined,
          sentSignals: [],
          restartAfterKill,
        };
        this.status = killingStatus;
        setTimeout(() => {
          // Only if it is still the same kill (not killed again after a restart).
          if (this.status === killingStatus) {
            killingStatus.slow = true;
            // Ugly way to redraw:
            this.onData("", false);
          }
        }, SLOW_KILL);
        switch (killMode.tag) {
          case "KillAllSequence":
            killingStatus.terminal.write(this.killAllSequence);
            break;
          case "Signal":
            killGroup(killingStatus.terminal, killMode.signal);
            killingStatus.sentSignals.push(killMode.signal);
            break;
        }
        return undefined;
      }

      case "Killing": {
        switch (killMode.tag) {
          case "KillAllSequence": {
            const now = Date.now();
            if (
              this.status.lastKillPress !== undefined &&
              now - this.status.lastKillPress <= DOUBLE_PRESS
            ) {
              killGroup(this.status.terminal, "SIGKILL");
            } else {
              this.status.terminal.write(this.killAllSequence);
            }
            this.status.lastKillPress = now;
            break;
          }
          case "Signal":
            // Receiving the same signal again means that the command did not
            // exit from it the first time, so force kill.
            if (this.status.sentSignals.includes(killMode.signal)) {
              killGroup(this.status.terminal, "SIGKILL");
            } else {
              killGroup(this.status.terminal, killMode.signal);
              this.status.sentSignals.push(killMode.signal);
            }
            break;
        }
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
            this.historyAlternateScreen = appendHistory(
              this.historyAlternateScreen,
              part,
              MAX_HISTORY,
            );
          } else {
            this.history = appendHistory(this.history, part, MAX_HISTORY);
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
  let current = {
    tag: "Dashboard",
    previousRender: [],
    previousWidth: 0,
    visibleCommands: { start: 0, end: 0, moreAbove: false, moreBelow: false },
  };
  let attemptedKillAll = false;
  /** @type {Selection} */
  let selection = { tag: "Invisible", index: 0 };
  // Index of the first visible command in the dashboard, when not all fit.
  let scrollTop = 0;
  /**
   * @param {Command} command
   * @param {string} data
   * @returns {undefined}
   */
  const printDataWithExtraText = (command, data) => {
    switch (command.status.tag) {
      case "Running":
      case "Killing":
        process.stdout.write(data);
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
            BEGIN_SYNC_UPDATE +
            HIDE_CURSOR +
            RESET_COLOR +
            disableAlternateScreen +
            CLEAR_DOWN +
            newlines +
            (command.status.tag === "Waiting"
              ? waitingText(commands)
              : exitText(commands, command, command.status, autoExit)) +
            END_SYNC_UPDATE,
        );
        return undefined;
      }
    }
  };

  const directoryName = path.basename(process.cwd());

  /** @type {string | undefined} */
  let lastTitle = undefined;

  /**
   * Set the terminal title, unless the focused command has set it itself.
   *
   * @returns {void}
   */
  const updateTitle = () => {
    if (current.tag === "Command" && commands[current.index].hasSetTitle) {
      // The command owns the title now, so we need to set it again later.
      lastTitle = undefined;
      return;
    }
    const title = titleText(commands, directoryName);
    if (title !== lastTitle) {
      lastTitle = title;
      process.stdout.write(setTitle(title));
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
      current.previousWidth <= process.stdout.columns &&
      !forceClearScrollback
        ? current.previousRender
        : [];

    const dashboard = drawDashboard({
      commands,
      width: process.stdout.columns,
      // `rows` is undefined if stdout is not a TTY.
      height: process.stdout.rows ?? Infinity,
      scrollTop,
      attemptedKillAll,
      autoExit,
      selection,
    });
    ({ scrollTop } = dashboard);

    if (isDone({ commands, attemptedKillAll, autoExit })) {
      // The final dashboard can be taller than the terminal, so print it
      // normally rather than positioning each line.
      process.stdout.write(
        BEGIN_SYNC_UPDATE +
          DISABLE_ALTERNATE_SCREEN +
          DISABLE_APPLICATION_CURSOR_KEYS +
          RESET_COLOR +
          DISABLE_AUTO_WRAP +
          CLEAR +
          dashboard.text +
          ENABLE_AUTO_WRAP +
          END_SYNC_UPDATE,
      );
      return;
    }

    const currentRender = dashboard.text
      .split("\n")
      .slice(0, process.stdout.rows);

    const clear = previousRender.length === 0 ? CLEAR : "";
    const numLinesToClear = previousRender.length - currentRender.length;

    current = {
      tag: "Dashboard",
      previousRender: currentRender,
      previousWidth: process.stdout.columns,
      visibleCommands: dashboard.visibleCommands,
    };
    process.stdout.write(
      BEGIN_SYNC_UPDATE +
        HIDE_CURSOR +
        DISABLE_ALTERNATE_SCREEN +
        DISABLE_APPLICATION_CURSOR_KEYS +
        ENABLE_MOUSE +
        RESET_COLOR +
        // `truncate` counts string length rather than terminal columns, so
        // lines with wide characters (like emoji) can end up too wide. Without
        // this, they would wrap onto the next line – which isn’t redrawn if it
        // hasn’t changed since the previous render.
        DISABLE_AUTO_WRAP +
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
        ).join("") +
        ENABLE_AUTO_WRAP +
        END_SYNC_UPDATE,
    );

    updateTitle();
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

    printDataWithExtraText(command, joinHistory(command));
    updateTitle();
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
   * @param {number} delta Number of commands to scroll (negative is up).
   * @returns {void}
   */
  const scrollDashboard = (delta) => {
    if (current.tag !== "Dashboard") {
      return;
    }
    const { start, end, moreBelow } = current.visibleCommands;
    if (delta < 0 ? start === 0 : end === commands.length) {
      return;
    }
    // `drawDashboard` clamps the max. With “more” lines, 1 is treated as 0
    // (see `getVisibleCommands`), so skip to 2 to avoid getting stuck at the top.
    scrollTop =
      start === 0 && delta === 1 && moreBelow ? 2 : Math.max(0, start + delta);
    // Otherwise the dashboard would scroll right back to the selection.
    hideSelection();
    switchToDashboard();
  };

  /**
   * @param {KillMode} killMode
   * @returns {void}
   */
  const killAll = (killMode) => {
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
        command.kill(killMode);
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
          command.kill({ tag: "KillAllSequence", restartAfterKill: true });
          break;
        case "Killing":
          command.kill({
            tag: "Signal",
            signal: "SIGKILL",
            restartAfterKill: true,
          });
          break;
      }
    }

    // Redraw dashboard.
    switchToDashboard();
  };

  /** @type {Array<{ commandIndex: number, data: string }>} */
  const requests = [];
  let requestInFlight = false;
  /** @type {NodeJS.Timeout | undefined} */
  let requestTimeoutId = undefined;

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
    requestTimeoutId = setTimeout(() => {
      const { group } = requestKind(request.data);
      // Keep the first one, so `finishRequest` can remove it.
      for (let i = requests.length - 1; i >= 1; i--) {
        const other = requests[i];
        if (
          other.commandIndex === request.commandIndex &&
          requestKind(other.data).group === group
        ) {
          requests.splice(i, 1);
        }
      }
      finishRequest();
    }, REQUEST_TIMEOUT);
  };

  /**
   * @returns {void}
   */
  const finishRequest = () => {
    clearTimeout(requestTimeoutId);
    requests.shift();
    requestInFlight = false;
    handleNextRequest();
  };

  /** @type {Array<Command>} */
  const commands = commandDescriptions.map(
    (commandDescription, index) =>
      new Command({
        label: ALL_LABELS[index],
        addHistoryStart: true,
        commandDescription,
        onData: (data, statusFromRulesChanged) => {
          updateTitle();
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
        onSynchronizedOutputChange: (data) => {
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
                      `Received unexpected synchronized output change from ${command.status.tag} pty for: ${command.title}\n${JSON.stringify(data)}`,
                    );
                }
              }
              return undefined;
            case "Dashboard":
              return undefined;
          }
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

          updateTitle();

          switch (current.tag) {
            case "Command":
              if (current.index === index) {
                const command = commands[index];
                printDataWithExtraText(command, "");
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

  // When the terminal is closed (such as when closing the terminal window), we
  // get SIGHUP (see `setupSignalHandlers`), and reading/writing fails with EIO.
  // Ignore those errors, so that we can finish killing the commands and exit.
  for (const stream of [process.stdin, process.stdout]) {
    stream.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
      if (error.code !== "EIO") {
        throw error;
      }
    });
  }

  // `process.stderr` is created lazily on first access. For a TTY, that opens
  // the terminal device, which hangs forever if the terminal has been closed
  // (at least on macOS). Node.js accesses `process.stderr` internally when
  // stdin/stdout is destroyed – which happens when the terminal is closed. So
  // create it now, while the terminal is still there.
  void process.stderr;

  process.stdin.setRawMode(true);

  // Decode UTF-8 in a streaming fashion, so that multi-byte characters split
  // between chunks (such as in large pastes) aren’t corrupted.
  process.stdin.setEncoding("utf8");

  // Note: Each chunk is parsed on its own. Responses from the terminal are not
  // buffered across chunks. Terminals write each response in one go, so in
  // practice a response arrives in a single chunk. That isn’t guaranteed
  // though (for example over a slow connection), and then the response is
  // treated as regular input instead. That’s an accepted limitation, to avoid
  // the complexity of buffering (and deciding when to give up on a partial
  // response, since a lone ESC could also be the user pressing Escape).
  process.stdin.on("data", (/** @type {string} */ data) => {
    for (const [index, part] of data.split(ESCAPES_RESPONSE).entries()) {
      const request = requests[0];
      if (
        index % 2 === 1 &&
        requestInFlight &&
        request !== undefined &&
        isResponseTo(part, request.data)
      ) {
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
        finishRequest();
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
          () => {
            killAll({ tag: "KillAllSequence", restartAfterKill: false });
          },
          restart,
          restartExited,
          restartByIndicator,
          scrollDashboard,
        );
      }
    }
    // Keyboard shortcuts can kill and restart commands.
    updateTitle();
  });

  process.stdout.write(PUSH_TITLE);

  process.on("exit", () => {
    process.stdout.write(
      SHOW_CURSOR +
        DISABLE_BRACKETED_PASTE_MODE +
        DISABLE_MOUSE +
        RESET_COLOR +
        // Not all terminals support `POP_TITLE` (such as Terminal.app). Setting
        // an empty title first makes those go back to their default title.
        setTitle("") +
        POP_TITLE,
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
 * @param {string} rawData
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
 * @param {(delta: number) => void} scrollDashboard
 * @returns {undefined}
 */
const onStdin = (
  rawData,
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
  scrollDashboard,
) => {
  const data = IS_WINDOWS ? convertWin32InputMode(rawData) : rawData;
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
              command.kill({ tag: "KillAllSequence", restartAfterKill: false });
              return undefined;

            case KEY_CODES.dashboard:
              switchToDashboard();
              return undefined;

            default:
              // ctrl+c might not exit the command (for example, it clears the
              // line in REPLs), so typing means it is running again. But if
              // the command was sent a signal, it is still being killed.
              if (
                command.status.tag === "Running" ||
                command.status.sentSignals.length === 0
              ) {
                command.status = {
                  tag: "Running",
                  terminal: command.status.terminal,
                };
              }
              command.status.terminal.write(rawData);
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
            const newIndex = index === indicators.length - 1 ? 0 : index + 1;
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

          const wheelDelta = parseMouseWheel(data);
          if (wheelDelta !== 0) {
            scrollDashboard(wheelDelta);
            return undefined;
          }

          const mousePosition = parseMouse(data);
          if (mousePosition === undefined) {
            return undefined;
          }

          const target = getMouseTarget(
            commands,
            current.visibleCommands,
            mousePosition,
          );
          const index = target?.tag === "Command" ? target.index : undefined;

          switch (mousePosition.type) {
            case "mousedown":
              if (target?.tag === "More") {
                const { start, end } = current.visibleCommands;
                scrollDashboard(
                  target.direction === "up" ? start - end : end - start,
                );
              } else if (index !== undefined) {
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
const MOUSE_WHEEL_REGEX = /\x1B\[<(64|65);\d+;\d+M/g;

/**
 * Scrolling fast can result in several wheel events in the same chunk.
 *
 * @param {string} string
 * @returns {number} Net number of steps (negative is up).
 */
const parseMouseWheel = (string) =>
  Array.from(string.matchAll(MOUSE_WHEEL_REGEX)).reduce(
    (sum, [, button]) => sum + (button === "64" ? -1 : 1),
    0,
  );

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
 * @param {VisibleCommands} visibleCommands
 * @param {{ x: number, y: number }} mousePosition
 * @returns {{ tag: "Command", index: number } | { tag: "More", direction: "up" | "down" } | undefined}
 */
const getMouseTarget = (
  commands,
  { start, end, moreAbove, moreBelow },
  { x, y },
) => {
  const row = moreAbove ? y - 1 : y;
  const numVisible = end - start;

  if (moreAbove && row === -1) {
    return { tag: "More", direction: "up" };
  }

  if (moreBelow && row === numVisible) {
    return { tag: "More", direction: "down" };
  }

  if (row < 0 || row >= numVisible) {
    return undefined;
  }

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

  const index = start + row;
  return x >= 0 && x < lines[index].length
    ? { tag: "Command", index }
    : undefined;
};

/**
 * @param {Array<CommandDescription>} commandDescriptions
 * @param {number} maxParallel
 * @returns {void}
 */
const runNonInteractively = (commandDescriptions, maxParallel) => {
  let attemptedKillAll = false;

  /**
   * @param {KillMode} killMode
   * @returns {void}
   */
  const killAll = (killMode) => {
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
        command.kill(killMode);
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
      onSynchronizedOutputChange: () => undefined,
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
 * Send `signal` to the whole process group (negative PID) of the command, not
 * just the top process. That reaches subprocesses too, just like ctrl+c in a
 * terminal does. (For SIGKILL, the kernel is supposed to send SIGHUP to the
 * subprocesses when the top process dies, but a subprocess stuck in an infinite
 * loop might survive that – on macOS at least.)
 *
 * On Windows, there are no signals, so the command is always killed hard.
 *
 * @param {import("@lydell/node-pty").IPty} terminal
 * @param {string} signal
 * @returns {void}
 */
const killGroup = (terminal, signal) => {
  if (IS_WINDOWS) {
    terminal.kill();
    return;
  }
  try {
    process.kill(-terminal.pid, signal);
  } catch {
    terminal.kill(signal);
  }
};

/**
 * @param {Array<Command>} commands
 * @param {(killMode: KillMode) => void} killAll
 * @returns {void}
 */
const setupSignalHandlers = (commands, killAll) => {
  // Clean up all commands if someone tries to kill run-pty.
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    let lastSignalTimestamp = 0;
    process.on(signal, () => {
      const now = Date.now();
      // When running via `npm run` or `npx`, one often gets two SIGINTs in a row
      // when pressing ctrl+c, since npm forwards signals to its child.
      // https://stackoverflow.com/a/60273973
      if (now - lastSignalTimestamp > 10) {
        // On Windows, `killGroup` can only kill hard, so use the kill all
        // sequence (ctrl+c) to give commands a chance to exit gracefully.
        killAll(
          IS_WINDOWS
            ? { tag: "KillAllSequence", restartAfterKill: false }
            : { tag: "Signal", signal, restartAfterKill: false },
        );
      }
      lastSignalTimestamp = now;
    });
  }

  // Don’t leave running processes behind in case of an unexpected error.
  for (const event of ["uncaughtException", "unhandledRejection"]) {
    process.on(event, (error) => {
      for (const command of commands) {
        if ("terminal" in command.status) {
          killGroup(command.status.terminal, "SIGKILL");
        }
      }
      console.error(error);
      process.exit(1);
    });
  }
};

/**
 * @returns {undefined}
 */
const run = () => {
  // Show up as “run-pty” rather than “node”, for example in iTerm2’s tab title.
  process.title = "run-pty";

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
  __internalRun: run,
  __forTests: {
    ALL_LABELS,
    appendHistory,
    ESCAPES_REQUEST,
    ESCAPES_RESPONSE,
    commandToPresentationName,
    drawDashboard,
    drawSummary,
    exitText,
    exitTextAndHistory,
    help,
    historyStart,
    historyStartRunning,
    parseArgs,
    isResponseTo,
    UNFINISHED_ESCAPE,
    runningIndicator,
    summarizeLabels,
    titleText,
    waitingText,
  },
};
