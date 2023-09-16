# run-pty

`run-pty` is a command line tool that lets you run several commands _concurrently_ and _interactively._ Show output for one command at a time. Kill all at once.

It’s like [concurrently] but the command outputs aren’t mixed, and you can restart commands individually and interact with them. I bet you can do the same with [tmux] if you – and your team mates – feel like installing and learning it. In `bash` you can use `command1 & command2` together with `fg`, `bg`, `jobs` and <kbd>ctrl+z</kbd> to achieve a similar result, but run-pty tries to be easier to use, and cross-platform.

<kbd>ctrl+z</kbd> shows the _dashboard,_ which gives you an overview of all your running commands and lets you switch between them.

<kbd>ctrl+c</kbd> kills commands.

A use case is running several watchers. Maybe one or two for frontend (webpack, Parcel, Vite), and one for backend (nodemon, or even some watcher for another programming language).

Another use case is running a couple of commands in parallel, using [--auto-exit](#--auto-exit).

## Example

```json
{
  "scripts": {
    "start": "run-pty % npm run frontend % npm run backend",
    "frontend": "parcel watch index.html",
    "backend": "nodemon server.js"
  }
}
```

```
$ npm start

> @ start /Users/lydell/src/run-pty/demo
> run-pty % npm run frontend % npm run backend
```

➡️

```
[1]  🟢   npm run frontend
[2]  🟢   npm run backend

[1-2]    focus command (or click)
[ctrl+c] kill all
[↑/↓]    move selection
[tab]    select by indicator
```

➡️ <kbd>1</kbd> ️️➡️

```
🟢  npm run frontend

> frontend
> vite --no-clearScreen


  VITE v3.2.1  ready in 91 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
▊
[ctrl+c] kill (pid 36842)
[ctrl+z] dashboard
```

➡️ <kbd>ctrl+c</kbd> ➡️

```
🟢  npm run frontend

> frontend
> vite --no-clearScreen


  VITE v3.2.1  ready in 91 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
^C

⚪  npm run frontend
exit 0

[enter]  restart
[ctrl+c] kill all
[ctrl+z] dashboard
```

➡️ <kbd>ctrl+z</kbd> ➡️

```
[1]  ⚪   exit 0  npm run frontend
[2]  🟢   npm run backend

[1-2]    focus command (or click)
[ctrl+c] kill all
[↑/↓]    move selection
[tab]    select by indicator
[enter]  restart exited
```

➡️ <kbd>ctrl+c</kbd> ➡️

```
[1]  ⚪  exit 0  npm run frontend
[2]  ⚪  exit 0  npm run backend

$ ▊
```

## Installation

`npm install --save-dev run-pty`

`npx run-pty --help`

## Advanced mode

The above example called `run-pty` like so:

```
run-pty % npm run frontend % npm run backend
```

Instead of defining the commands at the command line, you can define them in a JSON file:

_run-pty.json:_

```json
[
  {
    "command": ["npm", "run", "frontend"]
  },
  {
    "command": ["npm", "run", "backend"]
  }
]
```

```
run-pty run-pty.json
```

(The JSON file can be called anything – you specify the path to it on the command line.)

The JSON format lets you specify additional things apart from the command itself.

**[👉 Example JSON file](./demo/run-pty.json)**

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| command | `Array<string>` | _Required_ | The command to run. Must not be empty. |
| title | `string` | `command` as a string | What to show in the dashboard. |
| cwd | `string` | `"."` | Current working directory for the command. |
| status | <code>{ [regex: string]: [string,&nbsp;string] &vert; null }</code> | `{}` | Customize the status of the command in the dashboard. |
| defaultStatus | <code>[string,&nbsp;string] &vert; null</code> | `null` | Customize the default status of the command in the dashboard. |
| killAllSequence | `string` | `"\u0003"` | Sequence to send to the command when using “kill all”. The default is the escape code for <kbd>ctrl+c</kbd>. |

- command: On the command line, you let your shell split the commands into arguments. In the JSON format, you need to do it yourself. For example, if you had `run-pty % npm run frontend` on the command line, the JSON version of it is `["npm", "run", "frontend"]`. And `run-pty % echo 'hello world'` would be `["echo", "hello world"]`. See also: [Shell scripting](#shell-scripting).

- title: If you have complicated commands, it might be hard to find what you’re looking for in the dashboard. This lets you use more human readable titles instead. The titles are also shown when you focus a command (before the command itself).

- cwd: This is handy if you need to run some command as if you were in a subdirectory. When focusing a command, the `cwd` is shown below the title/command (unless it’s `"."` (the CWD of the `run-pty` process itself) or equal to the title):

  ```
  🟢 Custom title: npm run something
  📂 my/cwd/path
  ```

- status: It’s common to run watchers in `run-pty`. Watchers wrap your program – if your program crashes, the watcher will still be up and running and wait for source code changes so it can restart your program and try again. `run-pty` will display a 🟢 in the dashboard (since the watcher is successfully running), which makes things look all green. But in reality things are broken. `status` lets you replace 🟢 with custom status indicators, such as 🚨 to indicate an error.

  The keys in the object are regexes with the `u` flag.

  The values are either a tuple with two strings or `null`.

  For each _line_ of output, `run-pty` matches all the regexes from top to bottom. For every match, the status indicator is set to the corresponding value. If several regexes match, the last match wins. [Graphic renditions] are stripped before matching.

  This is how the value (`[string, string] | null`) is used:

  - The first string is used primarily. The string is drawn in 2 character slots in the terminal – if your string is longer, it will be cut off. Emojis usually need 2 character slots.
  - The second string is used on Windows (except if you use [Windows Terminal] instead of for example cmd.exe) or if the `NO_COLOR` environment variable is set. In `NO_COLOR` mode, [graphic renditions] are stripped as well. So you can use ANSI codes (in either string) to make your experience more colorful while still letting people have monochrome output if they prefer. Unlike the first string, the second string is drawn in **1** character slot in the terminal. (Windows – except the newer [Windows Terminal] – does not support emojis in the terminal very well, and for `NO_COLOR` you might not want colored emojis, so a single character should do.)
  - `null` resets the indicator to the standard 🟢 one (_not_ `defaultStatus`).

- defaultStatus: This lets you replace 🟢 with a custom status indicator at startup (before your command has written anything). The value works like for `status`.

- killAllSequence: When you use “kill all” (or “restart selected”) run-pty sends <kbd>ctrl+c</kbd> to all commands. However, not all commands exit when you do that. In such cases, you can use `killAllSequence` to specify what sequence of characters to send to the command to make it exit.

## --auto-exit

If you want to run a couple of commands in parallel and once they’re done continue with something else, use `--auto-exit`:

```bash
run-pty --auto-exit % npm ci % dotnet restore && node build.js
```

- You can enter the different commands while they are running to see their progress.
- Once all commands exit with code 0 (success), run-pty exits with code 0 as well.
- If some command fails, run-pty does _not_ exit, so you can inspect the failure, and re-run that command if you want.
- If you exit run-pty before all commands have exited with code 0, run-pty exits with code 1, so that if run-pty was part of a longer command chain, that chain is ended.
- In CI – where there is no TTY – the `--auto-exit` mode degrades to a simpler, non-interactive UI.

To limit how many commands run in parallel, use for example `--auto-exit=5`. Just `--auto-exit` is the same as `--auto-exit=auto`, which uses the number of logical CPU cores.

Note: `--auto-exit` is for conveniently running a couple of commands in parallel and get to know once they are done. I don’t want the feature to grow to [GNU Parallel] levels of complexity.

## Shell scripting

Let’s say you run `run-pty % npm run $command` on the command line. If the `command` variable is set to `frontend`, the command actually executed is `run-pty % npm run frontend` – run-pty receives `["%", "npm", "run", "frontend"]` as arguments (and has no idea that `frontend` came from a variable initially). This is all thanks to your shell – which is assumed to be a bash-like shell here; the syntax for Windows’ `cmd.exe` would be different, for example.

If you try to put that in a [JSON file](#advanced-mode) as `"command": ["npm", "run", "$command"]`, run-pty is going to try to execute `npm` with the literal strings `run` and `$command`, so `npm` receives `["run", "$command"]` as arguments. There’s no shell in play here.

Another example: Let’s say you wanted a command to first run `npm install` and then run `npm start` to start a server or something. If you run `run-pty % npm install && npm start` from the command line, it actually means “first run `run-pty % npm install` and once that’s done (and succeeded), run `npm start`”, which is not what you wanted. You might try to fix that by using escapes: `run-pty % npm install \&\& npm start`. However, run-pty is then going to execute `npm` with `["install", "&&", "npm", "start"]` as arguments. There’s no shell in play here either.

run-pty only executes programs with an array of literal strings as arguments.

If you want a shell, you could do something like this: `run-pty % bash -c 'npm install && npm start'` or `"command": ["bash", "-c", "npm run \"$command\""]`. You can also but that in a file, like `my-script.bash`, and use `run-pty % ./my-script.bash` or `"command": ["./my-script.bash"]`. If you need cross-platform support (or get tired of bash), you could instead use `run-pty % node my-script.js` or `"command": ["node", "my-script.js"]`.

## Credits

- [microsoft/node-pty] does all the heavy lifting of running the commands.
- [apiel/run-screen] was the inspiration for this tool.

## iTerm2 flicker

[iTerm2] has a bug where the window flickers when clearing the screen without GPU rendering: <https://gitlab.com/gnachman/iterm2/-/issues/7677>

GPU rendering seems to be enabled by default, as long as your computer is connected to power.

You can enable GPU rendering always by toggling “Preferences > General > Magic > GPU Rendering + Advanced GPU Settings… > Disable GPU rendering when disconnected from power.”

run-pty tries to avoid clearing the screen and only redraw lines that have changed, but there might still be occasional flicker. Hopefully the iTerm2 developers will improve this some time. It does not happen in the standard Terminal app.

## License

[MIT](LICENSE).

[apiel/run-screen]: https://github.com/apiel/run-screen
[concurrently]: https://github.com/kimmobrunfeldt/concurrently
[gnu parallel]: https://www.gnu.org/software/parallel/
[graphic renditions]: https://en.wikipedia.org/wiki/ANSI_escape_code#SGR_parameters
[iterm2]: https://www.iterm2.com/
[microsoft/node-pty]: https://github.com/microsoft/node-pty
[tmux]: https://github.com/tmux/tmux
[windows terminal]: https://aka.ms/terminal
