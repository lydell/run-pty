# run-pty

`run-pty` is a command line tool that lets you run several commands concurrently. Show output for one command at a time. Kill all at once. Nothing more, nothing less.

It’s like [concurrently] but the command outputs aren’t mixed, and you can restart commands individually. I bet you can do the same with [tmux] if you feel like installing and learning it. In `bash` you can use `command1 & command2` together with `fg`, `bg`, `jobs` and <kbd>ctrl+z</kbd> to achieve a similar result, but it’s not very user friendly.

<kbd>ctrl+z</kbd> shows the _dashboard,_ which gives you an overview of all your running commands and lets you switch between them.

<kbd>ctrl+c</kbd> kills commands.

A use case is running several watchers. Maybe one or two for frontend (webpack, Parcel, Sass), and one for backend (nodemon, TypeScript, or even some watcher for another programming language).

```json
{
  "scripts": {
    "start": "run-pty % npm run frontend % npm run backend",
    "frontend": "webpack-dev-server",
    "backend": "nodemon server.js"
  }
}
```

```
 1   🟢 pid 78147  npm run frontend
 2   🔴 exit 1     npm run backend

1-2    focus command
ctrl+c kill all
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
