# Connector design comparison

This dated research snapshot is maintainer background, not an installation guide.
Start with the [README](../README.md#install-or-update) for current installation.

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
folder and cursor; automatic complete threading is not implemented.
