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
