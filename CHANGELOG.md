### Version 3.0.0 (unreleased)

- Added: The `killAllSequence` JSON field for commands. When you use “kill all” run-pty sends <kbd>ctrl+c</kbd> to all commands. However, not all commands exit when you do that. In such cases, you can use `killAllSequence` to specify what sequence of characters to the command to make it exit. This lets you cleanly exit commands, rather than double pressing <kbd>ctrl+c</kbd> which force kills them.
- Improved: Showing the keyboard shortcuts at the bottom of commands is now much more reliable. Instead of using complicated and fragile home grown regex and string slicing approaches, run-pty now uses the “save cursor” and “restore cursor” ANSI escapes codes which seem to exist for this very use case. For example, this fixes problems where background colors could “bleed” into other lines, or parts of the output became duplicated.
- Improved: ANSI escape codes allow programs to do things like changing colors or moving the cursor. There are also a few codes that work a little bit differently. When written, they don’t cause a state change. Instead, they cause the terminal to respond with information (in the form of other escape codes) on stdin. These need to be handled differently. When you switch focused command in run-pty, it can simply re-print the entire history of the command, including color escape codes which will work just fine. However, the codes that request a response should not be repeated like that, because the program might not be in a state where it expects a response anymore. run-pty now handles a few such escape codes differently, by making sure they only happen once and immediately. This fixes a problem where Vim would receive some “crap input” every time you switched from the dashboard to Vim. Also, run-pty already had some ad-hoc code related to this as a Windows special case. That’s now replaced with a more general solution.

### Version 2.3.2 (2021-05-20)

- Fixed: cwd is now resolved (using `path.resolve`) before being passed to `spawn`. Previously, just passing `cwd: "."` could cause `npm run` not to find package.json.

### Version 2.3.1 (2021-03-29)

- Fixed: Running with an empty NDJSON file now just exits with status 0 instead of being an error, to match how a JSON file with `[]` works. This is useful when generating the NDJSON from a script and it sometimes produces no commands to run.

### Version 2.3.0 (2021-02-25)

- Fixed: <kbd>ctrl+c</kbd> now works just like in a regular terminal. Previously, `run-pty` sent a SIGHUP signal followed by SIGTERM to the command, because I thought that killing commands had to be handled specially. Turns out all I need to do is pass along the <kbd>ctrl+c</kbd> press to the command. This allows the command to handle <kbd>ctrl+c</kbd> in a custom way if it wants, and it will kill the entire process tree instead of just the top process.
- Changed: Since <kbd>ctrl+c</kbd> is now sent to the command, it’s up to the command to actually exit then. Further key presses are now passed on to the command, including a second <kbd>ctrl+c</kbd>, which previously meant “force kill.” To force kill, double-press <kbd>ctrl+c</kbd>.
- Added: You can now click commands to focus them in terminals that support mouse events.
- Added: You can now use the arrow keys and <kbd>enter</kbd> to focus commands. (Vim-style keyboard shortcuts are available, too).
- Added: You can now press <kbd>enter</kbd> in the dashboard to restart all exited commands (press <kdd>escape</kbd> to unselect first, if needed).
- Changed: In focused commands, keyboard shortcuts are now always printed below the cursor, unless the command moves the cursor vertically or switches to the “alternate screen.”
- Improved: The whole history of the command is no longer reprinted when you kill it. No more text flashing by.
- Improved: History is cleared if the command clears the screen including the scrollback buffer. Many watchers clear the screen on each cycle. This means that focusing a long-running watcher command will now be faster and less text will flash by. This required having a separate history for the alternate screen.
- Improved: Emoji indicators should now always be drawn using 2 character slots in the terminal, regardless of terminal and terminal bugs.
- Changed: Exit code 130 is now marked with ⚪ instead of 🔴 since exit code 130 usually means exit via <kbd>ctrl+c</kbd>.
- Fixed: Some line rendering weirdness at command startup on Windows.

### Version 2.2.0 (2021-01-26)

- Added: You can now optionally provide the commands to run via a JSON (or NDJSON) file instead of directly at the command line. The JSON format lets you configure more things, such as custom status indicators.
- Changed: Calling `run-pty` with a single argument now expects that argument to be the path to a JSON file (as mentioned above), rather than always being an error. In other words, the logic around command parsing and errors is slightly changed in edge cases.
- Changed: Pids are no longer shown in the dashboard. They are rarely used and clutter the view. Now, you need to focus a command to see the pid. It’s at the keyboard shortcut for killing: `[ctrl+c] kill (pid 12345)`.
- Fixed: Emojis should now consistently render using 2 character slots in the terminal. I’ve noticed iTerm2 being a bit buggy about this (sometimes only using 1 slot, which looks bad).

### Version 2.1.1 (2020-09-10)

Fixed: The first line of output and keyboard shortcuts now show up as they should on Windows ([#3](https://github.com/lydell/run-pty/issues/3)).

### Version 2.1.0 (2020-08-06)

run-pty now works on Windows!

Also, in `NO_COLOR` mode you no longer get colored emoji.

### Version 2.0.0 (2020-08-03)

This release features proper killing of commands and some UI tweaks.

When killing commands, run-pty used to send the SIGHUP signal (because it’s the default). This works fine for killing `npm run`, but not `make`. run-pty now first sends SIGHUP (which causes `npm run` to exit less noisily), and then a more conventional SIGTERM (just like `kill`, which successfully kills `make`).

run-pty now also waits for its commands to actually exit before exiting itself. Commands might take a little while to exit – or might even get stuck doing so. Pressing <kbd>ctrl+c</kbd> a second time sends a SIGKILL signal to more forcefully kill commands.

If you try to `kill` the run-pty process, it now also kills its subprocesses, and waits for them just like for <kbd>ctrl+c</kbd> as mentioned above. A second `kill` causes SIGKILLs to be sent.

Similarly, in case of an unhandled exception run-pty now tries to clean up by SIGKILL-ing all commands.

The above means that run-pty now always exits in the dashboard view, so you can see how killing all commands go.

The UI has been tweaked to only show currently relevant keyboard shortcuts, which now also blend better into your terminal color scheme. The scrollback is cleared when switching views, making it easier to find the start of command output. The screen, colors and cursor are reset before drawing run-pty UI, so it cannot be messed up by commands.

Finally, at most one million characters of output are now remembered per command. After that, old output is removed. You can control this with the `RUN_PTY_MAX_HISTORY` environment variable. This is important for commands that print an extraordinary amount of output, or if you leave run-pty running for a long time.

### Version 1.0.1 (2020-07-06)

Fixed: <kbd>ctrl+z</kbd> is no longer leaked to the command, potentially causing it to suspend.

### Version 1.0.0 (2020-07-06)

Initial release.
