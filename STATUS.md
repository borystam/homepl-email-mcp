# Release status

Target: homepl-email-mcp v0.1.0 for a small Windows-based company using home.pl.
The supported result is a local MCP connector with guided credential entry and
access to all retained server mail, raw messages, metadata and attachment files.

Implemented: account setup; OS credential storage; folder listing; all-history
UID pagination and search; ordered repeated headers; MIME metadata and body files;
raw .eml and attachment download; prepare/send/reply/reply-all/forward; server
drafts and updates; flags; move/copy/trash; exact permanent deletion; folder management.

Validation: 43 automated tests pass on the development macOS host, including
actual loopback IMAP/SMTP and MCP protocol/stdio checks. Native macOS Keychain
smoke test passed. Independent review found and prompted a fix for retaining
Bcc metadata in Sent copies. Windows/Linux CI and clean installation are next.

Not yet verified: a real home.pl mailbox. No live customer email was read or sent.
Provider-specific folder names and external-client access must be checked during
the first employee's guided setup. Setup tests IMAP and SMTP authentication without
sending a message.

Next observable outcome: a clean Windows installation can save a synthetic password
in Credential Manager and complete the full local IMAP/SMTP/MCP test suite.

Long-running review cadence: implementation began 2026-10-14 at approximately
21:46 UTC. Convene the three-person independent council if active work reaches
22:16 UTC; do not count idle time toward the cadence.
