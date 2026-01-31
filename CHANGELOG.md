### Version 6.0.1 (2026-01-31)

Version 6.0.0 started using [Synchronized Output](https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md). For example, the dashboard is drawn/updated in one synchronous go to avoid a half-finished state being visible.

This version improves support for synchronized output in the commands that you run with run-pty. If a command starts a synchronized output, run-pty now won’t try to draw its keyboard shortcuts below the cursor:

```
[ctrl+c] kill (pid 12345)
[ctrl+z] dashboard
```

run-pty will instead wait for the command to end its synchronized output before doing that. There is no need for run-pty to draw its thing during a synchronized output, because it won’t be visible anyway. And since run-pty uses synchronized output itself, there is no risk that run-pty interrupts the synchronized rendering of the command.

### Version 6.0.0 (2026-01-17)

- Breaking change: Node.js 20 or newer is now required.
- Improved: run-pty now uses [Synchronized Output](https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md).
- Improved: The [@lydell/node-pty](https://github.com/lydell/node-pty) dependency (which these days is just a re-packaging of [microsoft/node-pty](https://github.com/microsoft/node-pty)) has been updated with lots of improvements from the original `node-pty` package.

### Version 5.0.1 (2026-01-17)

- Fixed: run-pty no longer “hangs” on Windows. Windows Terminal has introduced something called “Win32 Input Mode”. When that mode is triggered, key presses are no longer encoded the same way. This caused run-pty’s keyboard shortcuts (<kbd>ctrl+z</kbd>, arrow keys, etc.) not to match. run-pty now decodes Win32 Input Mode sequences so that the keyboard shortcuts work again. Thanks to [Travis Collins](https://github.com/tec27)!

### Version 5.0.0 (2024-03-19)

- Breaking change: The [microsoft/node-pty](https://github.com/microsoft/node-pty) dependency has been replaced by the fork [@lydell/node-pty](https://github.com/lydell/node-pty), which has prebuilt binaries. This means that a C++ compiler and Python is no longer needed to install run-pty. No C++ compilation is done on install, and you don’t need to rebuild when switching Node.js versions. On the other hand, run-pty now only works on the platforms it has prebuilt binaries for:
  - macOS x86_64
  - macOS ARM64
  - Linux x86_64
  - Windows x86_64
  - Windows ARM64

  If you use some other platform, please help with setting up builds for your platform over at [@lydell/node-pty](https://github.com/lydell/node-pty)!

- Workaround: Node.js has started work towards using [io_uring](https://en.wikipedia.org/wiki/Io_uring) on Linux, which is supposed to improve performance, but unfortunately causes a [bug in the underlying node-pty library](https://github.com/microsoft/node-pty/issues/630), which can cause [commands to exit unexpectedly](https://github.com/lydell/run-pty/issues/45) (due a signal), or can cause [100 % CPU usage](https://github.com/lydell/run-pty/issues/53). run-pty now disables `io_uring`, by setting the [UV_USE_IO_URING](https://nodejs.org/docs/latest-v21.x/api/cli.html#uv_use_io_uringvalue) environment variable to `0`. (You can still set `UV_USE_IO_URING=1` yourself to force `io_uring`.) Note that:
  - That environment variable is implemented by a dependency of Node.js and may be removed in future versions of Node.js. They provide no stability guarantees for the behavior of this environment variable. This means that even with the workaround added by run-pty, you might get `io_uring` enabled in future versions of Node.js anyway. (Hopefully with the bug fixed by then!)
  - Node.js [20.11.1](https://github.com/nodejs/node/blob/1f193165b990190074faab34f503683148816d39/doc/changelogs/CHANGELOG_V20.md#20.11.1) and [21.6.2](https://github.com/nodejs/node/blob/1f193165b990190074faab34f503683148816d39/doc/changelogs/CHANGELOG_V21.md#21.6.2) disabled `io_uring` by default due to a security issue (making the workaround less important for now).

- Changed: When a command is killed by a signal, run-pty receives exit code 0 and then the signal number. run-pty used to ignore the signal number and exit with code 0. Now, run-pty follows the shell convention of exiting with 128 plus the signal number. You might notice this when using <kbd>ctrl+c</kbd> to exit commands: Now they might show “exit 130”, which is 128+2, where 2 is the SIGINT signal which usually means exit by ctrl+c. (Fun fact: run-pty already supported showing exit code 130 with ⚪️ instead of 🔴, so that exiting a command doesn’t look so much as an error). This is useful for example if a command goes out of memory. The operating system then kills it with signal 9, SIGKILL, which now results in exit code 128+9=137 instead of 0, which is good since the command wasn’t successful. It’s also useful in the above `io_uring` case: Previously the `io_uring` bug could cause commands to unexpectedly exit with code 0 (successful); now they would exit with 128 plus the signal that killed them (unsuccessful), which probably results in 129.

- Improved: There are now slightly better error messages for invalid JSON files.

### Version 4.1.0 (2023-09-22)

- Added: Just like before, you can press <kbd>↑</kbd> and <kbd>↓</kbd> to select a command. Now, you can now press <kbd>←</kbd> to select the indicator (emoji) of the current command, as well as for all other commands with the same indicator (emoji)! This is the most useful if you’ve created a [JSON file for your commands](https://github.com/lydell/run-pty#advanced-mode), with custom status indicators. For example, maybe you use 🚨 to indicate that a watcher is running but that there’s an error. You can now easily select all commands with the 🚨 indicator, and then press <kbd>enter</kbd> to restart them.

### Version 4.0.4 (2023-08-09)

- run-pty now works on Node.js 20, by upgrading the node-pty dependency to 1.0.0. I haven’t found any breaking changes in that major version bump that results in breakage for run-pty users.

### Version 4.0.3 (2022-10-29)

- Fixed: An edge case with “kill all”.

  First, a re-cap on how run-pty works. run-pty runs commands. Commands can exit. If all commands exit (by themselves, or because you killed them each separately with <kbd>ctrl+c</kbd>), run-pty keeps running, letting you restart the commands.

  When you press <kbd>ctrl+c</kbd> to kill _all_ commands, run-pty tells every command that they should exit and sets a flag that run-pty should exit itself once all commands have exited, called `attemptedKillAll`. If you restart one or more commands before all commands have exited – what does that mean? Well, it probably means that you changed your mind and want to keep running run-pty.

  Previously, the `attemptedKillAll` flag would still be set in that situation. Which means that if all commands then exit, run-pty would exit too – which is inconsistent. It should keep running and let you restart the commands.

  This version resets the flag `attemptedKillAll` if you restart any command. In other words, it no longer counts as having attempted to kill all commands if you restart something.

### Version 4.0.2 (2022-10-11)

- Improved: Optimized dashboard rendering. run-pty now avoids re-drawing lines that are identical to the previous render. This reduces flicker, for example in iTerm2 (without GPU rendering) and Windows Terminal, and it makes re-drawing noticeably faster in cmd.exe.
- Improved: Support for the ANSI escape codes programs can use to ask the terminal for which colors it uses. run-pty needs to be aware of such “request” escape codes so programs work correctly when in the background.

### Version 4.0.1 (2022-09-18)

- Fixed: run-pty no longer breaks certain ANSI color codes and prints parts of them as text rather than changing the color. This happened if the command you’re running for some reason didn’t print whole color codes in one go. It’s actually valid to print the first half, potentially wait for a little while, and then print the rest! Terminals still change the color when the rest comes in. This is also true for other escape codes, like cursor movements, which run-pty also need to detect and previously could miss out on if they came split up in different chunks. run-pty now handles this by buffering unfinished escape codes until they are complete.
- Improved: run-pty looks for escape codes that clear the screen, for example to determine if the command is a “simple log” or not (which allows for printing the keyboard shortcuts at the bottom). This now works even if the clear escape codes aren’t at the very end of a written chunk.
- Improved: Writing a newline and then moving the cursor up one line now still counts as a “simple log” (so the keyboard shortcuts at the bottom still show). `docker-compose` does this sometimes to update the previous line, but it’s still a “simple log”. The keyboard shortcuts are always printed on the next line, so there’s nothing downwards that could be overwritten.

### Version 4.0.0 (2022-08-28)

- Removed: [NDJSON](https://github.com/ndjson/ndjson-spec) support. I used to have a `bash` script that generated JSON for run-pty in a hacky way, one line at a time. I’ve since re-written that script (using Node.js) and it became so much better! So I don’t need this feature myself anymore, and also realized that it is kind of an anti-feature: It’s better to write good scripts that generate JSON in a nice way! This change also allows for configuring more than the commands in the future.

- Fixed: `j`, `k` and `o` now work properly. run-pty used to have secret Vim key bindings, that I had forgotten about. Recently I added so many commands to run in a project that I got all the way down to `o` for the command labels. I then noticed that pressing for example `j` didn’t focus that command as expected – instead it moved the selection down, as if I had pressed the down arrow key. That’s because `j` means down in Vim, while `k` means up, and `o` was used as an alternative to `Enter`. Adding those back in the day I didn’t think about that they would conflict with the command labels. Anyway, with this release those secret Vim key bindings are gone, solving the problem.

- Added: The `--auto-exit` flag. This new flag is for conveniently running a couple of commands in parallel and get to know once they are done.

  ```bash
  run-pty --auto-exit % npm ci % dotnet restore && node build.js
  ```

  See the readme for more information!

- Improved: Output on Windows.
  - [Windows Terminal](https://aka.ms/terminal) is now detected, because it supports emojis and a few more ANSI escape codes than the old cmd.exe. So Windows Terminal users now get nicer-looking output!

  - Fixed an issue where output could be cut off. For example, `run-pty % ping localhost` many times printed “eply” instead of “Reply”.

  - The keyboard shortcuts are now visible at the bottom of the command output in more cases. Well, at least in Windows Terminal. In cmd.exe, the keyboard shortcuts now only show up if the last line of output is empty. Either way, in both cases I managed to find a workaround for a “conpty” behavior that previously caused the keyboard shortcuts not to show up where they would have on macOS or Linux.

    (The reason the keyboard shortcuts are only shown when the command output ends with an empty line is because cmd.exe simply does not seem to support the ANSI escape code needed for a non-empty line. I did not know that before – that’s why some output was cut off sometimes as mentioned before. Oh, and which ANSI escape code is that you wonder? Well, one can use `\f` or `\x1BD`. The former – which run-pty used to use – is supported on most macOS and Linux Terminals, the latter is supported in Windows Terminal as well as on macOS and Linux, while neither is supported in cmd.exe.)

- Changed: If using a JSON file where `cwd` and `title` are equal, run-pty used to not print the cwd. Now it does. I think that makes more sense.

- Fixed: If you put color escape codes in `title`, and then use `NO_COLOR`, the color escape codes are now removed in the dashboard. Previously, they were only removed when focusing the command.

### Version 3.0.0 (2022-03-06)

- Added: The `killAllSequence` JSON field for commands. When you use “kill all” run-pty sends <kbd>ctrl+c</kbd> to all commands. However, not all commands exit when you do that. In such cases, you can use `killAllSequence` to specify what sequence of characters to the command to make it exit. This lets you cleanly exit commands, rather than double pressing <kbd>ctrl+c</kbd> which force kills them.
- Improved: Showing the keyboard shortcuts at the bottom of commands is now much more reliable. Instead of using complicated and fragile home grown regex and string slicing approaches, run-pty now uses the “save cursor” and “restore cursor” ANSI escapes codes which seem to exist for this very use case. For example, this fixes problems where background colors could “bleed” into other lines, or parts of the output became duplicated.
- Improved: ANSI escape codes allow programs to do things like changing colors or moving the cursor. There are also a few codes that work a little bit differently. When written, they don’t cause a state change. Instead, they cause the terminal to respond with information (in the form of other escape codes) on stdin. I’ve learned that run-pty needs to handle these differently. When you switch the focused command in run-pty, it can simply re-print the entire history of the command, including color escape codes which will work just fine. However, the codes that request a response should not be repeated like that, because the program might not be in a state where it expects a response anymore. run-pty now handles a few such escape codes, by making sure they only happen once and immediately. This fixes a problem where Vim would receive some “crap input” every time you switched from the dashboard to Vim. Also, run-pty already had some ad-hoc code related to this as a Windows special case. That’s now replaced with a more general solution.

Note: There are technically no breaking changes. You should be able to update without making any further changes. But since all the ANSI escape code stuff is pretty tricky, I’m bumping the major version so you can take the decision if you’re fine with potential issues right now. If anything, the rendering should be more stable than before, but just in case!

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
