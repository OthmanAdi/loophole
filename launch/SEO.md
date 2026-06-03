# SEO recommendations (staged, not applied)

Recommended values only. This wave does not change any repo setting; setting the description and topics is the user's or the orchestrator's call. The job here is to stage the exact recommended values so applying them later is a copy-paste.

The honesty rule holds throughout: maximum legitimate reach, no keyword spam, no false claim. The only "first" claim allowed anywhere is "first MCP server built on Ableton's official Extensions SDK."

## Repo description (recommended, verbatim)

Set the GitHub repo `description` and the registry `description` to this one sentence. It carries the ranking phrases ("Ableton Live", "MCP", "Extensions SDK") and the one allowed "first" claim, and a stranger understands it:

> Control Ableton Live from any LLM. The first MCP server built on Ableton's official Extensions SDK: one .ablx, no Remote Script, no Max for Live.

Paste it as plain text (no backticks; the GitHub description field is not markdown). It is the same string used in `launch/server.json` `description` and recommended for the docs `astro.config` `description`, so every surface matches.

## GitHub topics

### Currently set (18, read live from `OthmanAdi/loophole` on 2026-06-03)

```
ableton            ableton-extensions   ableton-live      ableton-mcp
ai                 anthropic-claude     claude            daw
extensions-sdk     llm                  mcp               mcp-server
midi               model-context-protocol  music-production  nodejs
tool-use           typescript
```

These are accurate to the repo and cover the core ranking terms. The count matches the "W0 set 18" note in the spec.

### Recommended additions (3)

The launch spec §6.1 lists a target set; three of its tokens are not yet on the repo. All three are accurate and worth adding:

| Add        | Why                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `ablx`     | The file extension users search for ("ableton .ablx install"); an empty-niche term the bare official docs do not own. |
| `loophole` | The brand and the awesome-list discovery hook; matches the project name.                                              |
| `ai-music` | Broad discovery term for the producer-and-AI crowd; pairs with the existing `music-production`.                       |

### Note on the 20-topic cap

GitHub allows at most 20 topics per repo. The repo has 18, so only two of the three additions fit without dropping one. Recommendation: add `ablx` and `loophole` first (both are exact, high-intent, and brand-load-bearing). `ai-music` is the optional third; add it only if a current topic is dropped. The weakest current topic to drop, if room is wanted, is `tool-use` (the least-searched of the set and already implied by `mcp`). Final call is the user's; nothing is changed here.

The rest of the spec's target set (`ableton-live`, `ableton-extensions`, `extensions-sdk`, `mcp`, `model-context-protocol`, `mcp-server`, `daw`, `music-production`, `typescript`, `nodejs`, `claude`) is already present, so no action is needed for those.

## Docs site SEO (04 §6.3, for when the docs wave ships)

The docs site is the durable asset that outranks every repo and every spike, so it gets the full treatment:

- Set `site` to the absolute domain (`https://docs.loophole.dev`) in `astro.config` so canonical URLs and `sitemap.xml` are correct.
- Target the empty-niche queries the SDK launch created: `ableton mcp`, `ableton extensions sdk`, `control ableton with claude`, `ableton extensions tutorial`, `ableton .ablx install`, `humanize midi ableton ai`. Put the exact phrase in the page `<h1>` and first paragraph of the page meant to rank for it.
- Each recipe page is its own long-tail SEO surface ("how to humanize midi in ableton with ai"). The `/build-your-own/` pages target "ableton extensions sdk tutorial", a query the bare official docs do not satisfy.
- Clean per-page `<title>` and meta (Starlight emits these), a real `description` per page, and an Open Graph image (the wordmark or a screenshot).
- Ship `/llms.txt` for the IDE-agent audience, framed honestly: cheap and well-targeted at agents, not a general traffic engine.
- Cross-post dev.to tutorials with the docs site as canonical to avoid SEO dilution.

## README SEO (every repo)

Run `/seo` and `/seo-strategy` plus the README skills on each repo README. The current root README already leads with architecture, states the one allowed "first" claim, credits prior art, and states beta limits up front, which is the honest-SEO posture the spec asks for. Keep keyword phrases in the first paragraph; do not pad with keyword spam.
