# run-pty

`run-pty` is a command line tool that lets you run several commands _concurrently_ and _interactively._ Show output for one command at a time. Kill all at once. Nothing more, nothing less.

It’s like [concurrently] but the command outputs aren’t mixed, and you can restart commands individually and interact with them. I bet you can do the same with [tmux] if you – and your team mates – feel like installing and learning it. In `bash` you can use `command1 & command2` together with `fg`, `bg`, `jobs` and <kbd>ctrl+z</kbd> to achieve a similar result, but run-pty tries to be easier to use, and cross-platform.

<kbd>ctrl+z</kbd> shows the _dashboard,_ which gives you an overview of all your running commands and lets you switch between them.

<kbd>ctrl+c</kbd> kills commands.

A use case is running several watchers. Maybe one or two for frontend (webpack, Parcel, Sass), and one for backend (nodemon, or even some watcher for another programming language).

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
```

➡️ <kbd>1</kbd> ️️➡️

```
🟢 npm run frontend

> @ frontend /Users/lydell/src/run-pty/demo
> parcel watch index.html --log-level 4

[9:51:27 AM]: Building...
[9:51:27 AM]: Building index.html...
[9:51:27 AM]: Built index.html...
[9:51:27 AM]: Producing bundles...
[9:51:27 AM]: Packaging...
[9:51:27 AM]: ✨  Built in 67ms.
▊
[ctrl+c] kill (pid 63096)
[ctrl+z] dashboard
```

➡️ <kbd>ctrl+c</kbd> ➡️

```
🟢 npm run frontend

> @ frontend /Users/lydell/src/run-pty/demo
> parcel watch index.html --log-level 4

[9:51:27 AM]: Building...
[9:51:27 AM]: Building index.html...
[9:51:27 AM]: Built index.html...
[9:51:27 AM]: Producing bundles...
[9:51:27 AM]: Packaging...
[9:51:27 AM]: ✨  Built in 67ms.
^C

⚪ npm run frontend
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

- command: On the command line, you let your shell split the commands into arguments. In the JSON format, you need to do it yourself. For example, if you had `run-pty % npm run frontend` on the command line, the JSON version of it is `["npm", "run", "frontend"]`. And `run-pty % echo 'hello world'` would be `["echo", "hello world"]`.

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

  - The first string is used on all OS:es except Windows, unless the `NO_COLOR` environment variable is set. The string is drawn in 2 character slots in the terminal – if your string is longer, it will be cut off. Emojis usually need 2 character slots.
  - The second string is used on Windows or if `NO_COLOR` is set. In `NO_COLOR` mode, [graphic renditions] are stripped as well. So you can use ANSI codes (in either string) to make your experience more colorful while still letting people have monochrome output if they prefer. Unlike the first string, the second string is drawn in **1** character slot in the terminal. (Windows does not support emojis in the terminal very well, and for `NO_COLOR` you might not want colored emojis, so a single character should do.)
  - `null` resets the indicator to the standard 🟢 one (_not_ `defaultStatus`).

- defaultStatus: This lets you replace 🟢 with a custom status indicator at startup (before your command has written anything). The value works like for `status`.

Instead of JSON, you can also use [NDJSON] – one JSON object per line (blank lines are OK, too). This is handy if you generate the file on the fly using some primitive scripting language.

## Credits

- [microsoft/node-pty] does all the heavy lifting of running the commands.
- [apiel/run-screen] was the inspiration for this tool.

## iTerm2 flicker

[iTerm2] has a bug where the window flickers when clearing the screen without GPU rendering: <https://gitlab.com/gnachman/iterm2/-/issues/7677>

GPU rendering seems to be enabled by default, as long as your computer is connected to power.

You can enable GPU rendering always by toggling “Preferences > General > Magic > GPU Rendering + Advanced GPU Settings… > Disable GPU rendering when disconnected from power.”

There might still be occasional flicker. Hopefully the iTerm2 developers will improve this some time. It does not happen in the standard Terminal app.

## License

[MIT](LICENSE).

[apiel/run-screen]: https://github.com/apiel/run-screen
[concurrently]: https://github.com/kimmobrunfeldt/concurrently
[graphic renditions]: https://en.wikipedia.org/wiki/ANSI_escape_code#SGR_parameters
[iterm2]: https://www.iterm2.com/
[microsoft/node-pty]: https://github.com/microsoft/node-pty
[ndjson]: https://github.com/ndjson/ndjson-spec
[tmux]: https://github.com/tmux/tmux
