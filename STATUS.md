# Release and validation status

Source version: **v0.3.1**. Installation and upgrade instructions resolve the current
stable GitHub release at installation time, then pin that exact tag and full
source commit. See [latest stable release](https://github.com/borystam/homepl-email-mcp/releases/latest)
for the authoritative published version and assets; a source version alone is
not publication confirmation. Sections below are historical validation
records, not instructions to choose an older release.
One authorized home.pl mailbox has passed the live Mac pilot. Full app
quit/reopen and OS logout/reboot checks remain unverified.

## Current-release installation and upgrade guidance — 2026-10-15

README, AGENTS and the canonical installation runbook no longer embed an old
version in the employee prompt or clone commands. The runbook resolves GitHub's
latest stable release once and checks its full source SHA and package version
before dependency installation. Resolution/provenance failures stop explicitly;
there is no fallback to an old ZIP, cache or main. Explicit user pins remain
intentional exceptions.

Upgrade instructions preserve the same account store, OS user, custom data path,
read-only mode and existing MCP entry. All onboarding status results expose the
connector version loaded by the actual MCP process, so a new checkout cannot be
mistaken for a refreshed desktop connection. Historical provider research is
separate from employee installation. Superseded release descriptions point new
installations to the latest stable release; historical tags remain unchanged.

This patch release also includes the SMTP fixes and verification below.

## Independent council — 2026-10-15 15:17 Europe/Warsaw

Three fresh independent advisors reviewed the actual changes as a pragmatic
product owner, skeptical reliability engineer and first-time installing operator.
They found the latest-release resolver and loaded-version check useful and no
runtime blocker; the reliability advisor independently passed 18 focused tests.
Accepted: stop expanding documentation/features and repeating local audits;
publish with the required full-SHA release metadata, redirect old release pages,
and test the public download. Accepted: keep source-version status distinct from
confirmed publication and fix the moved comparison link. No conflicting advice
required rejection. Next testable outcome: public latest resolves v0.3.1 and a
fresh verified artifact reports that version over stdio without mailbox access.

## SMTP outcome and message identity fixes — 2026-10-15

An authorized live Mac check exercised server draft creation and update, draft
preparation, multipart text/HTML, Unicode and binary attachments, SMTP delivery,
Sent copies, received-message search, exact raw download, batch metadata reads,
flags and moving the generated draft to Trash. Two test messages reached the
intended external inbox. Both downloaded attachments matched their original
SHA-256 hashes. No unrelated messages were changed.

The live check exposed a result-identity bug: Nodemailer generated a surrogate
Message-ID for raw sends even though the immutable MIME contained a different
ID. Sending now reads the integrity-validated MIME headers and supplies, returns
and persists the actual Message-ID, including for older prepared operations.
An independent loopback check also found that explicit MAIL FROM rejections
were incorrectly reported as unknown; they now report a known, sanitized sender
rejection. Neither fix permits automatic retry.

All 171 synthetic tests passed, with zero skips. The Message-ID regression failed
before the fix and now checks the exact SMTP bytes, Sent bytes, returned ID and
persisted outcome. Independent review found no actionable issues. These fixes
were not included in v0.3.0 and are included in v0.3.1 source.

The updated installed connector was then started as a fresh stdio MCP process.
It discovered all 20 tools and reused the existing OS-keyring login without a
new setup flow. A third authorized live test confirmed SMTP acceptance and an
identical Message-ID in the result, persisted outcome, Sent folder and received
copy. Sent-folder pagination completed all three one-message pages. The already
running desktop chat still needs its MCP connection reloaded to load new code;
computer control cannot open this app's own settings UI.

## v0.3.0 conversation-driven local onboarding — 2026-10-15

The affected Windows installation subsequently reported its agent shell running
as `CodexSandboxOnline`, with Windows reporting no such credential logon session.
The previous shell-first runbook therefore tested the wrong execution context.
Native-store CI passing under a normal runner user did not prove employee
onboarding under that Codex configuration.

Register/reload now precedes login. `mail_setup` starts the existing private form
inside the actual MCP process and probes storage there; `mail_setup_status`
reports actual username, platform, runtime, data path and completion. Known
Windows sandbox account names are rejected before touching storage or asking for
credentials. A normal username still must pass the real storage probe. If the
client itself launches MCP under an unusable identity, this remains a client
launch block; a reload is not proof of recovery.

The password remains in the private loopback form and OS keyring, never MCP
arguments, results or chat. One active wizard is reused; terminal status retires
its URL, and transport closure/stdio EOF cancels the listener. Both mailbox access
modes retain local onboarding, accurately annotated as a local account change;
mailbox read-only mode still excludes mailbox writes. Catalog counts are 20/10.

All 169 local synthetic tests passed, zero skipped. A real MCP/private-HTTP-form
test in each access mode saves a synthetic credential, returns connected, lists
folders and verifies secret filtering. Boundary tests cover unexpected arguments,
blocked sandbox identity, concurrent startup and disconnection, including EOF of
a spawned Node stdio server without a client force-kill. Native platform checks
remain in GitHub Actions; the affected Windows desktop app still needs its own
successful identity/storage, live folder and quit/reopen verification.

A later v0.2.1 main-merge CI run hit an isolated five-second OpenSSL startup
deadline before TLS/authentication; its identical PR tree had passed. The fixture
now closes child stdin and allows bounded native startup, with no production TLS
relaxation.

## Independent council — 2026-10-15 13:56 Europe/Warsaw

Three fresh independent advisors reviewed actual source/results as pragmatic
product owner, skeptical reliability engineer and first-time operator. All found
the MCP-owned wizard a justified narrow change, and identified the old runbook's
shell-first sequence as contradictory. They rejected treating green synthetic CI
or sandbox-name detection as proof of the affected desktop's usable credentials.

Accepted: make registration/reload → native setup → private form → actual folder
read the single employee flow; avoid terminal diagnostics for employees; add one
real MCP-boundary/disconnect test; state the remaining Windows host uncertainty.
These changes are implemented. Accepted: stop expanding features and repeating
audits; no conflicting advice required rejection. Next observable user benefit:
the affected employee reaches a native `mail_folders` call and repeats it after
reopening Codex without another login. No source changes to global sandbox/logon
policy, impersonation or plaintext credential fallback are part of this fix.

## v0.2.1 OS certificate trust and agent-owned installation — 2026-10-15

An employee Windows installation reported TLS interception by a locally trusted
mail-scanning certificate. Setup and runtime IMAP/SMTP now share a strict TLS
configuration that adds OS-trusted roots to Node's existing default/additional
roots. No certificate export, antivirus change, global trust mutation or disabled
verification is required. Native Node 22.19+ on 22.x or 24.6+ is required.

A subsequent save failure had only a generic storage message; its exact cause on
that PC is not yet established. Setup now probes its real data directory and a
unique synthetic keyring entry before opening the password form. Fixed storage
codes distinguish binding, read, write, metadata and cleanup failures without
revealing raw errors. There is no plaintext credential fallback.

The installing agent's runbook explicitly owns prerequisite installation,
preflight, ordinary local repair, saved-login reuse, MCP client registration and
real-tool verification. The employee enters mailbox details privately; diagnostics
are performed by the agent. Actual security/organization blocks remain blocks.

Synthetic tests cover combined CA sources and all four mail transport paths,
untrusted/hostname rejection, pre-form storage order, safe storage-stage messages,
and cleanup/rollback. Windows CI additionally installs and removes one unique
synthetic machine-store root on an ephemeral runner, proving fresh-process native trust and rejection
after removal; no user machine trust store is modified by that smoke script.
The independent patch reviewer found one doctor binding-message gap, which was
fixed, and no remaining blocking issues. The local full suite passed 153 tests
with zero skips. Native platform results are available in GitHub Actions for the
release commit. Minimum-version Windows CI exposed an upstream libuv filesystem
identity inconsistency on Node 22.15; the runtime floor is now 22.19/24.6, which
contains its fix. Strong file-identity checks are retained. The affected employee PC still needs an agent
upgrade and a successful storage/MCP verification before it is called working.

## v0.2.0 publication readiness — 2026-10-15

The validated code at `399e381` passed all eight CI jobs: Windows, macOS Apple
silicon, macOS Intel and Ubuntu, each on Node.js 22 and 24. Windows/macOS jobs
also checked synthetic native saved credentials across fresh processes. The
local suite passed 133 tests with zero skips. Release preparation updates the
version and documentation without adding features or changing dependencies.

The live Mac pilot verified IMAP and SMTP login, Keychain storage, discovery of
all 18 actual MCP tools, seven folders, metadata for three messages and headers
for one, plus saved-login reuse by a fresh MCP server process. The desktop app
then loaded the native connector tools; its `mail_accounts` and `mail_folders`
calls succeeded. No messages were sent or changed. A full app quit/reopen and
normal OS logout/reboot remain separate checks before broader rollout.

## Live setup diagnostics — 2026-10-15

The first browser retry reached provider authentication and reported `IMAP_AUTH`.
The same credentials were also rejected by the provider's own login page. TLS
connectivity and the external-client setting were checked. An explicitly
authorized password reset resolved authentication. Setup then verified IMAP and
SMTP and saved the credential in macOS Keychain.

Actual stdio MCP calls discovered all 18 tools, listed seven live folders, read
metadata for three messages and headers for one, then closed the server. A fresh
MCP server process reused the saved credential and listed folders without running setup
again. No messages were sent or changed. The desktop app subsequently loaded its
native tool catalog and successfully called `mail_accounts` and `mail_folders`.
A full desktop-app quit/reopen and OS logout/reboot remain unverified.

Setup now distinguishes fixed IMAP/SMTP authentication, network, TLS and unknown
failure codes, plus IMAP folder discovery. Provider error text, responses, stacks
and arbitrary codes remain hidden. Transport factories permit isolated regression
checks while preserving production TLS validation and request protections.
Validation: 133 local automated tests passed, zero skipped; focused setup/TLS
checks passed 31 tests. Native browser verification is a separate check.

## Independent council — 2026-10-15 11:03 Europe/Warsaw

Three fresh-context advisors independently inspected the actual setup source,
installation and validation status: pragmatic product owner, skeptical reliability
engineer, and first-time operator. All found that the live connection, rather
than more features or broad audits, is the next required delivery outcome.

Accepted: apply the narrow diagnostic patch to the installed copy, restart setup,
make one informative attempt, preserve non-secret settings, and stop unchanged
password retries. The next attempt identified `IMAP_AUTH`; the provider's login
page independently confirmed rejected credentials. Accepted: after login succeeds,
verify real MCP folders/metadata and saved credentials from a fresh client process.
No conflicting advice required rejection. Password entry through the local form
remains the normal employee flow; the pilot user explicitly authorized direct
browser login assistance in this session.

Outcome achieved: valid credentials produced a saved connection and actual MCP
folder/metadata/header reads, including saved-login reuse by a fresh process.
The next outcome was also achieved: the desktop app loaded its native tool
catalog and repeated the account/folder reads successfully. Next testable
outcome: publish the validated v0.2.0 release and provide its exact setup prompt.
Further features, audits and repeated full-suite runs are deferred. The next
council is due after another 30 minutes of active work.

## Current result

Fixed a live-onboarding browser failure on 2026-10-15: the setup response used
`Referrer-Policy: no-referrer`, which makes a native form POST send `Origin: null`.
The strict Origin check then returned 403 before attempting mailbox login.
`same-origin` preserves the required Origin and keeps referrers off other origins;
Host, loopback, Origin, Fetch Metadata and CSRF-token checks remain unchanged.
Chrome reproduced the old null Origin, and submitting the corrected actual setup
form with synthetic verify/save callbacks completed once successfully. No real
mailbox or Keychain was accessed in that browser check. HTTP regressions retain
rejection of null/missing Origin and non-same-origin Fetch Metadata. The existing
HTTP tests have been renamed accurately; they do not simulate a native browser.

Added an optional read-only MCP process, bounded batch metadata reads, and server
reply/reply-all/forward drafts. Fixed confirmed failures in dates, UIDNEXT,
duplicate FETCH updates, decoded preview budgets, oversized output, stream cleanup,
address groups, inline CID resources, incomplete drafts, SMTP rejection reporting,
attachment path replacement, account-update races and cancellation/rollback.
Generated client config preserves a custom data directory and fixed error codes
provide recovery guidance without provider diagnostics or credentials.

docs/CONNECTOR_COMPARISON.md contains the sourced OpenAI/Google/Anthropic comparison
and distinguishes public schemas from private implementations. Account-wide
search orchestration and related-message helpers remain deferred; full retained
history still requires every relevant folder and every cursor.

## Evidence

- 133 tests passed locally on macOS/Node.js 26.5.0, with zero skipped tests.
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
- All eight CI jobs passed at `399e381`: Windows, macOS (Apple silicon and Intel)
  and Ubuntu with Node.js 22 and 24.
  Windows/macOS also verify native saved credentials across fresh processes.
  TLS tests explicitly skip when
  OpenSSL is unavailable, rather than claim TLS validation without running it.

Limits: the single live Mac pilot does not establish every home.pl configuration.
Linux Secret Service persistence, full desktop-app quit/reopen and OS logout/reboot
checks remain unverified.
Read-response bounds do not cap all provider metadata allocation; very sparse UID
spaces can require many pages. Local same-user filesystem access is not a separate
security boundary. Downloaded mail remains private local data, not application-encrypted.

## Mac rollout and saved login — 2026-10-15

Mac onboarding now has explicit, quoted Terminal commands, a persistent install
directory, native Node/absolute client paths, Keychain permission guidance and a
real-client restart check. Windows onboarding remains available. CI adds Intel
Mac runners alongside the existing Apple silicon runners, on Node.js 22 and 24.
The native keyring dependency ships binaries for both architectures.

The native credential smoke check now saves a synthetic account and password,
exits, retrieves/rotates it in a fresh Node process, retrieves/removes it in another
process, then verifies deletion. It uses a unique test-only service/account and
temporary metadata; random passwords never enter arguments, environment, logs or
metadata. Cleanup runs even after failure. This passed locally on macOS arm64;
all 119 existing tests also pass. It does not simulate an OS reboot or a locked
Keychain, and does not contact home.pl.

The connector uses saved mailbox passwords with no OAuth/refresh-token expiry.
Documentation distinguishes that from password changes, credential-store access,
home.pl's external-client block, and the AI client's own login. A real mailbox
pilot has since passed, including native desktop MCP reads. A full client
quit/reopen and normal OS logout/reboot remain outstanding.

## Peer MCP bug audit — 2026-10-15

Three confirmed local failures were reproduced before fixing them:

- [imap-mcp-server PR #171](https://github.com/nikolausm/imap-mcp-server/pull/171):
  MailComposer retained bare LF in multiline text/HTML. Two regression tests
  failed before body normalization and now pass, including strict APPEND byte
  validation, mixed line endings, Sent MIME and unchanged binary attachments.
- [google_workspace_mcp PR #1065](https://github.com/taylorwilsdon/google_workspace_mcp/pull/1065):
  replies lost the parent's single In-Reply-To ancestor when References was absent.
  Prepared and saved replies both failed before the fix. Existing References win;
  ambiguous and malformed parent values are not inferred into the chain.
- [rusty-imap-mcp PR #533](https://github.com/randomparity/rusty-imap-mcp/pull/533):
  explicit AUTH 535 and final DATA 550 responses were reported as delivery unknown.
  Real loopback SMTP reproduced both failures. They now report rejected; socket
  loss and timeout after DATA remain unknown. All four paths forbid another send
  for the same operation, and provider diagnostics remain private.

No local failure found for UID/sequence confusion
([honest-magic fix](https://github.com/honest-magic/mail-mcp/commit/8b3035d3ca0098f00bda327941525716dc981648)),
false-empty SELECT counts ([marlinjai PR #9](https://github.com/marlinjai/email-mcp/pull/9)),
or folder/attachment identity ([PR #39](https://github.com/marlinjai/email-mcp/pull/39)).
Synthetic probes confirmed the existing behavior. Fresh per-operation sessions
also avoid the cached idle/cancelled-session failures in rusty-imap-mcp PRs
[#488](https://github.com/randomparity/rusty-imap-mcp/pull/488) and
[#628](https://github.com/randomparity/rusty-imap-mcp/pull/628).

Unresolved dependency limitation: shared folders outside a nonempty personal
namespace can be omitted or prefixed incorrectly, matching
[imap-mcp-server issue #191](https://github.com/nikolausm/imap-mcp-server/issues/191).
Confirmed the pinned library's path transformation and documented the limitation;
no home.pl-specific reproduction and no dependency-internal workaround applied.

An independent read-only reviewer found no blocking regression in the three
fixes; 45 focused tests passed. The full assembled suite passes 119/119 locally.
No production dependencies or capabilities were added in this audit.

## Independent council — 2026-10-15 00:11 Europe/Warsaw

Three fresh-context advisors inspected actual source/results independently:

- Product owner: the hardening addresses real failures; stop adding capabilities,
  document the release boundary and deliver the reviewable change.
- Reliability engineer: 93 tests passed at the review snapshot, but reproduced an
  ancestor-symlink attachment bypass. The new regression failed before the fix;
  the assembled suite now passes 99 tests.
- First-time operator: the pilot flow is concrete; generated config lost a custom
  data directory. The override is now retained and verified by a CLI regression.

Accepted at that review: fix the demonstrated gaps, document read-only/batch
behavior, keep the changes unreleased until review, and stop broad feature
expansion. Deferred account-wide search/thread reconstruction because they did
not replace the missing live pilot.
Retained deployment-platform instructions; the expanded CI matrix verifies the
supported targets without changing the development workstation.

The next testable user outcome at that review was: after reviewing and installing
the intended commit, one authorized employee connects through the private local form and actual MCP
calls confirm read-only access, folder listing, an old message and its attachment.
No SMTP send or mailbox mutation was part of that pilot. The next independent
council was due after another 30 minutes of active work (approximately 00:41
Warsaw time); the subsequent council is recorded above.

## Independent dependency security review — 2026-10-15

Scope: package manifests/lockfile, installed package lifecycle metadata, install
instructions and CI dependency acquisition. All six production and two development
direct dependencies are exact versions. All 157 non-root lock entries have exact
versions, HTTPS npm-registry tarball URLs and integrity hashes; none declares an
install hook. Native credential-store packages are pinned to 2.1.1 and remain
optional platform dependencies. CI actions use full commit SHAs and read-only
repository permissions. No dependency versions were changed in this review.

`npm audit --json --ignore-scripts` reported zero known advisories. `npm audit
signatures --ignore-scripts` verified registry signatures for 146 installed
packages and attestations for 29. These are registry checks, not a source-code or
native-binary audit, and cannot guarantee absence of malicious code or future
vulnerabilities. Runtime dependency code still executes when the connector uses it.

Added project `.npmrc` defaults `ignore-scripts=true` and `save-exact=true`;
explicit install commands retain `--ignore-scripts`. npm documents that
[`npm ci`](https://docs.npmjs.com/cli/v11/commands/npm-ci/) freezes the locked tree
and that ignoring install scripts still permits explicitly requested scripts such
as `npm test`. Higher-precedence npm settings can override project defaults.

Release-tag-only installation remains weaker than comparing the checkout with an
independently supplied full commit. Record the final release commit in its release
notes/setup handoff and verify it when provided. A pin prevents silently adopting
a later changed package/tag; it does not make the original code inherently safe.
