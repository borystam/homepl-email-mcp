# Working on homepl-email-mcp

For employee onboarding, read INSTALL_FOR_AGENTS.md. Node.js >=22 is required.

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
