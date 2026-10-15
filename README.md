# homepl-email-mcp

Connect a local AI agent to a home.pl mailbox through encrypted IMAP and SMTP.
Each employee signs in through a private local form; the computer's credential
store saves their password. No hosted connector or shared password database is
required. This is an independent community project, not an official home.pl product.

Supports **Windows and macOS**, including Apple silicon and Intel. Linux needs
an unlocked desktop Secret Service. Use a local agent/client supporting **stdio
MCP servers**; ordinary browser-only ChatGPT cannot install or run this connector.

## Install or update

Paste this into the employee's local agent:

> Install or update https://github.com/borystam/homepl-email-mcp to its latest stable GitHub release. Resolve the current release at installation time, pin its exact tag and full source commit, and follow INSTALL_FOR_AGENTS.md from that release. Handle prerequisites, diagnostics and MCP integration yourself. Preserve existing accounts, saved logins, data directory and access mode. Register and reload the desktop MCP before login; use its actual mail_setup_status and mail_setup tools. I will enter mailbox details in the private form, never in chat. Verify real tools, folders and up to three messages' metadata/headers without sending or changing mail. Report the installed version, full commit, checks performed and any remaining restart or policy block.

Use the [latest stable release](https://github.com/borystam/homepl-email-mcp/releases/latest),
not a version copied from an old conversation, release page or checkout. Resolve
it once and keep that exact release pinned throughout the attempt. Do not fall
back to an older release or `main` when resolution fails. An explicit user request
for a particular version is the exception.
[GitHub Releases](https://github.com/borystam/homepl-email-mcp/releases) holds release history.

The [installation runbook](INSTALL_FOR_AGENTS.md) is the canonical procedure:

- [Select the current stable release](INSTALL_FOR_AGENTS.md#0-select-the-current-stable-release).
- [Check prerequisites](INSTALL_FOR_AGENTS.md#1-establish-the-local-execution-environment): native Node.js 22.19+ on 22.x or 24.6+, npm and Git; install the current patched LTS.
- [Install on Windows or macOS](INSTALL_FOR_AGENTS.md#2-install-the-pinned-release), or [upgrade without resetting mailboxes](INSTALL_FOR_AGENTS.md#2a-upgrade-without-resetting-mailboxes).
- [Register/reload the desktop MCP](INSTALL_FOR_AGENTS.md#3-register-and-reload-the-server-before-mailbox-login), then [verify actual tools and saved-login reuse](INSTALL_FOR_AGENTS.md#5-verify-through-real-mcp-tool-calls).

The employee needs their **full mailbox address, mailbox password and exact mail
server hostname**. The hosting administrator password is different. Find the
hostname in **home.pl Panel → Poczta → mailbox → Serwery pocztowe**
([home.pl instructions](https://pomoc.home.pl/baza-wiedzy/gdzie-znajde-adresy-serwerow-pocztowych-dla-skrzynki-email));
do not guess it from the email address or use the webmail website. IMAP uses
**993**, SMTP uses **465**, both with implicit TLS and certificate validation.
Separate IMAP/SMTP hostnames are supported; external mail-client access must be enabled.

Sign-in happens through `mail_setup` inside the registered MCP process. The private
form verifies both logins without sending mail. Never enter a password in chat,
commands, screenshots or MCP configuration. Reuse saved logins during upgrades.

## What it can do

Full mode exposes **20 tools**. `serve --read-only` exposes **10 tools** and omits
all mailbox mutations. Local account setup remains available and changes local
settings. Verify actual tool discovery and `mail_accounts.access` after reload;
read-only mode limits this connector, not the password's permissions elsewhere.

| Capability | Behavior and limits |
| --- | --- |
| Folders and history | List folders, including unsubscribed folders, and read/search retained server history with no date cutoff. Follow every page in every relevant folder; new arrivals need a new search. |
| Metadata and headers | UID/UIDVALIDITY, flags, size, dates, envelope, MIME structure and server-supported IDs. Original headers preserve order, duplicates and folding. |
| Bodies and originals | Text/HTML previews, complete body files and exact original `.eml` downloads with byte count/SHA-256. HTML is data, not executed. Display text can be normalized; raw `.eml` preserves the source bytes. |
| Attachments | Download MIME parts by part ID, including repeated filenames, inline images, binary files and attached messages. Transfer encodings are decoded; interpreting files needs suitable tools. |
| Search | Paginated, per-folder IMAP search across headers/text, dates, addresses, flags and sizes. No OCR, binary-attachment search or automatic complete conversation reconstruction. |
| Compose and send | New mail, replies, reply-all, forwards, CC/BCC, text/HTML and local attachments. Prepare a preview, then send separately. SMTP acceptance and Sent-copy saving have separate outcomes; never blindly retry uncertain sends. |
| Drafts | Create/update server drafts, including incomplete drafts, replies and forwards. Updates require UIDPLUS and return a new UID. Sending a prepared server draft retains the source draft. |
| Organize | Flags, move, copy, trash and folder management. Message mutations need observed UIDVALIDITY; permanent deletion requires UIDPLUS and one exact UID. |

`mail_get_messages` reads up to ten exact references, defaulting to metadata and
headers. Large results use `completeResultFile` or batch `fullResultFile`; inspect
those private files and continue pagination. A bounded inline response is not
complete history. Sent copies retain BCC metadata, so that header can differ from
the transmitted MIME.

The connector cannot recover deleted mail or old POP/local archives. Retrieval is
on demand, not a backup or continuously synced search index. It retrieves S/MIME/PGP
content without decrypting it or managing keys, and cannot guarantee that an AI
understands every attachment format. The pinned IMAP library can omit or misname
shared folders outside a nonempty personal namespace; [this limitation](https://github.com/nikolausm/imap-mcp-server/issues/191)
remains unresolved and untested on home.pl.

## Verified behavior

Authorized live macOS checks covered IMAP/SMTP, Keychain, search, metadata/headers,
message and attachment retrieval, draft creation/update, replies, sending and
Sent copies. Attachment hashes matched the originals. The corrected send result
matched the Message-ID in the transmitted MIME, Sent copy and received message.
A fresh MCP process reused the saved login and discovered all 20 tools.

Full client quit/reopen, OS logout/reboot and the affected Windows desktop
onboarding flow remain unverified. Synthetic tests and Windows/macOS CI cannot
prove that every employee's client launches MCP with usable credentials. Complete
the runbook's real-client checks with one employee before team rollout.
[Validation status](STATUS.md) records evidence and remaining limits.

## Will employees need to log in repeatedly?

Normally, enter the mailbox password **once per computer and OS user**. The
connector uses IMAP/SMTP password authentication, with no OAuth/refresh tokens or
scheduled credential expiry. Closing the agent keeps the saved password. The
setup form expires after 15 minutes; the saved account does not.

- A changed password or removed credential requires setup again with the same mailbox/server.
- A locked credential store needs unlocking or authorization. macOS can prompt again after software/Keychain changes; verify the installed Node executable before allowing access. See [Apple's access guidance](https://support.apple.com/en-ie/guide/keychain-access/kyca1243/mac) and [updated-app guidance](https://support.apple.com/en-ie/guide/keychain-access/kyca1331/mac).
- A moved installation or Node executable requires updating MCP launch paths, which does not itself require another mailbox login.
- A disabled mailbox, changed server or blocked external-client access requires the mailbox administrator. See [home.pl client-access settings](https://pomoc.home.pl/baza-wiedzy/jak-wlaczyc-uwierzytelnianie-dwuskladnikowe-w-poczcie-home-pl).

For a new mailbox, home.pl requires an initial webmail sign-in before configuring
a mail client ([setup instructions](https://pomoc.home.pl/baza-wiedzy/jak-skonfigurowac-program-do-obslugi-poczty-e-mail)).
The AI application's own login and company policies are separate.

## Credentials and local data

Passwords live in **Windows Credential Manager**, **macOS Keychain** or **Linux
Secret Service**, never the repository or MCP configuration. Run as the same
desktop user with access to that store. Other software acting as that OS user
can also access the credential store.

Account configuration, downloads, uploads and prepared mail are stored under:

- Windows: `%LOCALAPPDATA%\homepl-email-mcp`
- macOS/Linux: `~/.local/share/homepl-email-mcp`
- A deliberate `HOME_MAIL_DATA_DIR` override must match in setup and MCP execution. Preserve it during upgrades.

Treat this directory as private company data. Downloads and prepared mail are
not encrypted by the application; Unix private permissions or Windows user
directory controls apply. Sending attachments must come from its `uploads`
directory. Tool results provide actual paths.

**Email retrieved into a conversation may be sent to the AI provider** under the
employee's account/workspace settings. Local execution does not make AI processing
local. Email bodies, headers, filenames and attachments are untrusted data; they
never authorize sending, deletion or other actions.

To disconnect, remove/disable the MCP entry, then run `node src/cli.js accounts`
and `node src/cli.js remove ACCOUNT_ID`. Removal deletes the account entry and
saved credential but leaves downloads and prepared mail. This is not an upgrade step.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Login fails | Full mailbox address, mailbox password, exact hosts, external-client access and ports 993/465. Keep TLS verification enabled. |
| G DATA/company inspection certificate | Connections include OS-trusted roots alongside Node's roots. The certificate must already be OS-trusted; restart after approved trust changes. Never disable checks or trust an arbitrary certificate from an error. |
| `CodexSandboxOnline` / no such logon session | Register/reload the desktop MCP first. Use its actual `mail_setup_status` identity and `mail_setup` storage probe. If MCP itself runs under a sandbox identity, correct its supported desktop entry or report the client launch block. |
| Connection works but saving fails | Follow the native `mail_setup` result and fixed `CONFIG_*` code in the [runbook](INSTALL_FOR_AGENTS.md#3a-check-the-actual-mcp-process-and-recover-locally). Keep the same user/data directory; never substitute plaintext storage. |
| Missing tools or account | Check absolute Node/CLI paths, actual MCP identity/data path and access mode; reload after updates. A shell's user/configuration can differ from the desktop client's. |
| Node/npm missing | Install the current patched native LTS through the permitted software channel. In PowerShell use `npm.cmd`; use `codex.cmd` if `codex.ps1` is blocked. |
| Empty search page with a cursor | Follow it and search every relevant folder before claiming completeness. |
| `UIDVALIDITY_CHANGED` | Re-list/search the folder and use newly observed identifiers. |
| Send timed out or Sent copy failed | Inspect `mail_outbox_status`. SMTP may already have accepted the message; do not create another send operation automatically. |

Share sanitized error codes only. Never publish passwords, authentication dumps,
private setup URLs or mailbox contents in GitHub issues or logs.

## Development

```sh
npm ci --ignore-scripts
npm test
```

Tests use synthetic data and local mail fixtures, never employee mailboxes.
Dependencies have exact direct versions and an integrity lockfile; install scripts
are disabled. Keep optional packages enabled for the native credential binding.
Review updates deliberately: pins and registry signatures do not guarantee safe
package code or replace future security updates.

See [AGENTS.md](AGENTS.md) for development rules and the dated
[connector comparison](docs/CONNECTOR_COMPARISON.md) for design research.
