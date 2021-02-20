"use strict";

const path = require("path");

const {
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

      Separate the commands with a character of choice:

          ⧙run-pty⧘ ⧙%⧘ npm start ⧙%⧘ make watch ⧙%⧘ some_command arg1 arg2 arg3

          ⧙run-pty⧘ ⧙@⧘ ./report_progress.bash --root / --unit % ⧙@⧘ ping localhost

      Note: All arguments are strings and passed as-is – no shell script execution.
      Use ⧙sh -c '...'⧘ or similar if you need that.

      Alternatively, specify the commands in a JSON (or NDJSON) file:

          ⧙run-pty⧘ run-pty.json

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
        items.map((item, index) => {
          const title =
            item.title === undefined
              ? commandToPresentationName(item.command)
              : item.title;
          return {
            label: ALL_LABELS[index] || "",
            title,
            titleWithGraphicRenditions: title,
            formattedCommandWithTitle: commandToPresentationName(item.command),
            status: item.status,
            // Unused in this case:
            file: "file",
            args: [],
            cwd: ".",
            history: "",
            historyAlternateScreen: "",
            isSimpleLog: true,
            isOnAlternateScreen: false,
            statusFromRules: item.statusFromRules,
            defaultStatus: undefined,
            statusRules: [],
            onData: () => notCalled("onData"),
            onExit: () => notCalled("onExit"),
            pushHistory: () => notCalled("pushHistory"),
            start: () => notCalled("start"),
            kill: () => notCalled("kill"),
            updateStatusFromRules: () => notCalled("updateStatusFromRules"),
          };
        }),
        width,
        false,
        { tag: "Invisible", index: 0 }
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
      pause: () => notCalled("pause"),
      resume: () => notCalled("resume"),
      resize: () => notCalled("resize"),
      write: () => notCalled("write"),
      kill: () => notCalled("kill"),
    };
  }

  test("empty", () => {
    expect(testDashboard([], 0)).toMatchInlineSnapshot(`
      ⧙[⧘⧙⧘⧙]⧘       focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection
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
      ⧙[⧘⧙1⧘⧙]⧘  ⚪⧘  ⧙exit 0⧘  npm start⧘

      ⧙[⧘⧙1⧘⧙]⧘      focus command ⧙(or click)⧘
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙↑/↓⧘⧙]⧘    move selection
      ⧙[⧘⧙enter⧘⧙]⧘  restart exited
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
            command: ["npm", "run", "server"],
            status: { tag: "Exit", exitCode: 130 },
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
        ],
        80
      )
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
        })),
        80
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

describe("focused command", () => {
  /**
   * @param {(command: import("../run-pty").CommandText) => string} f
   * @param {string} formattedCommandWithTitle
   * @param {string} title
   * @param {string} cwd
   * @returns {string}
   */
  function render(f, formattedCommandWithTitle, title, cwd) {
    return replaceAnsi(f({ formattedCommandWithTitle, title, cwd }));
  }

  test("just a command", () => {
    expect(render(historyStart, "npm start", "npm start", "./"))
      .toMatchInlineSnapshot(`
      🟢 npm start⧘␊

    `);
  });

  test("title with command and changed cwd", () => {
    expect(
      render(historyStart, "frontend: npm start", "frontend", "web/frontend")
    ).toMatchInlineSnapshot(`
      🟢 frontend: npm start⧘
      📂 ⧙web/frontend⧘␊

    `);
  });

  test("cwd not shown if same as title", () => {
    expect(render(historyStart, "frontend: npm start", "frontend", "frontend"))
      .toMatchInlineSnapshot(`
      🟢 frontend: npm start⧘␊

    `);
  });

  test("running text includes pid", () => {
    expect(replaceAnsi(runningText(12345))).toMatchInlineSnapshot(`
      ␊
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill ⧙(pid 12345)⧘
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("killing without cwd", () => {
    expect(
      render(
        () => killingText(12345),
        "frontend: npm start",
        "frontend",
        "./x/.."
      )
    ).toMatchInlineSnapshot(`
      ␊
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill ⧙(double-press to force) (pid 12345)⧘
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("killing with cwd", () => {
    expect(
      render(
        () => killingText(12345),
        "frontend: npm start",
        "frontend",
        "web/frontend"
      )
    ).toMatchInlineSnapshot(`
      ␊
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ kill ⧙(double-press to force) (pid 12345)⧘
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("exit 0 with cwd", () => {
    expect(
      render(
        (command) => exitText([], command, 0),
        "frontend: npm start",
        "frontend",
        "web/frontend"
      )
    ).toMatchInlineSnapshot(`
      ␊
      ⚪ frontend: npm start⧘
      📂 ⧙web/frontend⧘
      exit 0

      ⧙[⧘⧙enter⧘⧙]⧘  restart
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
    `);
  });

  test("exit 1 without cwd", () => {
    expect(
      render(
        (command) => exitText([], command, 0),
        "frontend: npm start",
        "frontend",
        "frontend"
      )
    ).toMatchInlineSnapshot(`
      ␊
      ⚪ frontend: npm start⧘
      exit 0

      ⧙[⧘⧙enter⧘⧙]⧘  restart
      ⧙[⧘⧙ctrl+c⧘⧙]⧘ exit
      ⧙[⧘⧙ctrl+z⧘⧙]⧘ dashboard
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

  test("invalid json syntax", () => {
    expect(testJsonError("invalid-json-syntax.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      Unexpected token ] in JSON at position 91
    `);
  });

  test("invalid ndjson syntax", () => {
    expect(testJsonError("invalid-ndjson-syntax.ndjson"))
      .toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      Line 2: Unexpected token } in JSON at position 40
    `);
  });

  test("bad json type", () => {
    expect(testJsonError("bad-json-type.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      Expected input to start with [ or { but got: n
    `);
  });

  test("empty list of commands", () => {
    expect(testJson("empty-array.json")).toStrictEqual({ tag: "NoCommands" });
  });

  test("empty NDJSON", () => {
    expect(testJsonError("empty.ndjson")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      Expected input to start with [ or { but got: nothing
    `);
  });

  test("empty command", () => {
    expect(testJsonError("empty-command.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      Index 0: command: Expected a non-empty array
    `);
  });

  test("missing command", () => {
    expect(testJsonError("missing-command.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      Index 0: command: This field is required, but was not provided.
    `);
  });

  test("wrong command type", () => {
    expect(testJsonError("wrong-command-type.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      Index 0: command: Expected an array but got: "npm run frontend"
    `);
  });

  test("invalid regex", () => {
    expect(testJsonError("invalid-regex.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      Index 0: status["{}"]: This key is not a valid regex: Invalid regular expression: /{}/: Lone quantifier brackets
    `);
  });

  test("key typo", () => {
    expect(testJsonError("key-typo.json")).toMatchInlineSnapshot(`
      Failed to read command descriptions file as JSON:
      Index 0: Unknown key: titel
    `);
  });

  test("kitchen sink", () => {
    const parsed = testJson("kitchen-sink.json");

    expect(parsed).toStrictEqual({
      tag: "Parsed",
      commands: [
        {
          command: ["node"],
          title: "node",
          cwd: ".",
          defaultStatus: undefined,
          status: [],
        },
        {
          command: ["npm", "start"],
          title: "Backend",
          cwd: ".",
          defaultStatus: undefined,
          status: [],
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
        },
      ],
    });

    expect(testJson("kitchen-sink.ndjson")).toStrictEqual(parsed);
  });
});
