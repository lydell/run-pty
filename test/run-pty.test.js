"use strict";

const childProcess = require("child_process");
const path = require("path");
const os = require("os");

const {
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
} = require("../run-pty");

/**
 * @param {{ pid: number }} init
 * @returns {import("node-pty").IPty}
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
    on: () => notCalled("on"),
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
    isSimpleLog: true,
    isOnAlternateScreen: false,
    statusFromRules: item.statusFromRules,
    defaultStatus: undefined,
    statusRules: [],
    onData: () => notCalled("onData"),
    onRequest: () => notCalled("onRequest"),
    onExit: () => notCalled("onExit"),
    pushHistory: () => notCalled("pushHistory"),
    start: () => notCalled("start"),
    kill: () => notCalled("kill"),
    updateStatusFromRules: () => notCalled("updateStatusFromRules"),
    windowsConptyCursorMoveWorkaround: false,
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

      Note: All arguments are strings and passed as-is – no shell script execution.
      Use ⧙sh -c '...'⧘ or similar if you need that.

      Alternatively, specify the commands in a JSON file:

          ⧙run-pty⧘ run-pty.json

      You can tell run-pty to exit once all commands have exited with status 0:

          ⧙run-pty⧘ --auto-exit ⧙%⧘ npm ci ⧙%⧘ dotnet restore ⧙&&⧘ ./build.bash

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
   * @param {{width?: number, attemptedKillAll?: boolean, autoExit?: import("../run-pty").AutoExit}} options
   * @returns {string}
   */
  function testDashboard(
    items,
    {
      width = 80,
      attemptedKillAll = false,
      autoExit = { tag: "NoAutoExit" },
    } = {}
  ) {
    return replaceAnsi(
      drawDashboard({
        commands: items.map(fakeCommand),
        width,
        attemptedKillAll,
        autoExit,
        selection: { tag: "Invisible", index: 0 },
      })
    );
  }

  test("empty", () => {
    expect(testDashboard([], { width: 0 })).toMatchInlineSnapshot(`
      ⧙[⧘⧙⧘⧙]⧘       focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection
    `);
  });

  test("one command", () => {
    expect(
      testDashboard([
        {
          command: ["npm", "start"],
          status: { tag: "Exit", exitCode: 0, wasKilled: false },
        },
      ])
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⚪⧘  ⧙exit 0⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection
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

        { autoExit: { tag: "AutoExit", maxParallel: 3 } }
      )
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection

      At most 3 commands run at a time.
      The session ends automatically once all commands are ⧙exit 0⧘.
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

        { autoExit: { tag: "AutoExit", maxParallel: 1 } }
      )
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection

      At most 1 command runs at a time.
      The session ends automatically once all commands are ⧙exit 0⧘.
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
        { autoExit: { tag: "AutoExit", maxParallel: 2 } }
      )
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection

      At most 2 commands run at a time.
      The session ends automatically once all commands are ⧙exit 0⧘.
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

        { autoExit: { tag: "AutoExit", maxParallel: 3 } }
      )
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  npm start⧘
      ⧙[⧘⧙2⧘⧙]⧘  ⛔️⧘  ⧙exit 1⧘  npm run build⧘

      ⧙[⧘⧙1-2⧘⧙]⧘    focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection
      ⧙[⧘⧙enter⧘⧙]⧘  restart failed

      At most 3 commands run at a time.
      The session ends automatically once all commands are ⧙exit 0⧘.
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
            },
          },
        ],
        { attemptedKillAll: true }
      )
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⭕⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all ⧙(double-press to force) ⧘
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection
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
            },
          },
        ],
        {
          attemptedKillAll: true,
          autoExit: { tag: "AutoExit", maxParallel: 3 },
        }
      )
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⭕⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all ⧙(double-press to force) ⧘
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection

      At most 3 commands run at a time.
      The session ends automatically once all commands are ⧙exit 0⧘.
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
        }
      )
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
      ])
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⚪⧘  ⧙exit 0⧘    echo ./Some_script2.js -v '$end' '' \\'quoted\\''th|ng'\\' 'hel…⧘
      ⧙[⧘⧙2⧘⧙]⧘  ⚪⧘  ⧙exit 130⧘  npm run server⧘
      ⧙[⧘⧙3⧘⧙]⧘  🔴⧘  ⧙exit 68⧘   ping nope⧘
      ⧙[⧘⧙4⧘⧙]⧘  ⭕⧘  ping localhost⧘
      ⧙[⧘⧙5⧘⧙]⧘  🟢⧘  yes⧘
      ⧙[⧘⧙6⧘⧙]⧘  🚨⧘  very long title for some reason that needs to be cut off at some point⧘

      ⧙[⧘⧙1-6⧘⧙]⧘    focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all ⧙(double-press to force) ⧘
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection
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
        }))
      )
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
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection
    `);
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
      ])
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
      ])
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
      ])
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
      ])
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
      })
    );
  }

  test("just a command", () => {
    expect(
      render(
        (command) => historyStart(runningIndicator, command),
        "npm start",
        "./"
      )
    ).toMatchInlineSnapshot(`
      🟢 npm start⧘␊

    `);
  });

  test("title with command and changed cwd", () => {
    expect(
      render(
        (command) => historyStart(runningIndicator, command),
        "frontend: npm start",
        "web/frontend"
      )
    ).toMatchInlineSnapshot(`
      🟢 frontend: npm start⧘
      📂 ⧙web/frontend⧘␊

    `);
  });

  test("running text includes pid", () => {
    expect(replaceAnsi(runningText(12345))).toMatchInlineSnapshot(`
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill ⧙(pid 12345)⧘
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("killing without cwd", () => {
    expect(render(() => killingText(12345), "frontend: npm start", "./x/.."))
      .toMatchInlineSnapshot(`
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill ⧙(double-press to force) (pid 12345)⧘
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("killing with cwd", () => {
    expect(
      render(() => killingText(12345), "frontend: npm start", "web/frontend")
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill ⧙(double-press to force) (pid 12345)⧘
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("exit 0 with cwd", () => {
    expect(
      render(
        (command) => exitText([], command, 0, { tag: "NoAutoExit" }),
        "frontend: npm start",
        "web/frontend"
      )
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
        (command) => exitText([], command, 0, { tag: "NoAutoExit" }),
        "frontend: npm start",
        "."
      )
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
          exitText([], command, 0, {
            tag: "AutoExit",
            maxParallel: 3,
          }),
        "frontend: npm start",
        "."
      )
    ).toMatchInlineSnapshot(`
      ⚪ frontend: npm start⧘
      exit 0

      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("exit 1 with auto exit (can be restarted)", () => {
    expect(
      render(
        (command) => exitText([], command, 1, { tag: "NoAutoExit" }),
        "frontend: npm start",
        "."
      )
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
        })
      )
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
        })
      )
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
        })
      )
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

describe("parse args", () => {
  test("help", () => {
    expect(parseArgs([])).toStrictEqual({ tag: "Help" });
    expect(parseArgs(["-h"])).toStrictEqual({ tag: "Help" });
    expect(parseArgs(["--help"])).toStrictEqual({ tag: "Help" });
  });

  test("no commands", () => {
    expect(parseArgs(["%"])).toMatchInlineSnapshot(`
      Object {
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
      Object {
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
      Object {
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
      { autoExit = { tag: "NoAutoExit" } } = {}
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
      parsedCommands([["npm", "start"]])
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
      ])
    ).toStrictEqual(
      parsedCommands([
        ["npm", "start"],
        ["webpack-dev-server", "--entry", "/entry/file"],
      ])
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
      ])
    ).toStrictEqual(
      parsedCommands([
        ["./report_progress.bash", "--root", "/", "--unit", "%"],
        ["ping", "localhost"],
      ])
    );

    expect(parseArgs(["+", "one", "+", "+", "+two", "+"])).toStrictEqual(
      parsedCommands([["one"], ["+two"]])
    );

    expect(parseArgs(["-", "one", "-", "-two", "-"])).toStrictEqual(
      parsedCommands([["one"], ["-two"]])
    );

    expect(parseArgs(["--", "one", "--", "--two", "--"])).toStrictEqual(
      parsedCommands([["one"], ["--two"]])
    );

    expect(parseArgs(["---", "one", "---", "---two", "---"])).toStrictEqual(
      parsedCommands([["one"], ["---two"]])
    );

    expect(
      parseArgs(["--auto-exit", "%", "one", "%", "two", "--auto-exit"])
    ).toStrictEqual(
      parsedCommands([["one"], ["two", "--auto-exit"]], {
        autoExit: {
          tag: "AutoExit",
          maxParallel: os.cpus().length,
        },
      })
    );

    expect(
      parseArgs(["--auto-exit=234", "%", "one", "%", "two", "--auto-exit"])
    ).toStrictEqual(
      parsedCommands([["one"], ["two", "--auto-exit"]], {
        autoExit: { tag: "AutoExit", maxParallel: 234 },
      })
    );

    expect(
      parseArgs(["--auto-exit=auto", "%", "one", "%", "two", "--auto-exit"])
    ).toStrictEqual(
      parsedCommands([["one"], ["two", "--auto-exit"]], {
        autoExit: {
          tag: "AutoExit",
          maxParallel: os.cpus().length,
        },
      })
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
      Unexpected end of JSON input
    `);
  });

  test("invalid json syntax", () => {
    expect(testJsonError("invalid-json-syntax.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      Unexpected token ] in JSON at position 91
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
      At root[0]["command"]:
      Expected an array
      Got: undefined
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
      Invalid regular expression: /{}/: Lone quantifier brackets
    `);
  });

  test("key typo", () => {
    expect(testJsonError("key-typo.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      At root[0]:
      Expected only these fields: "command", "title", "cwd", "status", "defaultStatus", "killAllSequence"
      Found extra fields: "titel"
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
          defaultStatus: undefined,
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
      { encoding: "utf8" }
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
