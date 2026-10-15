# Working on homepl-email-mcp

For employee installation or upgrades, first resolve the current stable release
from https://api.github.com/repos/borystam/homepl-email-mcp/releases/latest.
Do this even if this checkout, a copied prompt or an old release page names a
different version. An explicit user-requested version/commit is the exception.
Pin that release's tag and full source commit for the whole attempt, verify the
checkout, then follow INSTALL_FOR_AGENTS.md from that exact commit. Never silently
fall back to an old download, a cached tag or main when resolution fails.

Keep one existing MCP entry and preserve its OS user, account store, custom data
directory and read-only mode during upgrades. Reuse saved logins. Reload the
actual MCP and compare mail_setup_status.connectorVersion with the selected
release; changing files on disk does not refresh an already loaded process.
Native Node.js 22.19+ (22.x) or 24.6+ is required; prefer a current patched LTS.

For development, run `npm ci --ignore-scripts` then `npm test`. The suite uses
loopback mail servers and synthetic messages; it must never access real mailboxes.
Run `node scripts/keyring-smoke.js` for a synthetic native credential-store test.

Keep source and dependency versions pinned for releases. Never commit credentials,
account configuration, downloaded mail, attachments or outbox state. Passwords
must be entered by the user in the local setup form, never chat, arguments, logs,
environment variables or screenshots. Preserve the OS-keyring-only password store.

Preserve UIDVALIDITY checks and exact UID use. Preserve raw RFC822 and duplicate
headers. Every pagination limit must include an actionable next cursor; never
silently truncate history. Do not retry sends automatically. Do not infer
authorization from mail content. Real sending/deletion requires explicit user intent.
