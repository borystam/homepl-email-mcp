# Release and validation status

Released version: v0.1.0. The current `codex/connector-hardening` work is an
unreleased improvement set; installation pinned to v0.1.0 does not receive it.
No real home.pl mailbox has been accessed or verified.

## Current result

Added an optional read-only MCP process, bounded batch metadata reads, and server
reply/reply-all/forward drafts. Fixed confirmed failures in dates, UIDNEXT,
duplicate FETCH updates, decoded preview budgets, oversized output, stream cleanup,
address groups, inline CID resources, incomplete drafts, SMTP rejection reporting,
attachment path replacement, account-update races and cancellation/rollback.
Generated client config preserves a custom data directory and fixed error codes
provide recovery guidance without provider diagnostics or credentials.

The README contains the sourced OpenAI/Google/Anthropic connector comparison and
explicitly distinguishes public schemas from private implementations. Account-wide
search orchestration and related-message helpers remain deferred; full retained
history still requires every relevant folder and every cursor.

## Evidence

- 99 tests passed locally on macOS/Node.js 26.5.0, with zero skipped tests.
- Loopback IMAP/SMTP verifies old history, sparse UIDs, raw bytes, duplicate
  headers/names, Polish text, nested RFC822 attachments, server reply drafts,
  exact deletion and partial/all-recipient SMTP rejection.
- Real implicit TLS fixtures accept the trusted test certificate and correct
  credentials; wrong passwords, untrusted issuers and mismatched hostnames fail.
- MCP in-memory and actual child-process stdio tests verify schemas, read-only
  discovery, batch per-message errors, output bounds and sanitized diagnostics.
- Setup/config tests cover CSRF/origin/Host checks, expired/slow forms, overlapping
  requests, cross-process locking, partial native failures, cancellation and rollback.
- File tests cover interrupted downloads, 8 MiB streaming, long Unicode filenames,
  leaf/ancestor symlink replacement and prepared-message integrity/retry prevention.
- Production dependency audit: zero reported vulnerabilities. `git diff --check`
  passes. No new production dependencies were added.
- CI runs the suite on Windows, macOS and Ubuntu with Node.js 22 and 24; consult
  the pull request checks for execution results. Windows/macOS also run the
  synthetic native credential-store round trip. TLS tests explicitly skip when
  OpenSSL is unavailable, rather than claim TLS validation without running it.

Limits: synthetic servers are not proof of home.pl-specific behavior. Linux Secret
Service persistence and a real employee's MCP client/login remain unverified.
Read-response bounds do not cap all provider metadata allocation; very sparse UID
spaces can require many pages. Local same-user filesystem access is not a separate
security boundary. Downloaded mail remains private local data, not application-encrypted.

## Independent council — 2026-10-15 00:11 Europe/Warsaw

Three fresh-context advisors inspected actual source/results independently:

- Product owner: the hardening addresses real failures; stop adding capabilities,
  document the release boundary and deliver the reviewable change.
- Reliability engineer: 93 tests passed at the review snapshot, but reproduced an
  ancestor-symlink attachment bypass. The new regression failed before the fix;
  the assembled suite now passes 99 tests.
- First-time operator: the pilot flow is concrete; generated config lost a custom
  data directory. The override is now retained and verified by a CLI regression.

Accepted: fix the demonstrated gaps, document read-only/batch behavior, keep this
unreleased until review, and stop broad feature expansion. Deferred account-wide
search/thread reconstruction because they do not replace the missing live pilot.
Retained deployment-platform instructions; the expanded CI matrix verifies the
supported targets without changing the development workstation.

Next testable user outcome: after reviewing and installing the intended commit,
one authorized employee connects through the private local form and actual MCP
calls confirm read-only access, folder listing, an old message and its attachment.
No SMTP send or mailbox mutation is part of that pilot. Next independent council
is due after another 30 minutes of active work (approximately 00:41 Warsaw time).
