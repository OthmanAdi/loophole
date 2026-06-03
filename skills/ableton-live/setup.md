# /setup

Read the port and bearer token the extension wrote to `bridge.json`, then write the correct MCP client config for the user's client. This procedure never invents a port or token. If `bridge.json` is absent, stop and tell the user to run `/doctor` first.

`/setup` reads a file and emits a client config. It does not import bridge code and does not talk to Live. The only Live touch is the verify step at the end, which is one read-only bridge tool call the user runs in their client.

## Step 1: read `bridge.json`

Resolve the extension `storageDirectory` (the path Live reports for the Loophole extension), then read `bridge.json`:

```json
{
  "port": 8420,
  "token": "<base64url-bearer>",
  "transport": "http",
  "url": "http://127.0.0.1:8420/mcp"
}
```

Take `port`, `token`, and `url` straight from this file. The examples below use `8420` and `<token-from-bridge.json>` as placeholders; substitute the real values you read. If the file is missing, the bridge is not running or the extension is not installed: stop and tell the user to run `/doctor`, do not guess a port or mint a token.

## Step 2: emit the client config

Ask which client the user runs (or detect it from context), then emit only that block.

### Claude Code (preferred)

Add the HTTP transport and attach the bearer token as a header:

```bash
claude mcp add --transport http loophole http://127.0.0.1:8420/mcp \
  --header "Authorization: Bearer <token-from-bridge.json>"
claude mcp list   # verify "loophole" is listed
```

`--header` is the current flag for attaching the `Authorization` header on an HTTP transport. Confirm it against the installed CLI version (`claude mcp add --help`) before running, since the flag name can change between releases.

### Claude Desktop

Patch the config file, then fully quit and reopen Claude Desktop (closing the window is not enough; the server list is read on launch):

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "loophole": {
      "transport": "http",
      "url": "http://127.0.0.1:8420/mcp",
      "headers": { "Authorization": "Bearer <token-from-bridge.json>" }
    }
  }
}
```

If `mcpServers` already exists, add the `loophole` key alongside the others rather than replacing the object. After saving, quit Claude Desktop completely and reopen it.

### Cursor

Write the same `mcpServers` block to `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "loophole": {
      "transport": "http",
      "url": "http://127.0.0.1:8420/mcp",
      "headers": { "Authorization": "Bearer <token-from-bridge.json>" }
    }
  }
}
```

## Step 3: verify it worked

Confirm the wiring against the live bridge:

1. Live 12.4.5b Suite is running with the Loophole extension installed (so the bridge answers). If unsure, run `/doctor`.
2. `loophole` appears in the client's MCP server or tool list (`claude mcp list` in Claude Code; the tools panel in Desktop or Cursor after the restart).
3. Run one read-only tool: call `live_get_song_overview`. It returns the Set tempo and the real track names with ids. If you see your actual track names, the bridge is wired and working.

If the tool list is empty or the call errors, the token is wrong or stale (re-read `bridge.json` and re-emit the config), or the bridge is not running (`/doctor`). The token is per install: if the extension regenerated it, the file and the running bridge must agree, so re-read the file after any reinstall or restart.
