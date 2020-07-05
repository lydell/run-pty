"use strict";

const colorette = require("colorette");
const pty = require("node-pty");
const readline = require("readline");

const KEYS = {
  kill: "ctrl+c",
  restart: "return",
  dashboard: "ctrl+z",
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const LABEL_GROUPS = ["123456789", ALPHABET, ALPHABET.toUpperCase()];
const ALL_LABELS = LABEL_GROUPS.join("");

const runningIndicator = "🟢";

const exitIndicator = (exitCode) => (exitCode === 0 ? "⚪" : "🔴");

const shortcut = (string) => colorette.blue(colorette.bold(string));

const runPty = shortcut("run-pty");
const pc = colorette.gray("%");
const at = colorette.gray("@");

const help = `
Run several commands concurrently.
Show output for one command at a time.
Kill all at once.

    ${shortcut(summarizeLabels(ALL_LABELS.split("")))} switch command
    ${shortcut(KEYS.dashboard)} dashboard
    ${shortcut(KEYS.kill)} exit current/all
    ${shortcut(KEYS.restart)} restart exited command

Separate the commands with a character of choice:

    ${runPty} ${pc} npm start ${pc} make watch ${pc} some_command arg1 arg2 arg3

    ${runPty} ${at} ./report_progress.bash --root / --unit % ${at} ping localhost

Note: All arguments are strings and passed as-is – no shell script execution.
`.trim();

function drawDashboard(commands) {
  const lines = commands.map((command) => [
    colorette.bgWhite(
      colorette.black(colorette.bold(` ${command.label || " "} `))
    ),
    statusText(command.status),
    command.name,
  ]);

  const widestStatus = Math.max(
    0,
    ...lines.map(([, status]) => Array.from(status).length)
  );

  const finalLines = lines
    .map(([label, status, name]) =>
      truncate(
        [label, padEnd(status, widestStatus), name].join("  "),
        process.stdout.columns
      )
    )
    .join("\n");

  const label = summarizeLabels(commands.map((command) => command.label));

  return `
${finalLines}

${shortcut(padEnd(label, KEYS.kill.length))} switch command
${shortcut(KEYS.kill)} exit current/all
${shortcut(KEYS.dashboard)} this dashboard
`.trim();
}

function firstHistoryLine(name) {
  return `${runningIndicator} ${name}\n`;
}

// Newlines at start/end are wanted here.
function exitText(commandName, exitCode) {
  return `
${exitIndicator(exitCode)} ${commandName}
exit ${exitCode}

${shortcut(KEYS.restart)} restart
${shortcut(KEYS.kill)} exit all
${shortcut(KEYS.dashboard)} dashboard
`;
}

function statusText(status) {
  switch (status.tag) {
    case "Running":
      return `${runningIndicator} pid ${status.terminal.pid}`;

    case "Exit":
      return `${exitIndicator(status.exitCode)} exit ${status.exitCode}`;

    default:
      throw new Error("Unknown command status", status);
  }
}

function truncate(string, maxLength) {
  return string.length <= maxLength
    ? string
    : `${string.slice(0, maxLength - 1)}…`;
}

function padEnd(string, maxLength) {
  const chars = Array.from(string);
  return chars
    .concat(
      Array.from({ length: Math.max(0, maxLength - chars.length) }, () => " ")
    )
    .join("");
}

function commandToPresentationName(command) {
  return command
    .map((part) =>
      /^[\w./-]+$/.test(part) ? part : `'${part.replace(/'/g, "’")}'`
    )
    .join(" ");
}

function keypressToString(keypress) {
  const name = keypress.name || keypress.sequence || "unknown";
  return keypress.ctrl ? `ctrl+${name}` : name;
}

function summarizeLabels(labels) {
  const numLabels = labels.length;
  return LABEL_GROUPS.map((group, index) => {
    const previousLength = LABEL_GROUPS.slice(0, index).reduce(
      (sum, previousGroup) => sum + previousGroup.length,
      0
    );
    const currentLength = previousLength + group.length;
    return numLabels > previousLength
      ? numLabels < currentLength
        ? group.slice(0, numLabels - previousLength)
        : group
      : undefined;
  })
    .filter(Boolean)
    .map((group) =>
      group.length === 1 ? group[0] : `${group[0]}-${group[group.length - 1]}`
    )
    .join("/");
}

function parseArgs(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    return { tag: "Help" };
  }

  const delimiter = args[0];

  if (/^[\w-]*$/.test(delimiter)) {
    return {
      tag: "Error",
      message:
        "The first argument is the delimiter to use between commands.\nIt must not be empty or a-z/0-9/underscores/dashes only.\nMaybe try % as delimiter?",
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
}

class Command {
  constructor({ label, file, args, onData, onExit }) {
    this.label = label;
    this.file = file;
    this.args = args;
    this.name = commandToPresentationName([file, ...args]);
    this.onData = onData;
    this.onExit = onExit;
    this.history = [];
    this.status = { tag: "Exit", exitCode: 0 };
    this.start();
  }

  start() {
    if (this.status.tag === "Running") {
      throw new Error(
        `pty already running with pid ${this.status.terminal.pid} for: ${this.name}`
      );
    }

    this.history = [firstHistoryLine(this.name)];

    const terminal = pty.spawn(this.file, this.args, {
      cols: process.stdout.columns,
      rows: process.stdout.rows,
    });

    const disposeOnData = terminal.onData((data) => {
      this.history.push(data);
      this.onData(data);
    });

    const disposeOnExit = terminal.onExit(({ exitCode }) => {
      disposeOnData.dispose();
      disposeOnExit.dispose();
      this.status = { tag: "Exit", exitCode };
      this.onExit(exitCode);
    });

    this.status = { tag: "Running", terminal };
  }

  log(data) {
    this.history.push(data);
    this.onData(data);
  }
}

function runCommands(rawCommands) {
  let current = { tag: "Dashboard" };

  const switchToDashboard = () => {
    current = { tag: "Dashboard" };
    console.clear();
    console.log(drawDashboard(commands));
  };

  const switchToCommand = (index) => {
    const command = commands[index];
    current = { tag: "Command", index };
    console.clear();
    for (const data of command.history) {
      process.stdout.write(data);
    }
  };

  const killAll = () => {
    for (const command of commands) {
      if (command.status.tag === "Running") {
        command.status.terminal.kill();
      }
    }
    process.exit(0);
  };

  const commands = rawCommands.map(
    ([file, ...args], index) =>
      new Command({
        label: ALL_LABELS[index] || "",
        file,
        args,
        onData: (data) => {
          if (current.tag === "Command" && current.index === index) {
            process.stdout.write(data);
          }
        },
        onExit: (exitCode) => {
          const command = commands[index];
          command.log(exitText(command.name, exitCode));
          if (current.tag === "Dashboard") {
            // Redraw dashboard.
            switchToDashboard();
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
  process.stdin.setEncoding("utf8");
  readline.emitKeypressEvents(process.stdin);

  process.stdin.on("data", (data) => {
    if (
      current.tag === "Command" &&
      commands[current.index].status.tag === "Running"
    ) {
      commands[current.index].status.terminal.write(data);
    }
  });

  process.stdin.on("keypress", (_, keypress) => {
    onKeypress(
      keypress,
      current,
      commands,
      switchToDashboard,
      switchToCommand,
      killAll
    );
  });

  if (commands.length === 1) {
    switchToCommand(0);
  } else {
    switchToDashboard();
  }
}

function onKeypress(
  keypress,
  current,
  commands,
  switchToDashboard,
  switchToCommand,
  killAll
) {
  const keypressString = keypressToString(keypress);

  switch (current.tag) {
    case "Command": {
      const command = commands[current.index];
      switch (command.status.tag) {
        case "Running":
          switch (keypressString) {
            case KEYS.kill:
              command.status.terminal.kill();
              break;

            case KEYS.dashboard:
              switchToDashboard();
              break;
          }
          break;

        case "Exit":
          switch (keypressString) {
            case KEYS.kill:
              killAll();
              break;

            case KEYS.dashboard:
              switchToDashboard();
              break;

            case KEYS.restart:
              command.start();
              command.history.unshift("\n");
              for (const data of command.history) {
                process.stdout.write(data);
              }
              break;
          }
          break;

        default:
          throw new Error("Unknown command status", command);
      }
      break;
    }

    case "Dashboard":
      switch (keypressString) {
        case KEYS.kill:
          killAll();
          break;

        default: {
          const commandIndex = commands.findIndex(
            (command) => command.label === keypressString
          );
          if (commandIndex !== -1) {
            switchToCommand(commandIndex);
          }
          break;
        }
      }
      break;

    default:
      throw new Error("Unknown current", current);
  }
}

function run() {
  const parseResult = parseArgs(process.argv.slice(2));

  switch (parseResult.tag) {
    case "Help":
      console.log(help);
      process.exit(0);
      break;

    case "Parsed":
      runCommands(parseResult.commands);
      break;

    case "Error":
      console.error(parseResult.message);
      process.exit(1);
      break;

    default:
      console.error("Unknown parseResult", parseResult);
      process.exit(1);
      break;
  }
}

run();
