# homepl-email-mcp

Connect a local AI agent to a home.pl mailbox through encrypted IMAP and SMTP. Each employee installs the connector on their own computer and signs in once through a private local form. No hosted connector or shared password database is required.

Windows and macOS (Apple silicon and Intel) use the same connector and tools.
See the [Windows installation](#manual-installation-on-windows) or
[Mac installation](#manual-installation-on-macos).

This is an independent community project, not an official home.pl product. Version **0.2.1** includes the setup and reliability fixes described below. One authorized live Mac pilot verified IMAP/SMTP, macOS Keychain, discovery of all 18 MCP tools, folder and metadata/header reads, and saved-login reuse by a fresh process. The desktop app also loaded the native tools and successfully called `mail_accounts` and `mail_folders`. A full app quit/reopen and OS logout/reboot remain unverified. Pilot the intended version with one employee before repeating installation for the team.

## Changes in v0.2.1

- Mail connections automatically use OS-trusted roots alongside Node's existing
  roots. This supports installed G DATA or company mail-inspection certificates
  without exporting certificates or disabling TLS/hostname validation.
- Setup checks the actual local data directory and a temporary OS-keyring entry
  before opening the password form. Storage failures have fixed, safe codes so
  the installing agent can diagnose them without reading the mailbox password.
- The agent installation runbook covers prerequisites, storage recovery, client
  integration and verification. Use `doctor --storage` for a credential-free
  storage check. Node.js 22.15+ (22.x) or 24+ is required.

## Changes in v0.2.0

Version **v0.2.0** includes these improvements over the initial v0.1.0 release:

- Native browser setup no longer rejects its own form POST with “Forbidden”.
  Verification errors now identify the failing IMAP/SMTP stage with fixed safe
  messages, without exposing provider diagnostics or credentials.
- `serve --read-only` exposes only mailbox reading tools. `config --read-only`
  generates the corresponding client settings; write tools are absent from the
  MCP catalog. This limits this connector process, not the mailbox password's
  permissions in other applications. Default `serve` retains full functionality.
- `mail_get_messages` reads up to ten exact message references in one call,
  preserving input order and a separate result/error for each. It defaults to
  metadata and headers; request bodies explicitly.
- Read results exceeding 64 KiB are saved completely to private JSON files.
  Follow `completeResultFile` (or batch `fullResultFile`) for full data and keep
  following pagination. A shortened inline response is not missing history.
- `mail_save_draft` supports new/reply/reply-all/forward drafts, including
  incomplete drafts, reply threading and original forward attachments.
- Search dates, duplicate server updates, setup cancellation, credential rollback,
  attachment paths and partial SMTP failures have additional regression coverage.
- Multiline drafts and Sent copies use CRLF line endings for strict IMAP servers.
  Replies retain a single known ancestor even when the parent lacks References.
  Explicit SMTP authentication/message rejections report known failure; disconnects
  or timeouts after transmission still report an unknown outcome.

For a read-only installation, register the server with `serve --read-only`
(or merge `node src/cli.js config --read-only`). Check `mail_accounts.access` is
`read-only` and that sending/deletion tools are absent.

## Give this to the employee's agent

Paste this into **an agent with access to the employee's computer and support for local stdio MCP servers**:

> Install or update https://github.com/borystam/homepl-email-mcp to release v0.2.1 on this computer. Read and follow INSTALL_FOR_AGENTS.md from that exact release. Handle missing prerequisites, dependency installation, automatic certificate trust, storage checks and repair, and MCP integration in this agent. Perform diagnostics yourself; do not ask me to run commands. I will enter my mailbox details myself in the private local setup form; never ask for my password in chat or screenshots. Verify actual MCP tools, folders, and metadata/headers for up to three messages without sending or changing mail. Reuse any saved login. Report the installed version and actual verification results, including anything blocked by a real OS or organization policy.

The employee needs their **full mailbox email address, mailbox password and exact mail server hostname**. The home.pl hosting administrator password is not the mailbox password.

Ordinary browser-only ChatGPT cannot run this local installer or read local Codex configuration. Use a local agent/client that exposes stdio MCP tools. Client and workspace policies determine whether those tools are available. See [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

## What it can do

| Capability | Included behavior and limits |
| --- | --- |
| Folders and history | Lists folders exposed by the IMAP client's namespace handling, including unsubscribed folders. Reads and searches retained history in those folders, with no automatic date cutoff. Follow every page in every relevant folder; new arrivals require a new search. Shared folders outside the personal namespace need verification; see the limitation below. |
| Message metadata | UID and UIDVALIDITY, flags, size, internal date, envelope, MIME structure and additional IDs when supported by the server. Original headers preserve order, duplicates and folding; oversized headers remain available in a complete local file. |
| Bodies | Bounded text/HTML previews plus complete body files. HTML is returned as data, not executed. Display text may undergo charset conversion or flowed-text normalization. |
| Original messages | Streams a complete original `.eml` with all headers and MIME content; returns a local path, byte count and SHA-256. This is the byte-preserving source of truth. |
| Attachments | Downloads arbitrary MIME parts by part ID, including inline images, binary files and attached messages. Repeated filenames are unambiguous. MIME transfer encodings are decoded; inline display text can be normalized. The agent needs suitable file tools to interpret downloaded content. |
| Search | IMAP search across headers and message text, with dates, addresses, flags and size filters. Searches are per folder and paginated. It does not OCR images or search inside binary attachments. Header searches can find related messages; there is no claim of automatic complete conversation reconstruction. |
| Compose and send | New mail, replies, reply-all, forwards, CC/BCC, text/HTML and local attachments. A prepared operation has a preview and a separate send action. The transmitted MIME is retained locally; Sent copies retain BCC metadata and therefore can differ by that header. SMTP acceptance and Sent-copy saving are reported separately; uncertain sends must not be retried blindly. |
| Drafts | Save and update new/reply/reply-all/forward server drafts, including incomplete drafts, then prepare them for sending. Updating requires UIDPLUS and returns a new UID. Sending a prepared server draft retains the source draft. |
| Organize | Flags, move, copy, trash; create, rename, subscribe, unsubscribe and delete folders. Message mutations require observed UIDVALIDITY. Permanent message deletion requires UIDPLUS and targets one exact UID. |

The connector cannot recover mail already deleted from the server or mail kept only in an old POP/local archive. It can retrieve encrypted S/MIME/PGP content, but does not decrypt it or manage decryption keys. It does not guarantee that an AI can interpret every file format. Retrieval is on demand, not an automatic mailbox backup or a continuously synchronized search index.

On servers with a nonempty personal namespace prefix, the pinned IMAP library
can omit or incorrectly prefix shared folders outside that namespace. This matches
[a reported issue in another ImapFlow-based MCP](https://github.com/nikolausm/imap-mcp-server/issues/191).
Shared-namespace coverage remains unresolved; it has not been tested on home.pl.

## Manual installation on Windows

Use native Windows Node.js **22.15+ on the 22.x line, or 24+**, npm, Git, and a local MCP-capable agent. Run the connector as the employee's normal desktop user so it can use that user's credential store. An administrator or a different OS account would have different settings and credentials.

In PowerShell, choose a persistent installation directory:

```powershell
$homeplRepo = Join-Path $env:LOCALAPPDATA "Programs\homepl-email-mcp"
New-Item -ItemType Directory -Force (Split-Path $homeplRepo) | Out-Null
git clone --branch v0.2.1 --depth 1 https://github.com/borystam/homepl-email-mcp.git $homeplRepo
Set-Location $homeplRepo
npm.cmd ci --omit=dev --ignore-scripts
node src/cli.js doctor
node src/cli.js setup
```

If that directory already exists, inspect its remote and version before reusing it; do not overwrite it. `npm ci` uses the committed dependency lockfile. Keep the installation directory in place after registration.

The setup command opens a short-lived `http://127.0.0.1:…` form. **Type the password directly into that form, never into a chat, command, configuration file or screenshot.** Leave the setup process running until it confirms connection. It verifies both logins without sending an email.

Use the exact server hostname shown in **home.pl Panel → Poczta → mailbox → Serwery pocztowe** ([home.pl instructions](https://pomoc.home.pl/baza-wiedzy/gdzie-znajde-adresy-serwerow-pocztowych-dla-skrzynki-email)). For example, a server may be named `serwer123456.home.pl`; the example is not a default. `poczta.home.pl` is the webmail website, not a hostname to guess for IMAP. IMAP uses **993**, SMTP uses **465**, both with implicit TLS and certificate validation. If SMTP has a different hostname, enter it in Optional settings. External mail-client access must be enabled for the mailbox.

Optional Sent, Drafts and Trash folder names use their exact server paths. Setup attempts to discover their roles; verify the resulting folders before using write operations.

Register with Codex using absolute paths:

```powershell
$homeplNode = (Get-Command node.exe).Source
$homeplCli = (Resolve-Path .\src\cli.js).Path
codex mcp add homepl-email -- $homeplNode $homeplCli serve
codex mcp list
```

If the Codex CLI is unavailable, run `node src/cli.js config`. It prints a ready-to-merge Codex TOML entry and a JSON `mcpServers` entry for clients that use that format, with this machine's absolute paths. Merge the appropriate entry into existing client settings; do not replace the whole settings file. No mailbox password belongs in either configuration. An explicit `HOME_MAIL_DATA_DIR` is retained in the generated client `env` settings so a separately launched desktop client uses the same account store. [Official Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

Restart or reload the client as its MCP configuration requires. A configuration entry alone does not prove the connection works: ask the agent to call `mail_accounts`, `mail_folders`, and `mail_list_messages` with `pageSize: 3`. It can inspect headers using `mail_get_message` with `includeBodies: false`. Initial verification should not send, change or delete any mail.

## Manual installation on macOS

Use Node.js **22.15+ on the 22.x line, or 24+** for the Mac's native architecture, npm, Git, and a
local MCP-capable agent. Run as the employee's usual desktop user, without `sudo`.
In Terminal, choose a persistent directory (keep it after setup):

```sh
homeplRepo="$HOME/Library/Application Support/homepl-email-mcp/app"
mkdir -p "$(dirname "$homeplRepo")"
git clone --branch v0.2.1 --depth 1 https://github.com/borystam/homepl-email-mcp.git "$homeplRepo"
cd "$homeplRepo"
npm ci --omit=dev --ignore-scripts
node src/cli.js doctor
node src/cli.js setup
```

Inspect an existing directory before reusing it. Setup opens the same private
local form described above; enter the mailbox password there yourself. The
password is saved in **macOS Keychain**. If macOS asks to permit this installed
Node executable to access the connector's Keychain item, verify the request;
choosing **Always Allow** grants future access to that item. Do not grant access
to an unexpected executable or disable Keychain protection.

Register with Codex using absolute paths, after checking for an existing entry:

```sh
homeplNode="$(node -p 'process.execPath')"
codex mcp add homepl-email -- "$homeplNode" "$homeplRepo/src/cli.js" serve
codex mcp list
```

If the CLI is unavailable, or you use a custom data directory, run
`node src/cli.js config` and merge the appropriate generated configuration as
described above. Reload the client and verify actual `mail_accounts`,
`mail_folders` and metadata reads. Then fully quit and reopen the client and
repeat a read **without running setup again**. This checks the installed client's
access to saved credentials, not just the terminal's access.

On Linux, use the same npm commands in a persistent per-user clone. Linux needs
an unlocked Secret Service in the desktop session; a headless shell alone is
insufficient.

## Will employees need to log in repeatedly?

Normally, enter the mailbox password **once per computer and OS user**. This
connector uses password authentication for IMAP/SMTP, not OAuth, access tokens,
refresh tokens or webmail cookies. It has no scheduled credential expiry and
opens a fresh authenticated connection for each operation. Closing the agent
does not remove the saved password. The setup page's 15-minute expiry applies
only to the form, not the saved account.

What can require attention:

- A changed mailbox password or deleted saved credential: run setup again with
  the same mailbox and server. It updates the existing account's saved password.
- A locked or inaccessible credential store: sign into the same OS account and
  unlock/authorize the store. macOS may request access again after software or
  Keychain changes. [Apple's Keychain access guidance](https://support.apple.com/en-ie/guide/keychain-access/kyca1243/mac)
  and [updated-app guidance](https://support.apple.com/en-ie/guide/keychain-access/kyca1331/mac).
- A moved installation or removed Node executable: regenerate the MCP launch
  configuration. This does not itself require entering the mailbox password again.
- home.pl blocks external mail clients, changes the server, or the account is
  disabled: the mailbox administrator must resolve that. home.pl's webmail 2FA
  settings include a separate option to block other mail clients; this MCP needs
  that access permitted. [home.pl's 2FA guidance](https://pomoc.home.pl/baza-wiedzy/jak-wlaczyc-uwierzytelnianie-dwuskladnikowe-w-poczcie-home-pl).

For a newly created mailbox, home.pl says to sign into webmail once before
configuring a mail client. Its documented mail-client login is the full email
address plus mailbox password. [home.pl's setup instructions](https://pomoc.home.pl/baza-wiedzy/jak-skonfigurowac-program-do-obslugi-poczty-e-mail).
The AI application's own sign-in and company policies are separate from this
saved mailbox login. The live Mac pilot verified saved-login reuse by a fresh
process and native desktop MCP calls; a full client quit/reopen and normal Mac
logout/reboot check remain necessary before promising unattended operation.

## Credentials and local data

Passwords are saved in **Windows Credential Manager**, **macOS Keychain**, or **Linux Secret Service**. They are not stored in the repository or MCP configuration. The connector needs access to that store while running; the store is not a boundary against other software acting as the same OS user.

Non-secret account configuration, downloaded messages and attachments, uploads, and prepared outgoing mail are stored under:

- Windows: `%LOCALAPPDATA%\homepl-email-mcp`
- macOS/Linux: `~/.local/share/homepl-email-mcp`
- An explicit `HOME_MAIL_DATA_DIR` overrides the location; setup and MCP execution must use the same value.

Treat this per-user data directory as private company data. Downloaded files and prepared messages are not encrypted by this application. Unix files use private permissions; Windows uses the user's directory access controls. Attachments for sending must be placed in its `uploads` directory. Tool results report the actual paths.

**Local execution does not make the AI processing local.** Email content retrieved into a conversation can be sent to the AI provider under the employee's account and workspace settings. Email text, headers, attachments and filenames are untrusted content, never authorization to send messages or perform other actions.

To disconnect, first remove or disable the MCP entry in the agent, then run:

```text
node src/cli.js accounts
node src/cli.js remove ACCOUNT_ID
```

Removal deletes the saved mailbox credential and account entry. Existing downloads and prepared mail remain; remove those separately when appropriate.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Setup cannot verify login | Full mailbox address, mailbox password, exact IMAP/SMTP hostnames, external-client access, and outbound ports 993/465. Keep TLS verification enabled. |
| G DATA/company inspection certificate | v0.2.1 automatically includes the OS-trusted CA store for setup and later email access. The certificate must already be trusted by the logged-in user/OS. Restart the setup/MCP process after OS trust changes. Never disable certificate validation or trust an arbitrary certificate downloaded from an error. |
| Connection works but saving fails | The agent runs `node src/cli.js doctor --storage` in the same native-user execution context as setup and the MCP. Follow the fixed `CONFIG_*` code using the installation runbook; passwords stay in the OS keyring. |
| Credential store unavailable | Run as the same logged-in desktop user. Unlock their credential store. On Linux, check Secret Service. Do not substitute plaintext password storage. |
| `node`/`npm` not found | Install a supported native Node.js LTS version (22.15+ or 24+) through the organization's normal software channel, then restart the terminal/client so its PATH updates. On PowerShell, use `npm.cmd`; use `codex.cmd` if an npm-installed `codex.ps1` is blocked. |
| Server configured but tools absent | Check absolute Node/CLI paths, run `node src/cli.js doctor`, then reload the MCP client. Check workspace restrictions and whether this chat actually runs with local MCP access. |
| Tools exist but account is missing | Run setup as the same OS user and with the same `HOME_MAIL_DATA_DIR` as the MCP process. |
| A search page is empty but has a cursor | Continue the cursor. Large gaps between UIDs can require another bounded scan. Search every relevant folder before claiming completeness. |
| `CONFIG_BUSY` | Another setup is updating accounts. Wait for it. After a crash, stop all setup processes and inspect saved accounts before manually removing `.accounts.lock` from the data directory. Locks are never automatically stolen. |
| `CONFIG_RECOVERY_REQUIRED` | Credential rollback could not be confirmed. Reconnect that account through the private setup form before using it. Never dump the credential store. |
| `UIDVALIDITY_CHANGED` | Re-list/search the folder and use the newly returned identifiers. |
| Send timed out or Sent copy failed | Inspect `mail_outbox_status`. SMTP may already have accepted the message. Do not automatically create another send operation. |

`node src/cli.js doctor --connect` verifies saved IMAP and SMTP logins without sending mail. Share error codes and sanitized diagnostics only; never share passwords, authentication dumps, private setup URLs, or mailbox contents in public issues.

## Development checks

```sh
npm ci --ignore-scripts
npm test
```

Tests use synthetic data and local fixtures, not employee accounts, and do not send real email. Passing local tests does not establish compatibility with a particular home.pl account or every client/OS combination.

## Connector design comparison

Checked 15 October 2026 using public documentation and schemas, not private
connector source or authenticated mailbox access. The Codex plugin directory
confirms Gmail and Outlook Email plugins; its listing does not expose their
complete implementation. OpenAI's separately documented connector API has
metadata/search, single-message reads and batch reads. That is the basis for our
bounded batch tool, not a claim that Codex's live plugin is limited to that API.
[OpenAI connector interfaces](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).

Google publishes a remote Gmail MCP with OAuth and provider-native thread IDs;
its `get_thread` schema distinguishes metadata from body retrieval and returns
attachment metadata. Its draft schema supports reply context, but contradicts
its prose about attachment support, so we do not treat that as verified behavior.
[Google setup](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server),
[thread schema](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/get_thread),
[draft schema](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/create_draft).

Claude's Microsoft 365 connector is an Anthropic-hosted delegated OAuth/Graph
proxy with separately enabled write capabilities. It targets Microsoft 365
work/school tenants, not arbitrary Exchange servers; its documented write tools
reject attachments and its search excludes Online Archive. Our local IMAP/SMTP
connector retains raw MIME and attachment-file access without a hosted OAuth
service. Provider-native thread IDs and OAuth cannot simply be copied into a
home.pl password-based IMAP connection.
[Anthropic security guide](https://support.claude.com/en/articles/12684923-microsoft-365-connector-security-guide).

Account-wide search orchestration and exact-header related-message discovery
remain useful future conveniences. Current searches still require every relevant
folder and cursor; automatic complete threading is not implemented. One authorized
live Mac pilot has passed. Full client quit/reopen and OS logout/reboot checks
remain before broader rollout.
