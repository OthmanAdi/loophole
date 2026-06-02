# Security Policy

Loophole lets an LLM read and edit a user's Ableton Live project. That makes it a real attack surface, and we treat it as one. This document covers how to report a vulnerability and the trust model the Bridge runs under.

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue or pull request.

- Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. This opens a private advisory visible only to the maintainer and you.
- Include enough to reproduce: what you did, what happened, the Live build, your OS, your Node version, and the Loophole and SDK API versions if relevant.

You will get an acknowledgement within 5 business days and a status update within 10. We will agree a disclosure timeline with you before anything is made public, and credit you in the advisory unless you ask us not to.

Please do not run automated scanners against anyone else's machine, and do not test against a Live Set you do not own.

## The Bridge trust model

The Loophole Bridge is an HTTP MCP server that boots inside Live's Extension Host. Two controls keep a stray local process or web page from driving someone's Live Set:

- **Loopback bind only.** The server binds to `127.0.0.1`, never `0.0.0.0`. It is not reachable from the network. An `Origin` check rejects cross-origin requests.
- **Bearer token.** A token is generated on first run and written to the extension's per-extension storage directory. Every request must present it. The user copies the printed `127.0.0.1:PORT` and token into their MCP client; nothing else can connect.

Further boundaries, by design:

- **No filesystem beyond the extension's own directories.** File arguments are validated against the SDK-scoped `storageDirectory` and `tempDirectory`. Path traversal is rejected. The Bridge does not widen the filesystem surface the SDK gives it.
- **Writes are explicit and undoable.** Every mutation serializes through one queue and is wrapped so one tool call equals one Live undo step. A user can always revert.
- **Secrets stay in the storage directory.** Any credential the extension needs lives in the per-extension storage directory, never in the repository and never inside the shipped `.ablx`.

## Supply chain

Loophole follows a hardened install and publish policy:

- `pnpm install --ignore-scripts` everywhere, including CI.
- Exact-pinned dependency versions and a committed lockfile.
- A minimal runtime dependency tree, audited deliberately.
- `npm audit` (high and above) in CI.
- Publishing via npm Trusted Publishing (OIDC), so no long-lived npm token is stored, and provenance is attached automatically.

## Scope

This policy covers the code in this repository. Vulnerabilities in the Ableton Extensions SDK itself, in Ableton Live, or in third-party MCP clients should be reported to those projects. If a Loophole issue depends on an SDK behavior, report it here too so we can mitigate on our side.
