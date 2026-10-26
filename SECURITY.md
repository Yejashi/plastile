# Security policy

Plastile runs inside KWin, the compositor of your Plasma session, so a bug in it can affect your whole desktop.
Security reports are taken seriously.

## Supported versions

Only the latest release, and `main`, receive fixes. Plastile is in alpha; there is no long-term support branch.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub:
**Security → Report a vulnerability** on the
[repository page](https://github.com/Yejashi/plastile/security/advisories/new).

Include what you found, how to reproduce it, the Plastile commit or version and your KWin version. You should
receive an answer within a week. Once a fix is available, the advisory is published with credit to you unless
you prefer otherwise.

## Scope

Of particular interest:

- Anything that lets another process or a window's own properties (title, application id) make Plastile run
  code, write files or call D-Bus methods it should not.
- The `plastile-state` helper (`helper/`): its D-Bus interface and the files it writes under
  `~/.local/state/plastile/`.
- Configuration parsing: Plastile's configuration is data only, and must never become executable.
- Diagnostics leaking private data (window titles, file paths) into logs or traces.

A window or application that can make Plastile misplace windows is an ordinary bug; please file it in the issue
tracker.
