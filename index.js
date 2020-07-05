const pty = require("node-pty");
const readline = require("readline");

const help = `
Run several commands concurrently.
Show output for one command at a time – switch via ctrl+z.
Kill all at once with ctrl+c.

Examples:

run-pty % npm start % make watch % some_command arg1 arg2 arg3

run-pty @ ./compile.bash --root / @ ./report_progress.bash --unit % @ ping localhost

Note: A command is a file followed by arguments – not shell script code.
`.trim();

function run() {
  const parseResult = parseArgs(process.argv.slice(2));

  switch (parseResult.tag) {
    case "Help":
      console.log(help);
      process.exit(0);
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
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    return { tag: "Help" };
  }

  const delimiter = args[0];

  if (/^[\w-]*$/.test(delimiter)) {
    return {
      tag: "Error",
      message:
        "The first argument is the delimiter to use between commands.\nIt must not be empty or 0-9/a-z/underscores/dashes only.\nMaybe try % as delimiter?",
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

function setupStdin() {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  readline.emitKeypressEvents(process.stdin);
}

function commandToPresentationName(command) {
  return command
    .map((part) =>
      /^[\w-]+$/.test(part) ? part : `'${part.replace(/'/g, "’")}'`
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
