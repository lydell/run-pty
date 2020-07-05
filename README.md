# run-pty

In `bash` you can use `fg`, `bg`, `jobs` and <kbd>ctrl+z</kbd> to run several commands at the same time in the same terminal. But it’s not very user friendly.

`run-pty` is a command line tool that lets you run several commands concurrently. Show output for one command at a time. Kill all at once. Nothing more, nothing less.

<kbd>ctrl+z</kbd> shows the _dashboard,_ which gives you an overview of all your running commands and lets you switch between them.

<kbd>ctrl+c</kbd> exits current/all commands.

A use case is running several watchers. Maybe one or two for frontend (webpack, Parcel, Sass), and one for backend (nodemon, TypeScript, or even some watcher for another programming language).

```json
{
  "scripts": {
    "watch:frontend": "webpack-dev-server",
    "watch:backend": "nodemon server/index.ts",
    "watch:all": "run-pty % npm run watch:frontend % npm run watch:backend"
  }
}
```

```
 1   🟢 pid 78147  npm run 'watch:frontend'
 2   🔴 exit 1     npm run 'watch:backend'

1-2    switch command
ctrl+c exit current/all
ctrl+z this dashboard
```

## Installation

`npm install --save-dev run-pty`

`npx run-pty --help`

## Credits

- [microsoft/node-pty] does all the heavy lifting of running the commands.
- [apiel/run-screen] was the inspiration for this tool.

## License

[MIT](LICENSE).

[microsoft/node-pty]: https://github.com/microsoft/node-pty
[apiel/run-screen]: https://github.com/apiel/run-screen
