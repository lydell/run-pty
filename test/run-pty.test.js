"use strict";

const {
  __forTests: {
    ALL_LABELS,
    commandToPresentationName,
    drawDashboard,
    help,
    historyStart,
    parseArgs,
    summarizeLabels,
  },
} = require("../run-pty");

/**
 * @param {string} string
 * @returns {string}
 */
function replaceAnsi(string) {
  return string
    .replace(/\x1B\[0?m/g, "⧘")
    .replace(/\x1B\[\d+m/g, "⧙")
    .replace(/\x1B\[\d*[GK]/g, "");
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

          ⧙[⧘⧙1-9/a-z/A-Z⧘⧙]⧘ focus command
          ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
          ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill focused/all
          ⧙[⧘⧙enter⧘⧙]⧘  restart killed/exited command

      Separate the commands with a character of choice:

          ⧙run-pty⧘ ⧙%⧘ npm start ⧙%⧘ make watch ⧙%⧘ some_command arg1 arg2 arg3

          ⧙run-pty⧘ ⧙@⧘ ./report_progress.bash --root / --unit % ⧙@⧘ ping localhost

      Note: All arguments are strings and passed as-is – no shell script execution.
      Use ⧙sh -c '...'⧘ or similar if you need that.

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
   *
   * @param {Array<{
   *   command: Array<string>;
   *   status: import("../run-pty").Status;
   *   statusFromRules?: string;
   *   title?: string;
   * }>} items
   * @param {number} width
   * @returns {string}
   */
  function testDashboard(items, width) {
    return replaceAnsi(
      drawDashboard(
        items.map((item, index) => ({
          label: ALL_LABELS[index] || "",
          title:
            item.title === undefined
              ? commandToPresentationName(item.command)
              : item.title,
          formattedCommandWithTitle: commandToPresentationName(item.command),
          status: item.status,
          // Unused in this case:
          file: "file",
          args: [],
          cwd: ".",
          history: "",
          statusFromRules: item.statusFromRules,
          defaultStatus: undefined,
          statusRules: [],
          onData: () => notCalled("onData"),
          onExit: () => notCalled("onExit"),
          pushHistory: () => notCalled("pushHistory"),
          start: () => notCalled("start"),
          kill: () => notCalled("kill"),
          updateStatusFromRules: () => notCalled("updateStatusFromRules"),
        })),
        width,
        false
      )
    );
  }

  /**
   *
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
      resize: () => notCalled("resize"),
      write: () => notCalled("write"),
      kill: () => notCalled("kill"),
    };
  }

  test("empty", () => {
    expect(testDashboard([], 0)).toMatchInlineSnapshot(`
      ⧙[⧘⧙⧘⧙]⧘       focus command
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit␊

    `);
  });

  test("one command", () => {
    expect(
      testDashboard(
        [
          {
            command: ["npm", "start"],
            status: { tag: "Exit", exitCode: 0 },
          },
        ],
        80
      )
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⚪⧘  exit 0  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit␊

    `);
  });

  test("a variety of commands", () => {
    expect(
      testDashboard(
        [
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
            status: { tag: "Exit", exitCode: 0 },
            statusFromRules: "!", // Should be ignored.
          },
          {
            command: ["ping", "nope"],
            status: { tag: "Exit", exitCode: 68 },
            statusFromRules: "!", // Should be ignored.
          },
          {
            command: ["ping", "localhost"],
            status: {
              tag: "Killing",
              terminal: fakeTerminal({ pid: 12345 }),
              slow: false,
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
        ],
        80
      )
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  ⚪⧘  exit 0      echo ./Some_script2.js -v '$end' '' \\'quoted\\''th|ng'\\' '…⧘
      ⧙[⧘⧙2⧘⧙]⧘  🔴⧘  exit 68     ping nope⧘
      ⧙[⧘⧙3⧘⧙]⧘  ⭕⧘  pid 12345   ping localhost⧘
      ⧙[⧘⧙4⧘⧙]⧘  🟢⧘  pid 123456  yes⧘
      ⧙[⧘⧙5⧘⧙]⧘  🚨⧘  pid 123456  very long title for some reason that needs to be cut off …⧘

      ⧙[⧘⧙1-5⧘⧙]⧘    focus command
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ force kill all␊

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
        80
      )
    ).toMatchInlineSnapshot(`
      ⧙[⧘⧙1⧘⧙]⧘  🟢⧘  pid 9980   echo 0⧘
      ⧙[⧘⧙2⧘⧙]⧘  🟢⧘  pid 9981   echo 1⧘
      ⧙[⧘⧙3⧘⧙]⧘  🟢⧘  pid 9982   echo 2⧘
      ⧙[⧘⧙4⧘⧙]⧘  🟢⧘  pid 9983   echo 3⧘
      ⧙[⧘⧙5⧘⧙]⧘  🟢⧘  pid 9984   echo 4⧘
      ⧙[⧘⧙6⧘⧙]⧘  🟢⧘  pid 9985   echo 5⧘
      ⧙[⧘⧙7⧘⧙]⧘  🟢⧘  pid 9986   echo 6⧘
      ⧙[⧘⧙8⧘⧙]⧘  🟢⧘  pid 9987   echo 7⧘
      ⧙[⧘⧙9⧘⧙]⧘  🟢⧘  pid 9988   echo 8⧘
      ⧙[⧘⧙a⧘⧙]⧘  🟢⧘  pid 9989   echo 9⧘
      ⧙[⧘⧙b⧘⧙]⧘  🟢⧘  pid 9990   echo 10⧘
      ⧙[⧘⧙c⧘⧙]⧘  🟢⧘  pid 9991   echo 11⧘
      ⧙[⧘⧙d⧘⧙]⧘  🟢⧘  pid 9992   echo 12⧘
      ⧙[⧘⧙e⧘⧙]⧘  🟢⧘  pid 9993   echo 13⧘
      ⧙[⧘⧙f⧘⧙]⧘  🟢⧘  pid 9994   echo 14⧘
      ⧙[⧘⧙g⧘⧙]⧘  🟢⧘  pid 9995   echo 15⧘
      ⧙[⧘⧙h⧘⧙]⧘  🟢⧘  pid 9996   echo 16⧘
      ⧙[⧘⧙i⧘⧙]⧘  🟢⧘  pid 9997   echo 17⧘
      ⧙[⧘⧙j⧘⧙]⧘  🟢⧘  pid 9998   echo 18⧘
      ⧙[⧘⧙k⧘⧙]⧘  🟢⧘  pid 9999   echo 19⧘
      ⧙[⧘⧙l⧘⧙]⧘  🟢⧘  pid 10000  echo 20⧘
      ⧙[⧘⧙m⧘⧙]⧘  🟢⧘  pid 10001  echo 21⧘
      ⧙[⧘⧙n⧘⧙]⧘  🟢⧘  pid 10002  echo 22⧘
      ⧙[⧘⧙o⧘⧙]⧘  🟢⧘  pid 10003  echo 23⧘
      ⧙[⧘⧙p⧘⧙]⧘  🟢⧘  pid 10004  echo 24⧘
      ⧙[⧘⧙q⧘⧙]⧘  🟢⧘  pid 10005  echo 25⧘
      ⧙[⧘⧙r⧘⧙]⧘  🟢⧘  pid 10006  echo 26⧘
      ⧙[⧘⧙s⧘⧙]⧘  🟢⧘  pid 10007  echo 27⧘
      ⧙[⧘⧙t⧘⧙]⧘  🟢⧘  pid 10008  echo 28⧘
      ⧙[⧘⧙u⧘⧙]⧘  🟢⧘  pid 10009  echo 29⧘
      ⧙[⧘⧙v⧘⧙]⧘  🟢⧘  pid 10010  echo 30⧘
      ⧙[⧘⧙w⧘⧙]⧘  🟢⧘  pid 10011  echo 31⧘
      ⧙[⧘⧙x⧘⧙]⧘  🟢⧘  pid 10012  echo 32⧘
      ⧙[⧘⧙y⧘⧙]⧘  🟢⧘  pid 10013  echo 33⧘
      ⧙[⧘⧙z⧘⧙]⧘  🟢⧘  pid 10014  echo 34⧘
      ⧙[⧘⧙A⧘⧙]⧘  🟢⧘  pid 10015  echo 35⧘
      ⧙[⧘⧙B⧘⧙]⧘  🟢⧘  pid 10016  echo 36⧘
      ⧙[⧘⧙C⧘⧙]⧘  🟢⧘  pid 10017  echo 37⧘
      ⧙[⧘⧙D⧘⧙]⧘  🟢⧘  pid 10018  echo 38⧘
      ⧙[⧘⧙E⧘⧙]⧘  🟢⧘  pid 10019  echo 39⧘
      ⧙[⧘⧙F⧘⧙]⧘  🟢⧘  pid 10020  echo 40⧘
      ⧙[⧘⧙G⧘⧙]⧘  🟢⧘  pid 10021  echo 41⧘
      ⧙[⧘⧙H⧘⧙]⧘  🟢⧘  pid 10022  echo 42⧘
      ⧙[⧘⧙I⧘⧙]⧘  🟢⧘  pid 10023  echo 43⧘
      ⧙[⧘⧙J⧘⧙]⧘  🟢⧘  pid 10024  echo 44⧘
      ⧙[⧘⧙K⧘⧙]⧘  🟢⧘  pid 10025  echo 45⧘
      ⧙[⧘⧙L⧘⧙]⧘  🟢⧘  pid 10026  echo 46⧘
      ⧙[⧘⧙M⧘⧙]⧘  🟢⧘  pid 10027  echo 47⧘
      ⧙[⧘⧙N⧘⧙]⧘  🟢⧘  pid 10028  echo 48⧘
      ⧙[⧘⧙O⧘⧙]⧘  🟢⧘  pid 10029  echo 49⧘
      ⧙[⧘⧙P⧘⧙]⧘  🟢⧘  pid 10030  echo 50⧘
      ⧙[⧘⧙Q⧘⧙]⧘  🟢⧘  pid 10031  echo 51⧘
      ⧙[⧘⧙R⧘⧙]⧘  🟢⧘  pid 10032  echo 52⧘
      ⧙[⧘⧙S⧘⧙]⧘  🟢⧘  pid 10033  echo 53⧘
      ⧙[⧘⧙T⧘⧙]⧘  🟢⧘  pid 10034  echo 54⧘
      ⧙[⧘⧙U⧘⧙]⧘  🟢⧘  pid 10035  echo 55⧘
      ⧙[⧘⧙V⧘⧙]⧘  🟢⧘  pid 10036  echo 56⧘
      ⧙[⧘⧙W⧘⧙]⧘  🟢⧘  pid 10037  echo 57⧘
      ⧙[⧘⧙X⧘⧙]⧘  🟢⧘  pid 10038  echo 58⧘
      ⧙[⧘⧙Y⧘⧙]⧘  🟢⧘  pid 10039  echo 59⧘
      ⧙[⧘⧙Z⧘⧙]⧘  🟢⧘  pid 10040  echo 60⧘
      ⧙[⧘⧙ ⧘⧙]⧘  🟢⧘  pid 10041  echo 61⧘

      ⧙[⧘⧙1-9/a-z/A-Z⧘⧙]⧘ focus command
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill all␊

    `);
  });
});

describe("history start", () => {
  /**
   * @param {string} name
   * @param {string} title
   * @param {string} cwd
   * @returns {string}
   */
  function testHistoryStart(name, title, cwd) {
    return replaceAnsi(historyStart(name, title, cwd));
  }

  test("just a command", () => {
    expect(testHistoryStart("npm start", "npm start", "."))
      .toMatchInlineSnapshot(`
      🟢 npm start⧘␊

    `);
  });

  test("title with command and changed cwd", () => {
    expect(testHistoryStart("frontend: npm start", "frontend", "web/frontend"))
      .toMatchInlineSnapshot(`
      🟢 frontend: npm start⧘
      📂 ⧙web/frontend⧘␊

    `);
  });

  test("cwd not shown if same as title", () => {
    expect(testHistoryStart("frontend: npm start", "frontend", "frontend"))
      .toMatchInlineSnapshot(`
      🟢 frontend: npm start⧘␊

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
    const error = parseArgs(["%"]);
    expect(error).toMatchInlineSnapshot(`
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

  test("commands", () => {
    /**
     * @param {Array<Array<string>>} commands
     * @returns {import("../run-pty").ParseResult}
     */
    function parsedCommands(commands) {
      return {
        tag: "Parsed",
        commands: commands.map((command) => ({
          command,
          cwd: ".",
          defaultStatus: undefined,
          status: [],
          title: commandToPresentationName(command),
        })),
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
  });
});
