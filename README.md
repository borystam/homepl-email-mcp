# homepl-email-mcp

Connect a local AI agent to a home.pl mailbox through encrypted IMAP and SMTP. Each employee installs the connector on their own computer and signs in once through a private local form. No hosted connector or shared password database is required.

This is an independent community project, not an official home.pl product. Version **0.1.0** is an initial release. It has local automated tests; a live home.pl mailbox has **not** yet been tested. Pilot it with one employee before repeating the installation for the team.

## Give this to the employee's agent

Paste this into **an agent with access to the employee's computer and support for local stdio MCP servers**:

> Install https://github.com/borystam/homepl-email-mcp at release v0.1.0 on this computer. Read and follow INSTALL_FOR_AGENTS.md from that release. Install the required local dependencies, configure the connector in this agent, and guide me through connecting my home.pl mailbox. I will enter my mailbox password myself in the private local setup form; never ask me to put it in chat or screenshots. After connecting, verify the actual MCP tools, list my folders, and inspect metadata and headers for up to three messages. Do not send, move, change or delete mail as part of setup. Tell me the installed version and whether the live read check succeeded.

The employee needs their **full mailbox email address, mailbox password and exact mail server hostname**. The home.pl hosting administrator password is not the mailbox password.

Ordinary browser-only ChatGPT cannot run this local installer or read local Codex configuration. Use a local agent/client that exposes stdio MCP tools. Client and workspace policies determine whether those tools are available. See [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

## What it can do

| Capability | Included behavior and limits |
| --- | --- |
| Folders and history | Lists all server-visible folders, including unsubscribed folders. Reads and searches the entire history retained on the server, with no automatic date cutoff. Follow every page in every relevant folder; new arrivals require a new search. |
| Message metadata | UID and UIDVALIDITY, flags, size, internal date, envelope, MIME structure and additional IDs when supported by the server. Original headers preserve order, duplicates and folding; oversized headers remain available in a complete local file. |
| Bodies | Bounded text/HTML previews plus complete body files. HTML is returned as data, not executed. Display text may undergo charset conversion or flowed-text normalization. |
| Original messages | Streams a complete original `.eml` with all headers and MIME content; returns a local path, byte count and SHA-256. This is the byte-preserving source of truth. |
| Attachments | Downloads arbitrary MIME parts by part ID, including inline images, binary files and attached messages. Repeated filenames are unambiguous. MIME transfer encodings are decoded; inline display text can be normalized. The agent needs suitable file tools to interpret downloaded content. |
| Search | IMAP search across headers and message text, with dates, addresses, flags and size filters. Searches are per folder and paginated. It does not OCR images or search inside binary attachments. Header searches can find related messages; there is no claim of automatic complete conversation reconstruction. |
| Compose and send | New mail, replies, reply-all, forwards, CC/BCC, text/HTML and local attachments. A prepared operation has a preview and a separate send action. The transmitted MIME is retained locally; Sent copies retain BCC metadata and therefore can differ by that header. SMTP acceptance and Sent-copy saving are reported separately; uncertain sends must not be retried blindly. |
| Drafts | Save and update server drafts, then prepare them for sending. Updating requires UIDPLUS and returns a new UID. Sending a prepared server draft retains the source draft. |
| Organize | Flags, move, copy, trash; create, rename, subscribe, unsubscribe and delete folders. Message mutations require observed UIDVALIDITY. Permanent message deletion requires UIDPLUS and targets one exact UID. |

The connector cannot recover mail already deleted from the server or mail kept only in an old POP/local archive. It can retrieve encrypted S/MIME/PGP content, but does not decrypt it or manage decryption keys. It does not guarantee that an AI can interpret every file format. Retrieval is on demand, not an automatic mailbox backup or a continuously synchronized search index.

## Manual installation on Windows

Use native Windows Node.js **22 or newer**, npm, Git, and a local MCP-capable agent. Run the connector as the employee's normal desktop user so it can use that user's credential store. An administrator or a different OS account would have different settings and credentials.

In PowerShell, choose a persistent installation directory:

```powershell
$homeplRepo = Join-Path $env:LOCALAPPDATA "Programs\homepl-email-mcp"
New-Item -ItemType Directory -Force (Split-Path $homeplRepo) | Out-Null
git clone --branch v0.1.0 --depth 1 https://github.com/borystam/homepl-email-mcp.git $homeplRepo
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

If the Codex CLI is unavailable, run `node src/cli.js config`. It prints a ready-to-merge Codex TOML entry and a JSON `mcpServers` entry for clients that use that format, with this machine's absolute paths. Merge the appropriate entry into existing client settings; do not replace the whole settings file. No mailbox password belongs in either configuration. [Official Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

Restart or reload the client as its MCP configuration requires. A configuration entry alone does not prove the connection works: ask the agent to call `mail_accounts`, `mail_folders`, and `mail_list_messages` with `pageSize: 3`. It can inspect headers using `mail_get_message` with `includeBodies: false`. Initial verification should not send, change or delete any mail.

On macOS or Linux, the same Node/npm commands work from a persistent clone directory; use `npm` instead of `npm.cmd`. `node src/cli.js config` supplies the correct absolute launch paths for that machine. Linux requires an unlocked Secret Service in the user's session; a headless shell without one is insufficient.

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
| Credential store unavailable | Run as the same logged-in desktop user. Unlock their credential store. On Linux, check Secret Service. Do not substitute plaintext password storage. |
| `node`/`npm` not found | Install Node.js 22+ through the organization's normal software channel, then restart the terminal/client so its PATH updates. On PowerShell, `npm.cmd` avoids script execution-policy issues. |
| Server configured but tools absent | Check absolute Node/CLI paths, run `node src/cli.js doctor`, then reload the MCP client. Check workspace restrictions and whether this chat actually runs with local MCP access. |
| Tools exist but account is missing | Run setup as the same OS user and with the same `HOME_MAIL_DATA_DIR` as the MCP process. |
| A search page is empty but has a cursor | Continue the cursor. Large gaps between UIDs can require another bounded scan. Search every relevant folder before claiming completeness. |
| `UIDVALIDITY_CHANGED` | Re-list/search the folder and use the newly returned identifiers. |
| Send timed out or Sent copy failed | Inspect `mail_outbox_status`. SMTP may already have accepted the message. Do not automatically create another send operation. |

`node src/cli.js doctor --connect` verifies saved IMAP and SMTP logins without sending mail. Share error codes and sanitized diagnostics only; never share passwords, authentication dumps, private setup URLs, or mailbox contents in public issues.

## Development checks

```sh
npm ci --ignore-scripts
npm test
```

Tests use synthetic data and local fixtures, not employee accounts, and do not send real email. Passing local tests does not establish compatibility with a particular home.pl account or every client/OS combination.
