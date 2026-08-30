# /setup

Read the port and bearer token from `bridge.json`, then emit one merge-safe MCP client block for the user's client. Do not edit, overwrite, or replace a config file. This procedure never invents a port or token. If `bridge.json` is absent, stop and tell the user to run `/doctor` first.

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

## Step 2: emit a merge-safe client block

Ask which client the user runs, or detect it from context, then print only the target path, the `loophole` entry, and a reminder to merge it alongside existing servers. Never replace an existing `mcpServers` object and never apply the change on the user's behalf.

### Claude Code (preferred)

Emit this command for the user to review and run. Do not execute it:

```bash
claude mcp add --transport http loophole http://127.0.0.1:8420/mcp \
  --header "Authorization: Bearer <token-from-bridge.json>"
claude mcp list   # verify "loophole" is listed
```

`--header` is the current flag for attaching the `Authorization` header on an HTTP transport. Confirm it against the installed CLI version (`claude mcp add --help`) before running, since the flag name can change between releases.

### Claude Desktop

Emit the target path and entry below. The user merges it into the existing config, then fully quits and reopens Claude Desktop:

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

This is a merge fragment. Add `loophole` alongside existing servers. Do not replace the surrounding object.

### Cursor

Emit the same merge fragment and identify `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for all projects, as the target:

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

1. A supported current Live beta is running with the locally packaged Loophole extension installed. If unsure, run `/doctor`.
2. `loophole` appears in the client's MCP server or tool list (`claude mcp list` in Claude Code; the tools panel in Desktop or Cursor after the restart).
3. Run one read-only tool: call `live_get_song_overview`. It returns the Set tempo and real track names with opaque session references. If you see your actual track names, the bridge is wired and working.

If the tool list is empty or the call errors, the token is wrong or stale (re-read `bridge.json` and re-emit the config), or the bridge is not running (`/doctor`). The token is per install: if the extension regenerated it, the file and the running bridge must agree, so re-read the file after any reinstall or restart.
