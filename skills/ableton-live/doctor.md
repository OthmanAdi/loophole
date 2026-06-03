# /doctor

Check every prerequisite for the Loophole Bridge and print exactly what is missing plus the one action that fixes it. Run all five checks, never assume a dependency, and never proceed to `/setup` on your own. The user runs `/setup` themselves once `/doctor` reads ready.

This procedure reads `bridge.json` and probes the local bridge port. It does not import bridge code and does not talk to Live directly. The only Live read is one MCP tool call in check 4.

## Where `bridge.json` lives

The extension writes `bridge.json` into its own `storageDirectory` on first activation. That path is assigned by the Extension Host, so resolve it rather than hardcoding it: ask the user for the storage directory Live reports for the Loophole extension, or check the path the extension logged. The file shape is:

```json
{
  "port": 8420,
  "token": "<base64url-bearer>",
  "transport": "http",
  "url": "http://127.0.0.1:8420/mcp"
}
```

The port is one of `8420` to `8429` (the bridge probes that range and binds the first free port). Read `port` and `token` from this file; never invent either.

## The five checks

| #   | Check                                 | How                                                                                                                                                                       | FIX line on failure                                                                                                  |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Live 12.4.5b Suite is running         | Confirm an Ableton Live process is up; check 4 (the port responding) is the strong signal                                                                                 | "Open Ableton Live 12 Suite (beta build 12.4.5b)."                                                                   |
| 2   | The extension is installed and active | `bridge.json` exists in the extension `storageDirectory`                                                                                                                  | "Install the Loophole extension `.ablx` in Live, Settings, Extensions, then restart Live."                           |
| 3   | Node >= 24.14.1                       | run `node --version` and compare                                                                                                                                          | "Update Node to >= 24.14.1."                                                                                         |
| 4   | Bridge port reachable                 | read `port` from `bridge.json`, then `GET http://127.0.0.1:<port>/mcp` with header `Authorization: Bearer <token>`; expect a valid MCP response, not a connection refusal | "Live is running but the bridge did not answer on <port>. Restart Live, and check that no other app holds the port." |
| 5   | Token present                         | `bridge.json` contains a non-empty `token`                                                                                                                                | "No token in bridge.json. Reinstall or restart the extension to regenerate it."                                      |

Notes on the checks:

- **Check 1 and check 4 reinforce each other.** Live's host owns the bridge process, so a port that answers on check 4 is the strongest proof Live is up with the extension active. If check 4 passes, check 1 passes.
- **Check 3 floor is Node 24.14.1** (the repo `.nvmrc`). Live's own host already satisfies this; the check matters on the client side if a stdio shim is in play.
- **Check 4 is the one Live touch.** It is a single read-only HTTP probe of the bridge's `/mcp` endpoint with the bearer token from `bridge.json`. Treat any 2xx or a well-formed MCP/JSON-RPC response as PASS. A connection refused or a timeout is the FIX case. A 401 means the token in `bridge.json` does not match what the bridge expects: tell the user to restart the extension so the file and the running bridge agree.

## Output format

Print a compact table, one row per check, each marked `PASS` or `FIX` with the FIX line inline. Then print a single verdict:

```
Loophole /doctor

  1. Live 12 Suite running ............ PASS
  2. Extension installed (bridge.json)  PASS
  3. Node >= 24.14.1 .................. PASS
  4. Bridge port reachable (8420) ..... PASS
  5. Token present .................... PASS

Verdict: ready. Run /setup to wire your MCP client.
```

When something fails, show the FIX line on that row and a count in the verdict:

```
Loophole /doctor

  1. Live 12 Suite running ............ PASS
  2. Extension installed (bridge.json)  FIX: Install the Loophole extension .ablx in Live, Settings, Extensions, then restart Live.
  3. Node >= 24.14.1 .................. PASS
  4. Bridge port reachable ............ FIX: bridge.json not found, so the port is unknown. Resolve check 2 first.
  5. Token present .................... FIX: No token in bridge.json. Reinstall or restart the extension to regenerate it.

Verdict: 3 checks failing. Fix them top to bottom, then re-run /doctor.
```

Fix top to bottom: check 2 (the file) gates checks 4 and 5, since both read `bridge.json`. Do not run `/setup` from here. When the verdict reads ready, tell the user they can run `/setup`.
