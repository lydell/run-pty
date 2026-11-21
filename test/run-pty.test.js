"use strict";

import * as childProcess from "child_process";
import * as path from "path";
import * as os from "os";
import { expect, test, describe } from "vitest";

import runPty from "../run-pty";
const {
  __forTests: {
    ALL_LABELS,
    appendHistory,
    ESCAPES_REQUEST,
    ESCAPES_RESPONSE,
    commandToPresentationName,
    convertWin32InputMode,
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
} = runPty;

/**
 * @param {{ pid: number }} init
 * @returns {import("@lydell/node-pty").IPty}
 */
function fakeTerminal({ pid }) {
  return {
    pid,
    // Unused in this case:
    cols: 0,
    rows: 0,
    process: "process",
    handleFlowControl: false,
    onData: () => notCalled("onData") || { dispose: () => undefined },
    onExit: () => notCalled("onExit") || { dispose: () => undefined },
    clear: () => notCalled("clear"),
    pause: () => notCalled("pause"),
    resume: () => notCalled("resume"),
    resize: () => notCalled("resize"),
    write: () => notCalled("write"),
    kill: () => notCalled("kill"),
  };
}

/**
 * @typedef {{
 *   command: Array<string>;
 *   status: import("../run-pty").Status;
 *   statusFromRules?: string;
 *   title?: string;
 * }} FakeCommand
 *
 * @param {FakeCommand} item
 * @param {number} index
 * @returns {import("../run-pty").CommandTypeForTest}
 */

function fakeCommand(item, index = 0) {
  const title =
    item.title === undefined
      ? commandToPresentationName(item.command)
      : item.title;
  return {
    label: ALL_LABELS[index],
    title,
    titlePossiblyWithGraphicRenditions: title,
    formattedCommandWithTitle: commandToPresentationName(item.command),
    status: item.status,
    // Unused in this case:
    file: "file",
    args: [],
    cwd: ".",
    killAllSequence: "\x03",
    history: "",
    historyAlternateScreen: "",
    addHistoryStart: false,
    isOnAlternateScreen: false,
    statusFromRules: item.statusFromRules,
    defaultStatus: undefined,
    statusRules: [],
    windowsConptyCursorMoveWorkaround: false,
    unfinishedEscapeBuffer: "",
    hasSetTitle: false,
    onData: () => notCalled("onData"),
    onRequest: () => notCalled("onRequest"),
    onSynchronizedOutputChange: () => notCalled("onSynchronizedOutputChange"),
    onExit: () => notCalled("onExit"),
    pushHistory: () => notCalled("pushHistory"),
    start: () => notCalled("start"),
    kill: () => notCalled("kill"),
    updateStatusFromRules: () => notCalled("updateStatusFromRules"),
  };
}

/**
 * @param {string} string
 * @returns {string}
 */
function replaceAnsi(string) {
  return string
    .replace(/\x1B\[0?m/g, "⧘")
    .replace(/\x1B\[\d+m/g, "⧙")
    .replace(/\x1B\[\d*[GJK]/g, "");
}

/**
 * @param {string} name
 * @returns {never}
 */
function notCalled(name) {
  throw new Error(`Expected ${name} not to be called!`);
}

// Make snapshots easier to read.
// Before: `"\\"string\\""`
// After: `"string"`
expect.addSnapshotSerializer({
  test: (value) => typeof value === "string",
  /** @type {(value: unknown) => string} */
  print: (value) =>
    String(value).replace(/^\n+|\n+$/, (match) => "␊\n".repeat(match.length)),
});

describe("help", () => {
  test("it works", () => {
    expect(replaceAnsi(help)).toMatchInlineSnapshot(`
      Run several commands concurrently.
      Show output for one command at a time.
      Kill all at once.

      Separate the commands with a character of choice:

          ⧙run-pty⧘ ⧙%⧘ npm start ⧙%⧘ make watch ⧙%⧘ some_command arg1 arg2 arg3

          ⧙run-pty⧘ ⧙@⧘ ./report_progress.bash --root / --unit % ⧙@⧘ ping localhost

      Alternatively, specify the commands in a JSON file:

          ⧙run-pty⧘ run-pty.json

      You can tell run-pty to exit once all commands have exited with status 0:

          ⧙run-pty⧘ --auto-exit ⧙%⧘ npm ci ⧙%⧘ dotnet restore ⧙&&⧘ node build.js

          --auto-exit=<number>   auto exit when done, with at most <number> parallel processes
          --auto-exit=auto       uses the number of logical CPU cores
          --auto-exit            defaults to auto

      Keyboard shortcuts:

          ⧙[⧘⧙ctrl+z⧘⧙]⧘ Dashboard
          ⧙[⧘⧙ctrl+c⧘⧙]⧘ Kill all or focused command
          Other keyboard shortcuts are shown as needed.

      Environment variables:

          ⧙RUN_PTY_MAX_HISTORY⧘
              Number of characters of output to remember.
              Higher → more command scrollback
              Lower  → faster switching between commands
              Default: 1000000

          ⧙NO_COLOR⧘
              Disable colored output.
    `);
  });
});

describe("dashboard", () => {
  /**
   * @param {Array<FakeCommand>} items
   * @param {{width?: number, height?: number, scrollTop?: number, attemptedKillAll?: boolean, autoExit?: import("../run-pty").AutoExit, selection?: import("../run-pty").Selection}} options
   * @returns {string}
   */
  function testDashboard(items, options = {}) {
    return replaceAnsi(testDashboardRaw(items, options).text);
  }

  /**
   * @param {Array<FakeCommand>} items
   * @param {{width?: number, height?: number, scrollTop?: number, attemptedKillAll?: boolean, autoExit?: import("../run-pty").AutoExit, selection?: import("../run-pty").Selection}} options
   */
  function testDashboardRaw(
    items,
    {
      width = 80,
      height = Infinity,
      scrollTop = 0,
      attemptedKillAll = false,
      autoExit = { tag: "NoAutoExit" },
      selection = { tag: "Invisible", index: 0 },
    } = {},
  ) {
    return drawDashboard({
      commands: items.map(fakeCommand),
      width,
      height,
      scrollTop,
      attemptedKillAll,
      autoExit,
      selection,
    });
  }

  test("empty", () => {
    expect(testDashboard([], { width: 0 })).toMatchInlineSnapshot(`
      ⧙[⧘⧙⧘⧙]⧘       focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙↑↓←→⧘⧙]⧘   move selection
    `);
  });

  test("one command", () => {
    expect(
      testDashboard([
        {
          command: ["npm", "start"],
          status: { tag: "Exit", exitCode: 0, wasKilled: false },
        },
      ]),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⚪⧘  ⧙exit 0⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙↑↓←→⧘⧙]⧘   move selection
      ⧙[⧘⧙enter⧘⧙]⧘  restart exited
    `);
  });

  test("auto exit", () => {
    expect(
      testDashboard(
        [
          {
            command: ["npm", "start"],
            status: { tag: "Running", terminal: fakeTerminal({ pid: 1 }) },
          },
        ],

        { autoExit: { tag: "AutoExit", maxParallel: 3 } },
      ),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
      ⧙[⧘⧙↑↓⧘⧙]⧘     move selection

      At most 3 commands run at a time.
      The session ends automatically once all commands are ⚪ ⧙exit 0⧘.
    `);
  });

  test("auto exit, max 1", () => {
    expect(
      testDashboard(
        [
          {
            command: ["npm", "start"],
            status: { tag: "Running", terminal: fakeTerminal({ pid: 1 }) },
          },
        ],

        { autoExit: { tag: "AutoExit", maxParallel: 1 } },
      ),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
      ⧙[⧘⧙↑↓⧘⧙]⧘     move selection

      At most 1 command runs at a time.
      The session ends automatically once all commands are ⚪ ⧙exit 0⧘.
    `);
  });

  test("auto exit, max 2", () => {
    expect(
      testDashboard(
        [
          {
            command: ["npm", "start"],
            status: { tag: "Running", terminal: fakeTerminal({ pid: 1 }) },
          },
        ],

        { autoExit: { tag: "AutoExit", maxParallel: 2 } },
      ),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
      ⧙[⧘⧙↑↓⧘⧙]⧘     move selection

      At most 2 commands run at a time.
      The session ends automatically once all commands are ⚪ ⧙exit 0⧘.
    `);
  });

  test("auto exit with restart failed", () => {
    expect(
      testDashboard(
        [
          {
            command: ["npm", "start"],
            status: { tag: "Running", terminal: fakeTerminal({ pid: 1 }) },
          },

          {
            command: ["npm", "run", "build"],
            status: { tag: "Exit", exitCode: 1, wasKilled: true },
          },
        ],

        { autoExit: { tag: "AutoExit", maxParallel: 3 } },
      ),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  npm start⧘
      ⧙[⧘⧙2⧘⧙]⧘  ⛔️⧘  ⧙exit 1⧘  npm run build⧘

      ⧙[⧘⧙1-2⧘⧙]⧘    focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
      ⧙[⧘⧙↑↓⧘⧙]⧘     move selection
      ⧙[⧘⧙enter⧘⧙]⧘  restart failed

      At most 3 commands run at a time.
      The session ends automatically once all commands are ⚪ ⧙exit 0⧘.
    `);
  });

  test("attempted kill all", () => {
    expect(
      testDashboard(
        [
          {
            command: ["npm", "start"],
            status: {
              tag: "Killing",
              terminal: fakeTerminal({ pid: 1 }),
              slow: false,
              lastKillPress: undefined,
              sentSignals: [],
              restartAfterKill: false,
            },
          },
        ],
        { attemptedKillAll: true },
      ),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⭕⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all ⧙(double-press to force) ⧘
      ⧙[⧘⧙↑↓←→⧘⧙]⧘   move selection
    `);
  });

  test("attempted to restart", () => {
    expect(
      testDashboard(
        [
          {
            command: ["npm", "start"],
            status: {
              tag: "Killing",
              terminal: fakeTerminal({ pid: 1 }),
              slow: false,
              lastKillPress: undefined,
              sentSignals: [],
              restartAfterKill: true,
            },
          },
        ],
        { attemptedKillAll: true },
      ),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🔄⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all ⧙(double-press to force) ⧘
      ⧙[⧘⧙↑↓←→⧘⧙]⧘   move selection
    `);
  });

  test("auto exit and attempted kill all", () => {
    expect(
      testDashboard(
        [
          {
            command: ["npm", "start"],
            status: {
              tag: "Killing",
              terminal: fakeTerminal({ pid: 1 }),
              slow: false,
              lastKillPress: undefined,
              sentSignals: [],
              restartAfterKill: false,
            },
          },
        ],

        {
          attemptedKillAll: true,
          autoExit: { tag: "AutoExit", maxParallel: 3 },
        },
      ),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⭕⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all ⧙(double-press to force) ⧘
      ⧙[⧘⧙↑↓⧘⧙]⧘     move selection

      At most 3 commands run at a time.
      The session ends automatically once all commands are ⚪ ⧙exit 0⧘.
    `);
  });

  test("auto exit and attempted kill all done", () => {
    expect(
      testDashboard(
        [
          {
            command: ["npm", "start"],
            status: { tag: "Exit", exitCode: 0, wasKilled: true },
          },
        ],

        {
          attemptedKillAll: true,
          autoExit: { tag: "AutoExit", maxParallel: 3 },
        },
      ),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⛔️⧘  ⧙exit 0⧘  npm start⧘␊

    `);
  });

  test("a variety of commands", () => {
    expect(
      testDashboard([
        {
          command: [
            "echo",
            "./Some_script2.js",
            "-v",
            "$end",
            "",
            "'quoted'th|ng'",
            "hello world",
          ],
          status: { tag: "Exit", exitCode: 0, wasKilled: false },
          statusFromRules: "!", // Should be ignored.
        },
        {
          command: ["npm", "run", "server"],
          status: { tag: "Exit", exitCode: 130, wasKilled: false },
          statusFromRules: "!", // Should be ignored.
        },
        {
          command: ["ping", "nope"],
          status: { tag: "Exit", exitCode: 68, wasKilled: false },
          statusFromRules: "!", // Should be ignored.
        },
        {
          command: ["ping", "localhost"],
          status: {
            tag: "Killing",
            terminal: fakeTerminal({ pid: 12345 }),
            slow: false,
            lastKillPress: undefined,
            sentSignals: [],
            restartAfterKill: false,
          },
          statusFromRules: "!", // Should be ignored.
        },
        {
          command: ["ping", "localhost"],
          status: {
            tag: "Killing",
            terminal: fakeTerminal({ pid: 12345 }),
            slow: false,
            lastKillPress: undefined,
            sentSignals: [],
            restartAfterKill: true,
          },
          statusFromRules: "!", // Should be ignored.
        },
        {
          command: ["yes"],
          status: {
            tag: "Running",
            terminal: fakeTerminal({ pid: 123456 }),
          },
        },
        {
          command: ["npm", "start"],
          status: {
            tag: "Running",
            terminal: fakeTerminal({ pid: 123456 }),
          },
          statusFromRules: "🚨",
          title:
            "very long title for some reason that needs to be cut off at some point",
        },
      ]),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⚪⧘  ⧙exit 0⧘    echo ./Some_script2.js -v '$end' '' \\'quoted\\''th|ng'\\' 'hel…⧘
      ⧙[⧘⧙2⧘⧙]⧘  ⚪⧘  ⧙exit 130⧘  npm run server⧘
      ⧙[⧘⧙3⧘⧙]⧘  🔴⧘  ⧙exit 68⧘   ping nope⧘
      ⧙[⧘⧙4⧘⧙]⧘  ⭕⧘  ping localhost⧘
      ⧙[⧘⧙5⧘⧙]⧘  🔄⧘  ping localhost⧘
      ⧙[⧘⧙6⧘⧙]⧘  🟢⧘  yes⧘
      ⧙[⧘⧙7⧘⧙]⧘  🚨⧘  very long title for some reason that needs to be cut off at some point⧘

      ⧙[⧘⧙1-7⧘⧙]⧘    focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all ⧙(double-press to force) ⧘
      ⧙[⧘⧙↑↓←→⧘⧙]⧘   move selection
      ⧙[⧘⧙enter⧘⧙]⧘  restart exited
    `);
  });

  test("62 commands", () => {
    expect(
      testDashboard(
        Array.from({ length: 62 }, (_, i) => ({
          command: ["echo", String(i)],
          status: {
            tag: "Running",
            terminal: fakeTerminal({ pid: 9980 + i }),
          },
        })),
      ),
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  echo 0⧘
      ⧙[⧘⧙2⧘⧙]⧘  🟢⧘  echo 1⧘
      ⧙[⧘⧙3⧘⧙]⧘  🟢⧘  echo 2⧘
      ⧙[⧘⧙4⧘⧙]⧘  🟢⧘  echo 3⧘
      ⧙[⧘⧙5⧘⧙]⧘  🟢⧘  echo 4⧘
      ⧙[⧘⧙6⧘⧙]⧘  🟢⧘  echo 5⧘
      ⧙[⧘⧙7⧘⧙]⧘  🟢⧘  echo 6⧘
      ⧙[⧘⧙8⧘⧙]⧘  🟢⧘  echo 7⧘
      ⧙[⧘⧙9⧘⧙]⧘  🟢⧘  echo 8⧘
      ⧙[⧘⧙a⧘⧙]⧘  🟢⧘  echo 9⧘
      ⧙[⧘⧙b⧘⧙]⧘  🟢⧘  echo 10⧘
      ⧙[⧘⧙c⧘⧙]⧘  🟢⧘  echo 11⧘
      ⧙[⧘⧙d⧘⧙]⧘  🟢⧘  echo 12⧘
      ⧙[⧘⧙e⧘⧙]⧘  🟢⧘  echo 13⧘
      ⧙[⧘⧙f⧘⧙]⧘  🟢⧘  echo 14⧘
      ⧙[⧘⧙g⧘⧙]⧘  🟢⧘  echo 15⧘
      ⧙[⧘⧙h⧘⧙]⧘  🟢⧘  echo 16⧘
      ⧙[⧘⧙i⧘⧙]⧘  🟢⧘  echo 17⧘
      ⧙[⧘⧙j⧘⧙]⧘  🟢⧘  echo 18⧘
      ⧙[⧘⧙k⧘⧙]⧘  🟢⧘  echo 19⧘
      ⧙[⧘⧙l⧘⧙]⧘  🟢⧘  echo 20⧘
      ⧙[⧘⧙m⧘⧙]⧘  🟢⧘  echo 21⧘
      ⧙[⧘⧙n⧘⧙]⧘  🟢⧘  echo 22⧘
      ⧙[⧘⧙o⧘⧙]⧘  🟢⧘  echo 23⧘
      ⧙[⧘⧙p⧘⧙]⧘  🟢⧘  echo 24⧘
      ⧙[⧘⧙q⧘⧙]⧘  🟢⧘  echo 25⧘
      ⧙[⧘⧙r⧘⧙]⧘  🟢⧘  echo 26⧘
      ⧙[⧘⧙s⧘⧙]⧘  🟢⧘  echo 27⧘
      ⧙[⧘⧙t⧘⧙]⧘  🟢⧘  echo 28⧘
      ⧙[⧘⧙u⧘⧙]⧘  🟢⧘  echo 29⧘
      ⧙[⧘⧙v⧘⧙]⧘  🟢⧘  echo 30⧘
      ⧙[⧘⧙w⧘⧙]⧘  🟢⧘  echo 31⧘
      ⧙[⧘⧙x⧘⧙]⧘  🟢⧘  echo 32⧘
      ⧙[⧘⧙y⧘⧙]⧘  🟢⧘  echo 33⧘
      ⧙[⧘⧙z⧘⧙]⧘  🟢⧘  echo 34⧘
      ⧙[⧘⧙A⧘⧙]⧘  🟢⧘  echo 35⧘
      ⧙[⧘⧙B⧘⧙]⧘  🟢⧘  echo 36⧘
      ⧙[⧘⧙C⧘⧙]⧘  🟢⧘  echo 37⧘
      ⧙[⧘⧙D⧘⧙]⧘  🟢⧘  echo 38⧘
      ⧙[⧘⧙E⧘⧙]⧘  🟢⧘  echo 39⧘
      ⧙[⧘⧙F⧘⧙]⧘  🟢⧘  echo 40⧘
      ⧙[⧘⧙G⧘⧙]⧘  🟢⧘  echo 41⧘
      ⧙[⧘⧙H⧘⧙]⧘  🟢⧘  echo 42⧘
      ⧙[⧘⧙I⧘⧙]⧘  🟢⧘  echo 43⧘
      ⧙[⧘⧙J⧘⧙]⧘  🟢⧘  echo 44⧘
      ⧙[⧘⧙K⧘⧙]⧘  🟢⧘  echo 45⧘
      ⧙[⧘⧙L⧘⧙]⧘  🟢⧘  echo 46⧘
      ⧙[⧘⧙M⧘⧙]⧘  🟢⧘  echo 47⧘
      ⧙[⧘⧙N⧘⧙]⧘  🟢⧘  echo 48⧘
      ⧙[⧘⧙O⧘⧙]⧘  🟢⧘  echo 49⧘
      ⧙[⧘⧙P⧘⧙]⧘  🟢⧘  echo 50⧘
      ⧙[⧘⧙Q⧘⧙]⧘  🟢⧘  echo 51⧘
      ⧙[⧘⧙R⧘⧙]⧘  🟢⧘  echo 52⧘
      ⧙[⧘⧙S⧘⧙]⧘  🟢⧘  echo 53⧘
      ⧙[⧘⧙T⧘⧙]⧘  🟢⧘  echo 54⧘
      ⧙[⧘⧙U⧘⧙]⧘  🟢⧘  echo 55⧘
      ⧙[⧘⧙V⧘⧙]⧘  🟢⧘  echo 56⧘
      ⧙[⧘⧙W⧘⧙]⧘  🟢⧘  echo 57⧘
      ⧙[⧘⧙X⧘⧙]⧘  🟢⧘  echo 58⧘
      ⧙[⧘⧙Y⧘⧙]⧘  🟢⧘  echo 59⧘
      ⧙[⧘⧙Z⧘⧙]⧘  🟢⧘  echo 60⧘
      ⧙[⧘⧙ ⧘⧙]⧘  🟢⧘  echo 61⧘

      ⧙[⧘⧙1-9/a-z/A-Z⧘⧙]⧘ focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
      ⧙[⧘⧙↑↓←→⧘⧙]⧘   move selection
    `);
  });

  describe("more commands than fit", () => {
    /** @type {Array<FakeCommand>} */
    const items = Array.from({ length: 20 }, (_, i) => ({
      command: ["echo", String(i)],
      status:
        i % 7 === 3
          ? { tag: "Exit", exitCode: 1, wasKilled: false }
          : { tag: "Running", terminal: fakeTerminal({ pid: 9980 + i }) },
    }));

    test("top", () => {
      expect(testDashboard(items, { height: 10 })).toMatchInlineSnapshot(`
        ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  echo 0⧘
        ⧙[⧘⧙2⧘⧙]⧘  🟢⧘  echo 1⧘
        ⧙[⧘⧙3⧘⧙]⧘  🟢⧘  echo 2⧘
        ⧙ ↓ ⧘  🔴 3  🟢 14⧘

        ⧙[⧘⧙1-9/a-k⧘⧙]⧘ focus command ⧙(or click)⧘
        ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
        ⧙[⧘⧙↑↓←→⧘⧙]⧘   move selection
        ⧙[⧘⧙enter⧘⧙]⧘  restart exited
      `);
    });

    test("scrolled to the middle", () => {
      expect(testDashboard(items, { height: 10, scrollTop: 8 }))
        .toMatchInlineSnapshot(`
          ⧙ ↑ ⧘  🟢 7  🔴 1⧘
          ⧙[⧘⧙9⧘⧙]⧘  🟢⧘  echo 8⧘
          ⧙[⧘⧙a⧘⧙]⧘  🟢⧘  echo 9⧘
          ⧙ ↓ ⧘  🔴 2  🟢 8⧘

          ⧙[⧘⧙1-9/a-k⧘⧙]⧘ focus command ⧙(or click)⧘
          ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
          ⧙[⧘⧙↑↓←→⧘⧙]⧘   move selection
          ⧙[⧘⧙enter⧘⧙]⧘  restart exited
        `);
    });

    test("scrolled past the end is clamped", () => {
      const dashboard = testDashboardRaw(items, { height: 10, scrollTop: 100 });
      expect(dashboard.scrollTop).toBe(17);
      expect(dashboard.visibleCommands).toEqual({
        start: 17,
        end: 20,
        moreAbove: true,
        moreBelow: false,
      });
      expect(replaceAnsi(dashboard.text)).toMatchInlineSnapshot(`
        ⧙ ↑ ⧘  🟢 15  🔴 2⧘
        ⧙[⧘⧙i⧘⧙]⧘  🔴⧘  ⧙exit 1⧘  echo 17⧘
        ⧙[⧘⧙j⧘⧙]⧘  🟢⧘  echo 18⧘
        ⧙[⧘⧙k⧘⧙]⧘  🟢⧘  echo 19⧘

        ⧙[⧘⧙1-9/a-k⧘⧙]⧘ focus command ⧙(or click)⧘
        ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
        ⧙[⧘⧙↑↓←→⧘⧙]⧘   move selection
        ⧙[⧘⧙enter⧘⧙]⧘  restart exited
      `);
    });

    test("no “1 more” line at the top", () => {
      const dashboard = testDashboardRaw(items, { height: 10, scrollTop: 1 });
      expect(dashboard.scrollTop).toBe(0);
      expect(dashboard.visibleCommands).toEqual({
        start: 0,
        end: 3,
        moreAbove: false,
        moreBelow: true,
      });
    });

    test("selection below scrolls just enough", () => {
      const dashboard = testDashboardRaw(items, {
        height: 11,
        selection: { tag: "Keyboard", index: 10 },
      });
      expect(dashboard.visibleCommands).toEqual({
        start: 8,
        end: 11,
        moreAbove: true,
        moreBelow: true,
      });
      expect(replaceAnsi(dashboard.text)).toMatchInlineSnapshot(`
        ⧙ ↑ ⧘  🟢 7  🔴 1⧘
        ⧙[⧘⧙9⧘⧙]⧘  🟢⧘  echo 8⧘
        ⧙[⧘⧙a⧘⧙]⧘  🟢⧘  echo 9⧘
        ⧙[⧘⧙b⧘⧙]⧘  🔴⧘  ⧙⧙exit 1⧘⧙  echo 10⧘⧘
        ⧙ ↓ ⧘  🟢 8  🔴 1⧘

        ⧙[⧘⧙1-9/a-k⧘⧙]⧘ focus command ⧙(or click)⧘
        ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
        ⧙[⧘⧙↑↓←→⧘⧙]⧘   move selection
        ⧙[⧘⧙enter⧘⧙]⧘  focus selected
        ⧙[⧘⧙escape⧘⧙]⧘ unselect
      `);
    });

    test("selection above scrolls just enough", () => {
      const dashboard = testDashboardRaw(items, {
        height: 11,
        scrollTop: 8,
        selection: { tag: "Keyboard", index: 5 },
      });
      expect(dashboard.visibleCommands).toEqual({
        start: 5,
        end: 8,
        moreAbove: true,
        moreBelow: true,
      });
    });

    test("visible selection does not scroll", () => {
      const dashboard = testDashboardRaw(items, {
        height: 11,
        scrollTop: 8,
        selection: { tag: "Keyboard", index: 9 },
      });
      expect(dashboard.scrollTop).toBe(8);
    });

    test("selection by indicator scrolls to the first match", () => {
      const dashboard = testDashboardRaw(items, {
        height: 10,
        scrollTop: 15,
        selection: { tag: "ByIndicator", indicator: "🔴", keyboardIndex: 0 },
      });
      expect(dashboard.visibleCommands.start).toBeLessThanOrEqual(3);
      expect(dashboard.visibleCommands.end).toBeGreaterThan(3);
    });

    test("selection by indicator does not scroll if a match is visible", () => {
      const dashboard = testDashboardRaw(items, {
        height: 10,
        scrollTop: 8,
        selection: { tag: "ByIndicator", indicator: "🟢", keyboardIndex: 0 },
      });
      expect(dashboard.scrollTop).toBe(8);
    });

    test("selection by indicator is highlighted in the “more” lines", () => {
      expect(
        testDashboard(items, {
          height: 10,
          scrollTop: 8,
          selection: { tag: "ByIndicator", indicator: "🟢", keyboardIndex: 0 },
        })
          .split("\n")
          .slice(0, 4)
          .join("\n"),
      ).toMatchInlineSnapshot(`
        ⧙ ↑ ⧘ ⧙ 🟢  ⧘⧙ 7 ⧘ 🔴 1⧘
        ⧙[⧘⧙9⧘⧙]⧘ ⧙ 🟢  ⧘⧘⧙ ⧘ echo 8⧘
        ⧙[⧘⧙a⧘⧙]⧘ ⧙ 🟢  ⧘⧘⧙ ⧘ echo 9⧘
        ⧙ ↓ ⧘  🔴 2 ⧙ 🟢  ⧘⧙ 8 ⧘⧘
      `);
    });

    test("selecting does not move the commands", () => {
      const withoutSelection = testDashboardRaw(items, {
        height: 10,
        scrollTop: 8,
      });
      const withSelection = testDashboardRaw(items, {
        height: 10,
        scrollTop: 8,
        selection: { tag: "Keyboard", index: 8 },
      });
      expect(withSelection.visibleCommands).toEqual(
        withoutSelection.visibleCommands,
      );
    });

    test.each([1, 2])(
      "selection is visible in a terminal with %i rows",
      (height) => {
        for (const index of [0, 1, 2, 10, 18, 19]) {
          const { visibleCommands, text } = testDashboardRaw(items, {
            height,
            selection: { tag: "Keyboard", index },
          });
          expect(index).toBeGreaterThanOrEqual(visibleCommands.start);
          expect(index).toBeLessThan(visibleCommands.end);
          expect(text.split("\n")).toHaveLength(height);
        }
      },
    );

    test("help is hidden when there is too little room", () => {
      expect(testDashboard(items, { height: 5 })).toMatchInlineSnapshot(`
        ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  echo 0⧘
        ⧙[⧘⧙2⧘⧙]⧘  🟢⧘  echo 1⧘
        ⧙[⧘⧙3⧘⧙]⧘  🟢⧘  echo 2⧘
        ⧙[⧘⧙4⧘⧙]⧘  🔴⧘  ⧙exit 1⧘  echo 3⧘
        ⧙ ↓ ⧘  🟢 14  🔴 2⧘
      `);
    });
  });
});

describe("title", () => {
  test("counts per indicator", () => {
    expect(
      titleText(
        /** @type {Array<FakeCommand>} */ ([
          {
            command: ["a"],
            status: { tag: "Running", terminal: fakeTerminal({ pid: 1 }) },
          },
          {
            command: ["b"],
            status: { tag: "Exit", exitCode: 1, wasKilled: false },
          },
          {
            command: ["c"],
            status: { tag: "Running", terminal: fakeTerminal({ pid: 2 }) },
          },
          {
            command: ["d"],
            status: { tag: "Running", terminal: fakeTerminal({ pid: 3 }) },
            statusFromRules: "\x1B[91m🚨\x1B[m",
          },
          { command: ["e"], status: { tag: "Waiting" } },
        ]).map(fakeCommand),
        "my-app",
      ),
    ).toMatchInlineSnapshot(`my-app 🟢2 🔴1 🚨1 🥱1`);
  });

  test("no commands", () => {
    expect(titleText([], "my-app")).toBe("my-app");
  });

  test("control characters are removed", () => {
    expect(
      titleText(
        [
          fakeCommand({
            command: ["a"],
            status: { tag: "Running", terminal: fakeTerminal({ pid: 1 }) },
            statusFromRules: "\x1B[91m🚨\x07\x1B]0;evil\x07\x9B",
          }),
        ],
        "my\x07\x1B]0;evil\x07-app\x9D",
      ),
    ).toBe("my]0;evil-app 🚨]0;evil1");
  });

  test("directory with only control characters", () => {
    expect(
      titleText(
        [fakeCommand({ command: ["a"], status: { tag: "Waiting" } })],
        "\x07\x1B",
      ),
    ).toBe("🥱1");
  });

  test("root directory", () => {
    expect(
      titleText(
        [fakeCommand({ command: ["a"], status: { tag: "Waiting" } })],
        "",
      ),
    ).toBe("🥱1");
  });
});

describe("summary", () => {
  /**
   * @param {Array<FakeCommand>} items
   * @returns {string}
   */
  function testSummary(items) {
    return replaceAnsi(drawSummary(items.map(fakeCommand)).trim());
  }

  test("empty", () => {
    expect(testSummary([])).toMatchInlineSnapshot(`⧙Summary – success:⧘`);
  });

  test("one command", () => {
    expect(
      testSummary([
        {
          command: ["npm", "start"],
          status: { tag: "Exit", exitCode: 0, wasKilled: false },
        },
      ]),
    ).toMatchInlineSnapshot(`
      ⧙Summary – success:⧘
      ⚪ ⧙exit 0⧘ npm start⧘
    `);
  });

  test("one success, one failure", () => {
    expect(
      testSummary([
        {
          command: ["npm", "start"],
          status: { tag: "Exit", exitCode: 0, wasKilled: false },
        },
        {
          command: ["npm", "test"],
          status: { tag: "Exit", exitCode: 1, wasKilled: false },
        },
      ]),
    ).toMatchInlineSnapshot(`
      ⧙Summary – failure:⧘
      ⚪ ⧙exit 0⧘ npm start⧘
      🔴 ⧙exit 1⧘ npm test⧘
    `);
  });

  test("one success, one aborted", () => {
    expect(
      testSummary([
        {
          command: ["npm", "start"],
          status: { tag: "Exit", exitCode: 0, wasKilled: false },
        },
        {
          command: ["npm", "test"],
          status: { tag: "Exit", exitCode: 0, wasKilled: true },
        },
      ]),
    ).toMatchInlineSnapshot(`
      ⧙Summary – aborted:⧘
      ⚪ ⧙exit 0⧘ npm start⧘
      ⛔️ ⧙exit 0⧘ npm test⧘
    `);
  });

  test("one failure, one aborted, one success", () => {
    expect(
      testSummary([
        {
          command: ["npm", "start"],
          status: { tag: "Exit", exitCode: 126, wasKilled: false },
        },
        {
          command: ["ping", "localhost"],
          status: { tag: "Exit", exitCode: 2, wasKilled: true },
        },
        {
          command: ["npm", "test"],
          status: { tag: "Exit", exitCode: 0, wasKilled: false },
        },
      ]),
    ).toMatchInlineSnapshot(`
      ⧙Summary – failure:⧘
      🔴 ⧙exit 126⧘ npm start⧘
      ⛔️ ⧙exit 2⧘ ping localhost⧘
      ⚪ ⧙exit 0⧘ npm test⧘
    `);
  });
});

describe("focused command", () => {
  /**
   * @param {(command: import("../run-pty").CommandText) => string} f
   * @param {string} formattedCommandWithTitle
   * @param {string} cwd
   * @returns {string}
   */
  function render(f, formattedCommandWithTitle, cwd) {
    return replaceAnsi(
      f({
        formattedCommandWithTitle,
        title: "Expected `title` not to be used",
        titlePossiblyWithGraphicRenditions:
          "Expected `titlePossiblyWithGraphicRenditions` not to be used",
        cwd,
        history: "",
      }),
    );
  }

  test("just a command", () => {
    expect(
      render(
        (command) => historyStart(runningIndicator, command),
        "npm start",
        "./",
      ),
    ).toMatchInlineSnapshot(`
      🟢 npm start⧘␊

    `);
  });

  test("title with command and changed cwd", () => {
    expect(
      render(
        (command) => historyStart(runningIndicator, command),
        "frontend: npm start",
        "web/frontend",
      ),
    ).toMatchInlineSnapshot(`
      🟢 frontend: npm start⧘
      📂 ⧙web/frontend⧘␊

    `);
  });

  test("running header with shortcuts", () => {
    expect(render(historyStartRunning, "frontend: npm start", "web/frontend"))
      .toMatchInlineSnapshot(`
        🟢 frontend: npm start⧘
        📂 ⧙web/frontend⧘
        ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill ⧙(then double-press to force)⧘
        ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard␊
        ␊
      `);
  });

  test("running header with shortcuts, without cwd", () => {
    expect(render(historyStartRunning, "npm start", "./x/.."))
      .toMatchInlineSnapshot(`
        🟢 npm start⧘
        ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill ⧙(then double-press to force)⧘
        ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard␊
        ␊
      `);
  });

  test("exit 0 with cwd", () => {
    expect(
      render(
        (command) =>
          exitText(
            [],
            command,
            { tag: "Exit", exitCode: 0, wasKilled: false },
            { tag: "NoAutoExit" },
          ),
        "frontend: npm start",
        "web/frontend",
      ),
    ).toMatchInlineSnapshot(`
      ⚪ frontend: npm start⧘
      📂 ⧙web/frontend⧘
      exit 0

      ⧙[⧘⧙enter⧘⧙]⧘  restart
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("exit 0 without cwd", () => {
    expect(
      render(
        (command) =>
          exitText(
            [],
            command,
            { tag: "Exit", exitCode: 0, wasKilled: false },
            { tag: "NoAutoExit" },
          ),
        "frontend: npm start",
        ".",
      ),
    ).toMatchInlineSnapshot(`
      ⚪ frontend: npm start⧘
      exit 0

      ⧙[⧘⧙enter⧘⧙]⧘  restart
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("exit 0 with auto exit (cannot be restarted)", () => {
    expect(
      render(
        (command) =>
          exitText(
            [],
            command,
            { tag: "Exit", exitCode: 0, wasKilled: false },
            {
              tag: "AutoExit",
              maxParallel: 3,
            },
          ),
        "frontend: npm start",
        ".",
      ),
    ).toMatchInlineSnapshot(`
      ⚪ frontend: npm start⧘
      exit 0

      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("exit 0 via killed with auto exit (CAN be restarted)", () => {
    expect(
      render(
        (command) =>
          exitText(
            [],
            command,
            { tag: "Exit", exitCode: 0, wasKilled: true },
            {
              tag: "AutoExit",
              maxParallel: 3,
            },
          ),

        "frontend: npm start",
        ".",
      ),
    ).toMatchInlineSnapshot(`
      ⛔️ frontend: npm start⧘
      exit 0

      ⧙[⧘⧙enter⧘⧙]⧘  restart
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("exit 1 with auto exit (can be restarted)", () => {
    expect(
      render(
        (command) =>
          exitText(
            [],
            command,
            { tag: "Exit", exitCode: 1, wasKilled: false },
            { tag: "NoAutoExit" },
          ),
        "frontend: npm start",
        ".",
      ),
    ).toMatchInlineSnapshot(`
      🔴 frontend: npm start⧘
      exit 1

      ⧙[⧘⧙enter⧘⧙]⧘  restart
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("waiting text", () => {
    expect(render(() => waitingText([]), "frontend: npm start", "."))
      .toMatchInlineSnapshot(`
      Waiting for other commands to finish before starting.

      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });
});

describe("exit text and history", () => {
  /** @type {import("../run-pty").CommandText} */
  const command = {
    cwd: ".",
    formattedCommandWithTitle:
      "Expected `formattedCommandWithTitle` not to be used.",
    title: "Expected `title` not to be used.",
    titlePossiblyWithGraphicRenditions:
      "Expected `titlePossiblyWithGraphicRenditions` not to be used.",
    history: "",
  };

  test("one command, no history", () => {
    expect(
      replaceAnsi(
        exitTextAndHistory({
          command: {
            ...command,
            titlePossiblyWithGraphicRenditions: "npm test",
          },
          exitCode: 0,
          numExited: 1,
          numTotal: 1,
        }),
      ),
    ).toMatchInlineSnapshot(`
      ⚪ npm test⧘
      ⧙exit 0⧘ ⧙(1/1 exited)⧘␊
      ␊

    `);
  });

  test("many commands, history", () => {
    expect(
      replaceAnsi(
        exitTextAndHistory({
          command: {
            ...command,
            titlePossiblyWithGraphicRenditions: "npm test",
            history: ["First line", "Second line", ""].join("\n"),
          },
          exitCode: 1,
          numExited: 2,
          numTotal: 11,
        }),
      ),
    ).toMatchInlineSnapshot(`
      🔴 npm test⧘
      First line
      Second line
      ⧙exit 1⧘ ⧙(2/11 exited)⧘␊
      ␊

    `);
  });

  test("cwd, no newline at end of history", () => {
    expect(
      replaceAnsi(
        exitTextAndHistory({
          command: {
            ...command,
            cwd: "web/frontend",
            titlePossiblyWithGraphicRenditions: "npm test",
            history: ["First line", "Second line"].join("\n"),
          },

          exitCode: 2,
          numExited: 11,
          numTotal: 11,
        }),
      ),
    ).toMatchInlineSnapshot(`
      🔴 npm test⧘
      📂 ⧙web/frontend⧘
      First line
      Second line
      ⧙exit 2⧘ ⧙(11/11 exited)⧘␊
      ␊

    `);
  });
});

describe("summarize labels", () => {
  /**
   * @param {number} num
   * @returns {string}
   */
  function testLabels(num) {
    return summarizeLabels(ALL_LABELS.split("").slice(0, num));
  }

  test("it works", () => {
    expect(testLabels(0)).toBe("");
    expect(testLabels(1)).toBe("1");
    expect(testLabels(2)).toBe("1-2");
    expect(testLabels(8)).toBe("1-8");
    expect(testLabels(9)).toBe("1-9");
    expect(testLabels(10)).toBe("1-9/a");
    expect(testLabels(11)).toBe("1-9/a-b");
    expect(testLabels(12)).toBe("1-9/a-c");
    expect(testLabels(34)).toBe("1-9/a-y");
    expect(testLabels(35)).toBe("1-9/a-z");
    expect(testLabels(36)).toBe("1-9/a-z/A");
    expect(testLabels(37)).toBe("1-9/a-z/A-B");
    expect(testLabels(38)).toBe("1-9/a-z/A-C");
    expect(testLabels(60)).toBe("1-9/a-z/A-Y");
    expect(testLabels(61)).toBe("1-9/a-z/A-Z");
    expect(testLabels(62)).toBe("1-9/a-z/A-Z");
  });
});

describe("unfinished escape", () => {
  /**
   * @param {string} string
   * @returns {string | undefined}
   */
  function unfinished(string) {
    return UNFINISHED_ESCAPE.exec(string)?.[0];
  }

  test("unfinished", () => {
    expect(unfinished("a\x1B")).toBe("\x1B");
    expect(unfinished("a\x1B[")).toBe("\x1B[");
    expect(unfinished("a\x1B[38;5")).toBe("\x1B[38;5");
    expect(unfinished("a\x1B(")).toBe("\x1B(");
    expect(unfinished("a\x1B]0;title")).toBe("\x1B]0;title");
    expect(unfinished("a\x1B]8;;https://example.com\x1B")).toBe(
      "\x1B]8;;https://example.com\x1B",
    );
    expect(unfinished("a\x1BP+q544e")).toBe("\x1BP+q544e");
    expect(unfinished("a\x1B_payload")).toBe("\x1B_payload");
  });

  test("finished", () => {
    expect(unfinished("a\x1B[38;5;2m")).toBeUndefined();
    expect(unfinished("a\x1B(B")).toBeUndefined();
    expect(unfinished("a\x1B7")).toBeUndefined();
    expect(unfinished("a\x1B]0;title\x07")).toBeUndefined();
    expect(unfinished("a\x1B]0;title\x1B\\")).toBeUndefined();
    expect(unfinished("a\x1BP+q544e\x1B\\b")).toBeUndefined();
  });

  test("only the last unfinished escape", () => {
    expect(unfinished("\x1B]0;title\x07a\x1B")).toBe("\x1B");
  });
});

describe("win32 input mode", () => {
  test("all records of a key press in one chunk", () => {
    // Recorded over SSH: ctrl down, z down, z up, ctrl up.
    expect(
      convertWin32InputMode(
        "\x1B[17;29;0;1;8;1_\x1B[90;44;26;1;8;1_\x1B[90;44;26;0;8;1_\x1B[17;29;0;0;0;1_",
      ),
    ).toBe("\x1A");
    // ctrl+c, without separate ctrl records.
    expect(convertWin32InputMode("\x1B[67;0;3;1;8;1_\x1B[67;0;3;0;8;1_")).toBe(
      "\x03",
    );
  });

  test("arrow keys", () => {
    expect(
      convertWin32InputMode("\x1B[40;80;0;1;0;1_\x1B[40;80;0;0;0;1_"),
    ).toBe("\x1B[B");
  });

  test("unknown keys without char are kept", () => {
    // F1 keydown.
    expect(convertWin32InputMode("\x1B[112;59;0;1;0;1_")).toBe(
      "\x1B[112;59;0;1;0;1_",
    );
  });

  test("plain input is untouched", () => {
    expect(convertWin32InputMode("1")).toBe("1");
    expect(convertWin32InputMode("\x1B[B")).toBe("\x1B[B");
  });
});

describe("append history", () => {
  const CLEAR = "\x1B[2J\x1B[3J\x1B[H";

  test("appends", () => {
    expect(appendHistory("a\n", "b\n", 100)).toBe("a\nb\n");
  });

  test("keeps only what comes after the last clear", () => {
    expect(appendHistory("a\n", `b\n${CLEAR}c\n${CLEAR}d\n`, 100)).toBe("d\n");
  });

  test("clear split between parts", () => {
    for (let i = 1; i < CLEAR.length; i++) {
      const history = appendHistory("a\n", `b\n${CLEAR.slice(0, i)}`, 100);
      expect(appendHistory(history, `${CLEAR.slice(i)}c\n`, 100)).toBe("c\n");
    }
  });

  test("clear at the very end", () => {
    expect(appendHistory("a\n", `b\n${CLEAR}`, 100)).toBe("");
  });

  test("trimming does not start in the middle of an escape", () => {
    const history = "\x1B[38;5;2mgreen\x1B[0m\nnext line\n";
    // Cut in the middle of the color escape.
    expect(appendHistory("", history, history.length - 3)).toBe(
      "\x1B[0m\nnext line\n",
    );
  });

  test("trimming does not start in the middle of a line", () => {
    expect(appendHistory("first line\n", "second line\n", 15)).toBe(
      "\nsecond line\n",
    );
  });

  test("max history 0", () => {
    expect(appendHistory("a", "b", 0)).toBe("");
  });
});

describe("requests and responses", () => {
  /**
   * @param {RegExp} regex
   * @param {string} string
   * @returns {Array<string>}
   */
  function split(regex, string) {
    return string.split(regex).filter((_, index) => index % 2 === 1);
  }

  test("requests", () => {
    expect(
      split(
        ESCAPES_REQUEST,
        "a\x1B[6nb\x1B[?6nc\x1B[14t\x1B[14;2t\x1B[18t\x1B[21t\x1B]11;?\x07\x1B]4;5;?\x1B\\",
      ),
    ).toEqual([
      "\x1B[6n",
      "\x1B[?6n",
      "\x1B[14t",
      "\x1B[14;2t",
      "\x1B[18t",
      "\x1B[21t",
      "\x1B]11;?\x07",
      "\x1B]4;5;?\x1B\\",
    ]);
  });

  test("window operations without reply are not requests", () => {
    expect(
      split(
        ESCAPES_REQUEST,
        "\x1B[22;2t\x1B[23;2t\x1B[22;0t\x1B[8;24;80t\x1B[1t\x1B[2t\x1B[t",
      ),
    ).toEqual([]);
  });

  test("responses", () => {
    expect(
      split(
        ESCAPES_RESPONSE,
        "\x1B[12;1R\x1B[1t\x1B[4;600;800t\x1B]Llabel\x1B\\\x1B]ltitle\x07\x1B]11;rgb:0000/0000/0000\x07",
      ),
    ).toEqual([
      "\x1B[12;1R",
      "\x1B[1t",
      "\x1B[4;600;800t",
      "\x1B]Llabel\x1B\\",
      "\x1B]ltitle\x07",
      "\x1B]11;rgb:0000/0000/0000\x07",
    ]);
  });

  test("responses match their requests", () => {
    /** @type {Array<[string, string]>} */
    const pairs = [
      ["\x1B[6n", "\x1B[12;1R"],
      ["\x1B[?6n", "\x1B[?12;1;1R"],
      ["\x1B[11t", "\x1B[1t"],
      ["\x1B[14t", "\x1B[4;600;800t"],
      ["\x1B[20t", "\x1B]Llabel\x1B\\"],
      ["\x1B[21t", "\x1B]ltitle\x07"],
      ["\x1B]10;?\x07", "\x1B]10;rgb:ffff/ffff/ffff\x07"],
      ["\x1B]11;?\x1B\\", "\x1B]11;rgb:0000/0000/0000\x1B\\"],
      ["\x1B]4;5;?\x07", "\x1B]4;5;rgb:cdcd/0000/cdcd\x07"],
    ];
    for (const [request, response] of pairs) {
      expect(isResponseTo(response, request)).toBe(true);
    }
  });

  test("responses don’t match other requests", () => {
    expect(isResponseTo("\x1B[12;1R", "\x1B[14t")).toBe(false);
    expect(
      isResponseTo("\x1B]11;rgb:0000/0000/0000\x07", "\x1B]10;?\x07"),
    ).toBe(false);
    expect(
      isResponseTo("\x1B]4;5;rgb:cdcd/0000/cdcd\x07", "\x1B]4;6;?\x07"),
    ).toBe(false);
    expect(isResponseTo("\x1B[4;600;800t", "\x1B]11;?\x07")).toBe(false);
  });
});

describe("parse args", () => {
  test("help", () => {
    expect(parseArgs([])).toStrictEqual({ tag: "Help" });
    expect(parseArgs(["-h"])).toStrictEqual({ tag: "Help" });
    expect(parseArgs(["--help"])).toStrictEqual({ tag: "Help" });
    expect(parseArgs(["--auto-exit", "--help"])).toStrictEqual({ tag: "Help" });
  });

  test("no commands", () => {
    expect(parseArgs(["%"])).toMatchInlineSnapshot(`
      {
        message: The first argument is either the delimiter to use between commands,
      or the path to a JSON file that describes the commands.
      If you meant to use a file, make sure it exists.
      Otherwise, choose a delimiter like % and provide at least one command.
      ENOENT: no such file or directory, open '%',
        tag: Error,
      }
    `);
    expect(parseArgs(["%", "%", "%"])).toStrictEqual({ tag: "NoCommands" });
  });

  test("unknown flag", () => {
    expect(parseArgs(["--unknown"])).toMatchInlineSnapshot(`
      {
        message: Bad flag: --unknown
      Only these forms are accepted:
          --auto-exit=<number>   auto exit when done, with at most <number> parallel processes
          --auto-exit=auto       uses the number of logical CPU cores
          --auto-exit            defaults to auto,
        tag: Error,
      }
    `);
  });

  test("bad auto exit value", () => {
    expect(parseArgs(["--auto-exit=nope"])).toMatchInlineSnapshot(`
      {
        message: Bad flag: --auto-exit=nope
      Only these forms are accepted:
          --auto-exit=<number>   auto exit when done, with at most <number> parallel processes
          --auto-exit=auto       uses the number of logical CPU cores
          --auto-exit            defaults to auto,
        tag: Error,
      }
    `);
  });

  test("commands", () => {
    /**
     * @param {Array<Array<string>>} commands
     * @param {{ autoExit?: import("../run-pty").AutoExit }} options
     * @returns {import("../run-pty").ParseResult}
     */
    function parsedCommands(
      commands,
      { autoExit = { tag: "NoAutoExit" } } = {},
    ) {
      return {
        tag: "Parsed",
        commands: commands.map((command) => ({
          command,
          cwd: ".",
          defaultStatus: undefined,
          status: [],
          title: commandToPresentationName(command),
          killAllSequence: "\x03",
        })),
        autoExit,
      };
    }

    expect(parseArgs(["%", "npm", "start"])).toStrictEqual(
      parsedCommands([["npm", "start"]]),
    );

    expect(
      parseArgs([
        "%",
        "npm",
        "start",
        "%",
        "webpack-dev-server",
        "--entry",
        "/entry/file",
      ]),
    ).toStrictEqual(
      parsedCommands([
        ["npm", "start"],
        ["webpack-dev-server", "--entry", "/entry/file"],
      ]),
    );

    expect(
      parseArgs([
        "@",
        "./report_progress.bash",
        "--root",
        "/",
        "--unit",
        "%",
        "@",
        "ping",
        "localhost",
      ]),
    ).toStrictEqual(
      parsedCommands([
        ["./report_progress.bash", "--root", "/", "--unit", "%"],
        ["ping", "localhost"],
      ]),
    );

    expect(parseArgs(["+", "one", "+", "+", "+two", "+"])).toStrictEqual(
      parsedCommands([["one"], ["+two"]]),
    );

    expect(parseArgs(["-", "one", "-", "-two", "-"])).toStrictEqual(
      parsedCommands([["one"], ["-two"]]),
    );

    expect(parseArgs(["--", "one", "--", "--two", "--"])).toStrictEqual(
      parsedCommands([["one"], ["--two"]]),
    );

    expect(parseArgs(["---", "one", "---", "---two", "---"])).toStrictEqual(
      parsedCommands([["one"], ["---two"]]),
    );

    expect(
      parseArgs(["--auto-exit", "%", "one", "%", "two", "--auto-exit"]),
    ).toStrictEqual(
      parsedCommands([["one"], ["two", "--auto-exit"]], {
        autoExit: {
          tag: "AutoExit",
          maxParallel: os.cpus().length,
        },
      }),
    );

    expect(
      parseArgs(["--auto-exit=234", "%", "one", "%", "two", "--auto-exit"]),
    ).toStrictEqual(
      parsedCommands([["one"], ["two", "--auto-exit"]], {
        autoExit: { tag: "AutoExit", maxParallel: 234 },
      }),
    );

    expect(
      parseArgs(["--auto-exit=auto", "%", "one", "%", "two", "--auto-exit"]),
    ).toStrictEqual(
      parsedCommands([["one"], ["two", "--auto-exit"]], {
        autoExit: {
          tag: "AutoExit",
          maxParallel: os.cpus().length,
        },
      }),
    );
  });
});

describe("parse json", () => {
  /**
   * @param {string} name
   * @returns {import("../run-pty").ParseResult}
   */
  function testJson(name) {
    return parseArgs([path.join(__dirname, "fixtures", name)]);
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  function testJsonError(name) {
    const result = testJson(name);
    if (result.tag === "Error") {
      return result.message;
    }
    expect(result).toBe({ tag: "Error" });
    throw new Error("Expected Error!");
  }

  test("empty file", () => {
    expect(testJsonError("empty.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      At root:
      SyntaxError: Unexpected end of JSON input
    `);
  });

  test("invalid json syntax", () => {
    expect(testJsonError("invalid-json-syntax.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      At root:
      SyntaxError: Unexpected token ']', ..."kend"] },
      ]
      " is not valid JSON
    `);
  });

  test("bad json type", () => {
    expect(testJsonError("bad-json-type.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      At root:
      Expected an array
      Got: null
    `);
  });

  test("empty list of commands", () => {
    expect(testJson("empty-array.json")).toStrictEqual({ tag: "NoCommands" });
  });

  test("empty command", () => {
    expect(testJsonError("empty-command.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      At root[0]["command"]:
      Expected a non-empty array
      Got: []
    `);
  });

  test("missing command", () => {
    expect(testJsonError("missing-command.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      At root[0]:
      Expected an object with a field called: "command"
      Got: {
        "title": "Something"
      }
    `);
  });

  test("wrong command type", () => {
    expect(testJsonError("wrong-command-type.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      At root[0]["command"]:
      Expected an array
      Got: "npm run frontend"
    `);
  });

  test("invalid regex", () => {
    expect(testJsonError("invalid-regex.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      At root[0]["status"]["{}"]:
      Invalid regular expression: /{}/u: Lone quantifier brackets
      Got: "{}"
    `);
  });

  test("key typo", () => {
    expect(testJsonError("key-typo.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      At root[0]:
      Expected only these fields:
        "command",
        "title",
        "cwd",
        "status",
        "defaultStatus",
        "killAllSequence"
      Found extra fields:
        "titel"
    `);
  });

  test("kitchen sink", () => {
    expect(testJson("kitchen-sink.json")).toStrictEqual({
      tag: "Parsed",
      commands: [
        {
          command: ["node"],
          title: "node",
          cwd: ".",
          status: [],
          killAllSequence: "\x03\x03",
        },
        {
          command: ["npm", "start"],
          title: "Backend",
          cwd: ".",
          defaultStatus: undefined,
          status: [],
          killAllSequence: "\x03",
        },
        {
          command: ["npm", "run", "parcel"],
          title: "Parcel",
          cwd: "frontend",
          status: [
            [/🚨/u, ["🚨", "E"]],
            [/✨/u, undefined],
          ],
          defaultStatus: ["⏳", "S"],
          killAllSequence: "\x03",
        },
      ],
      autoExit: { tag: "NoAutoExit" },
    });
  });
});

describe("--auto-exit runs", () => {
  /**
   * @param {Array<string>} args
   * @returns {{ status: number | null, stdout: string }}
   */
  function run(args) {
    const child = childProcess.spawnSync(
      "node",
      [path.join(__dirname, "..", "run-pty.js"), ...args],
      { encoding: "utf8" },
    );

    expect(child.error).toBeUndefined();

    expect(replaceAnsi(child.stderr)).toBe("");

    return {
      status: child.status,
      stdout: replaceAnsi(child.stdout).replace(/\r/g, ""),
    };
  }

  test("success", () => {
    const { status, stdout } = run([
      "--auto-exit=2",
      "%",
      "true",
      "%",
      "sleep",
      "0.1",
      "%",
      "echo",
      "hello",
    ]);

    expect(stdout).toMatchInlineSnapshot(`
      🟢 true⧘

      🟢 sleep 0.1⧘

      🥱 echo hello⧘

      ⚪ true⧘
      ⧙exit 0⧘ ⧙(1/3 exited)⧘

      🟢 echo hello⧘

      ⚪ echo hello⧘
      hello
      ⧙exit 0⧘ ⧙(2/3 exited)⧘

      ⚪ sleep 0.1⧘
      ⧙exit 0⧘ ⧙(3/3 exited)⧘

      ⧙Summary – success:⧘
      ⚪ ⧙exit 0⧘ true⧘
      ⚪ ⧙exit 0⧘ sleep 0.1⧘
      ⚪ ⧙exit 0⧘ echo hello⧘␊

    `);

    expect(status).toBe(0);
  });

  test("failure", () => {
    const { status, stdout } = run([
      "--auto-exit=2",
      "%",
      "sleep",
      "0.1",
      "%",
      "false",
      "%",
      "echo",
      "hello",
    ]);

    expect(stdout).toMatchInlineSnapshot(`
      🟢 sleep 0.1⧘

      🟢 false⧘

      🥱 echo hello⧘

      🔴 false⧘
      ⧙exit 1⧘ ⧙(1/3 exited)⧘

      🟢 echo hello⧘

      ⚪ echo hello⧘
      hello
      ⧙exit 0⧘ ⧙(2/3 exited)⧘

      ⚪ sleep 0.1⧘
      ⧙exit 0⧘ ⧙(3/3 exited)⧘

      ⧙Summary – failure:⧘
      ⚪ ⧙exit 0⧘ sleep 0.1⧘
      🔴 ⧙exit 1⧘ false⧘
      ⚪ ⧙exit 0⧘ echo hello⧘␊

    `);

    expect(status).toBe(1);
  });
});
