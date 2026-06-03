# Awesome-list entries (drafts, not submitted)

Drafts only. No PR is opened and no list is created in this wave. Submit each only after the pre-flight gate in `LAUNCH_WEEK.md` passes and the user approves that specific submission. Re-confirm each list's current format and category headings at submission time, since they change.

## punkpeye/awesome-mcp-servers (PR)

Format confirmed from the list README: `- [owner/repo](link) [optional score badge] <language marker> <scope marker> <OS markers> - Description`. Markers that apply to Loophole:

- 📇 TypeScript / JavaScript (the bridge is TS/Node).
- 🏠 Local Service (the bridge binds to `127.0.0.1` inside Ableton's Extension Host; it is not a cloud service).
- 🪟 🍎 Windows and macOS (the platforms Ableton Live 12 runs on).
- No 🎖️ marker: that means an official implementation by the protocol or platform owner. Loophole is built on Ableton's official Extensions SDK but is not an Ableton or Anthropic implementation, so the marker would be a false claim. Do not add it.

Likely category: **Art & Culture** (where the existing music servers such as Spotify and Apple Music sit). Confirm the heading at submission time.

Draft entry:

```
- [OthmanAdi/loophole](https://github.com/OthmanAdi/loophole) 📇 🏠 🪟 🍎 - Control Ableton Live from any LLM. The first MCP server built on Ableton's official Extensions SDK: one .ablx, no Remote Script, no Max for Live.
```

The score badge (`glama.ai/mcp/servers/...`) is added by the list tooling or after a Glama listing exists. Do not paste a badge that does not resolve yet.

## awesome-ableton-extensions (new list we create and seed)

This list does not exist yet. The plan (04 §3.2) is to create and own it, since owning the category list means every future Extensions-SDK builder links back. Seed it with Loophole and with the prior-art extensions already found, so it reads as a genuine index, not a self-listing. Credit the SDK and the existing community work.

Seed Loophole Kit entry (one line, honest):

```
- [OthmanAdi/loophole](https://github.com/OthmanAdi/loophole) - The Loophole Kit: five focused Ableton extensions (Session-to-Song, Gain Stage Doctor, Set Janitor, Scale Lock, Humanize), plus the Loophole Bridge MCP server. Built on the official Extensions SDK, installs as one .ablx. Beta.
```

Other extensions to seed it with (found during the prior-art check; verify each before listing):

```
- [federico-pepe/ableton-live-extensions](https://github.com/federico-pepe/ableton-live-extensions) - A collection of experiments with the Ableton Extensions SDK.
```

Plus a link out to the official SDK and the broader Ableton resource list, so the index is useful rather than promotional:

```
- [Ableton Extensions SDK](https://ableton.github.io/extensions-sdk/) - The official SDK these extensions are built on.
- [Sinzear/awesome-ableton](https://github.com/Sinzear/awesome-ableton) - The broader curated list of Ableton resources.
```

Keep the description for every entry to one honest line. No "first" claim on entries other than Loophole's, and even there the claim stays the exact allowed wording.
