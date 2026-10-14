# Release status

Target: homepl-email-mcp v0.1.0 for a small Windows-based company using home.pl.
The supported result is a local MCP connector with guided credential entry and
access to all retained server mail, raw messages, metadata and attachment files.

Implemented: account setup; OS credential storage; folder listing; all-history
UID pagination and search; ordered repeated headers; MIME metadata and body files;
raw .eml and attachment download; prepare/send/reply/reply-all/forward; server
drafts and updates; flags; move/copy/trash; exact permanent deletion; folder management.

Validation: all 43 automated tests passed in [CI run 38644428031](https://github.com/borystam/homepl-email-mcp/actions/runs/38644428031)
on Windows with Node.js 22 and 24, and macOS and Ubuntu with Node.js 24. Tests
include actual loopback IMAP/SMTP and MCP protocol/stdio checks. Native credential
store round trips passed on Windows and macOS; Linux Secret Service persistence
was not exercised in CI. Independent review prompted a fix retaining Bcc metadata
in Sent copies. A clean public clone on macOS passed a production-only dependency
installation (`npm ci --omit=dev --ignore-scripts`), native-binding diagnostics,
and the real stdio MCP launch test. Dependency audit reported zero vulnerabilities.
The empty local setup form was visually checked; no credentials were entered.
The repository is public, with release distribution limited to tracked source files.

Not yet verified: a real home.pl mailbox. No live customer email was read or sent.
Provider-specific folder names and external-client access must be checked during
the first employee's guided setup. Setup tests IMAP and SMTP authentication without
sending a message.

Next observable outcome: the first employee completes local setup on Windows,
saves their mailbox credential through the private form, and successfully calls
MCP tools to list folders and read sample message metadata without sending or
changing mail.

Long-running review cadence: implementation began 2026-10-14 at approximately
21:46 UTC. Convene the three-person independent council if active work reaches
22:16 UTC; do not count idle time toward the cadence.
