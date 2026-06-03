# Registry publish, prep only

This file is internal launch prep. Nothing here is executed in this wave. No package is published, no registry entry is submitted, no repo setting is changed. Every step below runs only after the user approves that specific action and the pre-flight gate in `LAUNCH_WEEK.md` passes.

The three identifiers used everywhere in `launch/`:

| Surface                | Value                         |
| ---------------------- | ----------------------------- |
| npm package            | `@othmanadi/ableton-mcp`      |
| official registry name | `io.github.OthmanAdi/ableton` |
| GitHub repo            | `OthmanAdi/loophole`          |

## npm is a hard prerequisite for the official registry

The official registry (`registry.modelcontextprotocol.io`) hosts metadata, not the artifact. For an npm-backed server it verifies npm ownership before it will publish, and it does that by matching a field in the published `package.json` to the `name` in `server.json`. So the package must already be on npm, carrying that field, before `mcp-publisher publish` can succeed. Listing on the registry before the npm package exists is impossible, not just inadvisable. The real ordering is: npm publish, then official registry, then fan out.

Two manifest edits are publish-time prerequisites. They are written here as prerequisites, not applied in this wave, so that nothing in the to-be-published manifest is mutated before launch.

1. **Add `mcpName` to `packages/mcp/package.json`.** The registry reads this to verify you own the npm package. It must equal the `server.json` `name` exactly:
   ```jsonc
   // packages/mcp/package.json
   {
     "name": "@othmanadi/ableton-mcp",
     "mcpName": "io.github.OthmanAdi/ableton",
   }
   ```
2. **Move `@othmanadi/loophole-core` from `dependencies` to `devDependencies` in `packages/mcp/package.json`.** Today it is a `workspace:*` runtime dependency. `@othmanadi/loophole-core` is private and never published, so a consumer running `npm install @othmanadi/ableton-mcp` would fail to resolve a `workspace:*` dependency on a package that is not on npm. The bridge build already inlines core (tsup `noExternal`), so at publish time the dependency is build-only. This matches `ARCHITECTURE_DECISIONS.md` §3. Regenerate `pnpm-lock.yaml` after the move and keep CI green.

## Publish sequence (run only with per-action approval)

```bash
# 0. Prerequisites done: mcpName added, loophole-core moved to devDependencies,
#    version set to the real release version in package.json AND launch/server.json,
#    repo polished, artifact tested in Live, prior art re-checked, prose humanized,
#    user approves THIS publish (see LAUNCH_WEEK.md day 0/1).

# 1. Publish the package to npm (metadata host for the registry; the tarball self-contains core)
npm publish --access public           # from packages/mcp, with "mcpName" set

# 2. Install mcp-publisher (Windows: download mcp-publisher_windows_<arch>.tar.gz, put the binary on PATH)

# 3. Generate, then reconcile server.json against the staged draft in launch/server.json
mcp-publisher init                    # writes a starter server.json; align it with launch/server.json
                                      #   name MUST equal package.json "mcpName"

# 4. Authenticate and publish the metadata
mcp-publisher login github            # GitHub device-code flow
mcp-publisher publish                 # validates schema, verifies npm ownership, publishes metadata
```

After the official listing lands, automate re-publishing on each release with GitHub Actions OIDC (no browser, no stored token), then fan out to the secondary registries and the awesome-list PRs.

## Open items to verify at publish time

- **Schema and field names.** `launch/server.json` was drafted from the `2025-12-11` schema reference (`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`) and the `04_LAUNCH_SPEC` workflow. Re-fetch the live registry docs before publishing and confirm the field names and the schema date still match; keep the staged `$schema` date unless the live registry has moved on.
- **Transport honesty.** The bridge runs inside Ableton's Extension Host and binds streamable-http to `127.0.0.1` on a probed port (`8420-8429`) written to `storageDirectory/bridge.json`. It is not a standalone server launched with a fixed URL, and `@othmanadi/ableton-mcp` exports `buildServer` as a library, not an `npx` entry. The draft therefore claims no fixed `remotes[].url` and no `runtimeHint`/`npx`. Decide at publish time whether the per-machine local URL belongs in a `remotes[]` entry with a `{port}` variable or stays implicit on the package transport, and pick whichever validates without implying a runnable hosted endpoint. The same honesty gate that governs the install pages applies here: no metadata that implies a working `npx @othmanadi/ableton-mcp` or a public URL that does not exist.
- **Version.** Set the real published version in both `version` fields of `server.json` and in `package.json` before publishing.

## Registry list and priority order (04 §3.2)

Compounding comes from being listed where people browse, not from one post. The order is leverage, not reach. Spikes (Hacker News, Product Hunt, Reddit) only seed the indexes and never run before the indexes exist.

1. **MCP registries.** Official `registry.modelcontextprotocol.io` first (name `io.github.OthmanAdi/ableton`, npm-gated, see above), then Glama, PulseMCP, Smithery after the official listing lands.
2. **Create and seed `awesome-ableton-extensions`** (owning the category list means every future builder links back), plus a PR to **`punkpeye/awesome-mcp-servers`**. Drafts in `AWESOME_ENTRIES.md`.
3. **Ableton Discord `#extensions-gallery`** (highest-intent producer channel, and the only venue to show Ableton the work; §4.3). Producers, so lead with an extension video, not the bridge.
4. **GitHub repo, topics, and the awesome-list PRs** (`Sinzear/awesome-ableton`). Topics recommendation in `SEO.md`.
5. **YouTube creator outreach** (highest-variance hour; one mid-tier educator demo beats an HN front page).
6. **dev.to tutorials** (own the empty SEO lane; canonical points at the docs site).
7. **npm publish** (server plus scaffold). Low as a discovery channel, but the hard prerequisite above for the registry.
8. **X build-log.**
9. **Spikes as seeds only:** Hacker News, Product Hunt, Reddit.

The full day-by-day execution, each row gated by the pre-flight check, is in `LAUNCH_WEEK.md`.
