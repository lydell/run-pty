# run-pty

`run-pty` is a command line tool that lets you run several commands _concurrently_ and _interactively._ Show output for one command at a time. Kill all at once. Nothing more, nothing less.

It’s like [concurrently] but the command outputs aren’t mixed, and you can restart commands individually and interact with them. I bet you can do the same with [tmux] if you feel like installing and learning it. In `bash` you can use `command1 & command2` together with `fg`, `bg`, `jobs` and <kbd>ctrl+z</kbd> to achieve a similar result, but it’s not very user friendly.

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
[1]  🟢 pid 11084  npm run frontend
[2]  🟢 pid 11085  npm run backend

[1-2]    focus command
[ctrl+c] kill all
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

[ctrl+c] kill
[ctrl+z] dashboard

▊
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

⚪ npm run frontend
exit 0

[enter]  restart
[ctrl+c] kill all
[ctrl+z] dashboard
```

➡️ <kbd>ctrl+z</kbd> ➡️

```
[1]  ⚪ exit 0     npm run frontend
[2]  🟢 pid 11085  npm run backend

[1-2]    focus command
[ctrl+c] kill all
```

➡️ <kbd>ctrl+c</kbd> ➡️

```
[1]  ⚪ exit 0  npm run frontend
[2]  ⚪ exit 0  npm run backend

$ ▊
```

## Installation

`npm install --save-dev run-pty`

`npx run-pty --help`

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
[iterm2]: https://www.iterm2.com/
[microsoft/node-pty]: https://github.com/microsoft/node-pty
[tmux]: https://github.com/tmux/tmux
