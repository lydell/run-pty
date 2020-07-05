const pty = require("node-pty");
const readline = require("readline");

const help = `
Run several commands concurrently.
Show output for one command at a time.
Kill all at once with ctrl+c.

USAGE:

run-pty [OPTIONS] COMMANDS...

OPTIONS:

-h, --help                 Print this message.
-k, --key KEY              Key to press to go from a command output to the dashboard.
                           Defaults to "tab".
                           Omit KEY to interactively press the key you want and print its name.
-d, --delimiter STRING     Delimiter to use between commands.

EXAMPLES:

Run two commands:
run-pty npm start % make watch

Interactively find a dashboard key:
run-pty --key

Use a custom key and delimiter:
run-pty -k return -d / command1 / command2 a b / command3 123

NOTES:

A command is a file followed by arguments – not shell script.
`.trim();

function run() {
  const parseResult = parseArgs(process.argv.slice(2));

  switch (parseResult.tag) {
    case "Help":
      console.log(help);
      process.exit(0);
      break;

    case "TryKeys":
      console.log(
        `Press the key you would like to use with ${parseResult.arg}!`
      );
      console.log("Press ctrl+c to exit.");
      tryKeys();
      break;

    case "Parsed":
      runCommands({
        dashboardKey: parseResult.dashboardKey,
        commands: parseResult.commands,
      });
      break;

    case "Error":
      console.error(parseResult.message);
      process.exit(1);
      break;

    default:
      console.error(`Unknown parseResult`, parseResult);
      process.exit(1);
      break;
  }
}

function parseArgs(args) {
  if (args.length === 0) {
    return { tag: "Help" };
  }

  let dashboardKey = "tab";
  let delimiter = "%";
  let seenDelimiter = false;
  let command = [];
  const commands = [];
  const lastIndex = args.length - 1;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (seenDelimiter) {
      if (arg === delimiter) {
        if (command.length > 0) {
          commands.push(command);
          command = [];
        }
      } else {
        command.push(arg);
      }
    } else {
      switch (arg) {
        case delimiter:
          seenDelimiter = true;
          break;

        case "-h":
        case "--help":
          return { tag: "Help" };

        case "-k":
        case "--key":
          if (index === lastIndex) {
            return { tag: "TryKeys", arg };
          }
          index++;
          dashboardKey = args[index];
          break;

        case "-d":
        case "--delimiter":
          if (index === lastIndex) {
            return {
              tag: "Error",
              message: `${arg} must be followed by your desired delimiter.`,
            };
          }
          index++;
          delimiter = args[index];
          break;

        default:
          if (arg.startsWith("-")) {
            return { tag: "Error", message: `Unknown argument: ${arg}` };
          } else {
            seenDelimiter = true;
          }
      }
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
    dashboardKey,
    commands,
  };
}

function setupStdin() {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  readline.emitKeypressEvents(process.stdin);
}

function tryKeys() {
  setupStdin();
  process.stdin.on("keypress", (_, keypress) => {
    if (keypress.ctrl && keypress.name == "c") {
      process.exit(0);
    } else {
      console.log(keypressToString(keypress));
    }
  });
}

function keypressToString(keypress) {
  const name = keypress.name || keypress.sequence || "unknown";
  return keypress.ctrl ? `ctrl+${name}` : name;
}

function commandToPresentationName(command) {
  return command
    .map((part) =>
      /^[\w-]+$/.test(part) ? part : `'${part.replace(/'/g, `'"'"'`)}'`
    )
    .join(" ");
}

function runCommands({ dashboardKey, commands }) {
  setupStdin();

  const terminals = commands.map((command) => ({
    name: commandToPresentationName(command),
    history: [],
    terminal: pty.spawn(command[0], command.slice(1), {
      cols: process.stdout.columns,
      rows: process.stdout.rows,
    }),
  }));

  let current =
    commands.length === 1 ? { tag: "Command", index: 0 } : { tag: "Dashboard" };

  process.stdout.on("resize", () => {
    terminal.resize(process.stdout.columns, process.stdout.rows);
  });

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    if (data === "\x03") {
      terminal.kill();
    } else if (data === "\t") {
      console.clear();
      for (const data of history) {
        process.stdout.write(data);
      }
    } else {
      terminal.write(data);
    }
  });

  const dispose1 = terminal.onData((data) => {
    history.push(data);
    process.stdout.write(data);
  });

  const dispose2 = terminal.onExit(({ exitCode, signal }) => {
    console.log("Exit", exitCode, signal);
    process.exit(exitCode);
  });
}

run();
