# Loophole

**Loophole is an Ableton MCP server and extension kit: control Ableton Live from Claude and any LLM through one `.ablx` you install in Settings.** No Remote Script, no AbletonOSC, no Max for Live.

Loophole is two things that feed each other:

- **The Loophole Kit:** a small set of focused Ableton extensions for the chores that eat studio time (arrangement, gain staging, set hygiene, scale, groove).
- **The Loophole Bridge:** an MCP server that lets an LLM (Claude, Cursor, any MCP client) read and edit your Live Set through the same official API the Kit uses.

Each proves the other. The Kit shows the API does real work and reaches producers; the Bridge reaches the dev and AI crowd. One brand, one flywheel, one install path.

> **Status:** early/pre-release. The Ableton Extensions SDK shipped as a public beta on 2026-06-02 and Loophole is being built in the open against it. Code lands wave by wave (see the [roadmap](#build-wave-roadmap)). Treat everything here as a working spec until the wave that ships it is marked done.

---

## What is actually new

There are already good ways to point an LLM at Ableton. They all reach Live from _outside_ it: a Python Remote Script over a socket (the original `ableton-mcp`), OSC via AbletonOSC, or a Max for Live device. Each works, and each carries the install friction and version fragility of the surface it rides on.

Loophole runs _inside_ Live, on Ableton's official Extensions SDK (announced 2026-06-02). That is the one genuinely unclaimed lane, and it is the only "first" Loophole claims:

> **The first MCP server built on Ableton's official Extensions SDK.**

What that buys a user:

- **One file.** Install a single `.ablx` in Live's Settings. No hidden Remote Scripts folder, no AbletonOSC, no Max for Live, no Developer Mode for a packaged build.
- **The supported surface.** A typed, first-party Node.js API instead of an unofficial socket or an OSC bridge.
- **Your stack.** TypeScript and Node, end to end.

That is the whole claim. Read the [prior art](#built-on-and-prior-art) section before you read "first" as anything bigger.

---

## How it works

The Bridge does not run as a standalone process you launch. It boots _inside_ Live's Extension Host (the persistent Node process Ableton owns) when the extension activates, and it binds an HTTP server to loopback. Your MCP client connects to that.

```
  Claude / Cursor / any MCP client            Ableton Live 12 Suite
  ┌────────────────────────────┐      ┌──────────────────────────────────┐
  │ MCP client                  │      │ Extension Host (persistent Node)   │
  │  transport: streamable-http │ HTTP │  ┌──────────────────────────────┐ │
  │  url: http://127.0.0.1:PORT ├─────▶│  │ Loophole Bridge (MCP server)  │ │
  │  Authorization: Bearer …    │◀─────┤  │  tools + WriteQueue + resolver │ │
  └────────────────────────────┘ +SSE │  └──────────────┬───────────────┘ │
                                       │   sync reads     │  async writes    │
                                       │  ┌───────────────▼────────────────┐│
                                       │  │ Live Set: song ▸ tracks ▸ clips ││
                                       │  │ ▸ notes ▸ devices ▸ params ▸ …  ││
                                       │  └─────────────────────────────────┘│
                                       └──────────────────────────────────────┘
```

The server addresses objects by stable path ids (`track:2/clipslot:4`) that re-resolve on every call, so nothing host-local ever crosses the wire. Reads are synchronous. Every write serializes through one queue and is wrapped so that one tool call equals one Live undo step.

---

## The deterministic command layer, and a thin AI surface

The tools are the product. Each one is a deterministic command: validated input (Zod), a single well-defined effect on the Set, a structured result. The LLM only decides _which_ command to run and _with what arguments_. It never touches Live directly.

That split is the safety story and the test story. The deterministic layer is covered by fast unit and in-process integration tests that need no running Live. The stochastic layer (does the model pick the right tool for "shift this up an octave") is one small eval suite, run nightly, not on every commit. Most of the assertions are deterministic; the AI surface stays small on purpose.

---

## The Loophole Kit (planned)

Five extensions under one kit. All are planned and land across the waves below; none ship before its wave is marked done.

| Extension                              | What it does                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session-to-Song Builder** (flagship) | Places your actual Session clips into a finished, named, colored, cue-pointed Arrangement. Aimed at loopitis: the most-cited reason tracks never finish. |
| **Gain Stage Doctor**                  | Renders pre-FX audio, measures peak/RMS/crest, writes a corrective mixer trim in one undo step. Measurement, not taste.                                  |
| **Set Janitor**                        | Whole-set hygiene sweep: empty tracks, unnamed clips, inconsistent colors, overrunning loops, fixed in one transaction.                                  |
| **Scale Lock**                         | Snaps MIDI to the scale already set in the Live Set, so the result is correct by construction.                                                           |
| **Humanize**                           | Nudges note timing, velocity, and probability off the grid for quick, musical passes.                                                                    |

**Beta limits, stated plainly.** The Extensions SDK is v1.0.0-beta: `renderPreFxAudio` is pre-FX and audio-tracks-only; device insertion is built-in Live devices only; there is no automation, CC, clip-gain, or routing API; extensions are user-invoked, never auto-triggered; assume 4/4 unless a scene signature is read. These shape what the Kit and the Bridge can and cannot do today.

---

## Quickstart (pre-release)

There is no published package or `.ablx` yet. This section will fill in as the waves ship. Right now the honest path is:

1. Read the [build-wave roadmap](#build-wave-roadmap) to see what exists.
2. Clone the repo and run the test suite (no Live or Ableton license needed for rings 1 and 2): see [CONTRIBUTING.md](CONTRIBUTING.md).
3. Watch the roadmap. The first end-to-end install path lands with W1 (Scale Lock) for the Kit and W4 for the Bridge.

When the Bridge ships, the install will be: install one `.ablx` in Live's Settings, copy the printed `127.0.0.1:PORT` and token, paste them into your MCP client. That is the whole setup.

---

## Monorepo layout

```
loophole/
├─ packages/
│  ├─ mcp/         @othmanadi/ableton-mcp  — the Bridge, published, transport-agnostic
│  └─ extension/   @othmanadi/loophole-extension — the .ablx shell, private (placeholder in W0)
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ README.md  CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md  LICENSE
```

The split is deliberate. The published `mcp` package stays small, audited, and free of Live's beta SDK. The `extension` package is the deployment shell that imports it and packages to `.ablx`. The only file that ever imports the Ableton SDK is one adapter behind a `LiveBridge` interface, which is why the whole server is testable without Live (see [CONTRIBUTING.md](CONTRIBUTING.md)).

---

## Built on, and prior art

Loophole stands on work that came first, and credits it.

- **[Ableton Extensions SDK](https://ableton.github.io/extensions-sdk/)** is the foundation. Loophole is an Extensions-SDK consumer, not affiliated with or endorsed by Ableton.
- **[ahujasid/ableton-mcp](https://github.com/ahujasid/ableton-mcp)** defined the category (Claude controlling Live via an MCP server) and carries the mindshare. Loophole differs in one concrete way: it runs on the official SDK, so there is no Remote Script to install.
- **[Producer Pal](https://producer-pal.org/)** ([adamjmurray/producer-pal](https://github.com/adamjmurray/producer-pal)) is the craft bar: a polished, multi-LLM Max for Live MCP with its own docs site. Loophole treats it as the bar to match, not as an opponent, and differs on transport (official SDK vs Max for Live).
- **[ableton-js](https://github.com/leolabs/ableton-js)** and **[AbletonOSC](https://github.com/ideoforms/AbletonOSC)** are the Node and OSC prior art the older bridges stand on. Same idea, different (unofficial) surface.

What Loophole does **not** claim: not "first Ableton MCP" (ahujasid got there in 2025), not "first AI for Live" (Producer Pal exists), not "most complete coverage" (the API is beta with documented gaps). The architecture is the story, not the word "first."

---

## Build-wave roadmap

Sequenced so each wave ships standalone value and de-risks the next. Full detail lives in the mission plan; this is the summary.

| Wave   | Milestone                    | One line                                                                                                                                        |
| ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **W0** | Repo skeleton                | pnpm monorepo, strict TS base, ESLint + Prettier, Vitest, the `LiveBridge` seam + `FakeLiveBridge`, CI. Tests green with no Live.               |
| **W1** | Scale Lock                   | First extension end to end: MIDI read-map-write, packaged `.ablx`, runs in Live, one undo reverts.                                              |
| **W2** | Humanize                     | Reuses the W1 MIDI loop; timing, velocity, and probability deviation.                                                                           |
| **W3** | Gain Stage Doctor            | Render pre-FX audio, measure peak/RMS/crest, write a corrective trim in one undo.                                                               |
| **W4** | Loophole Bridge v0.1         | The headline: in-process HTTP MCP server with the first ~12 tools and read-only resources. Claude connects over loopback and edits a real clip. |
| **W5** | Session-to-Song Builder      | The flagship extension: turn a Session full of loops into a finished Arrangement in one transaction.                                            |
| **W6** | Set Janitor                  | Broadest read pass: empties, bad names, colors, overruns, fixed in one transaction.                                                             |
| **W7** | Docs site, registries, skill | Docs site with an auto-generated tool reference, registry listings, a `/doctor` + `/setup` helper skill.                                        |
| **W8** | Launch week                  | Registries and indexes first, spikes second.                                                                                                    |

This README ships at W0 against that plan. Sections describing later waves are the spec for what those waves deliver.

---

## Contributing, security, license

- **[CONTRIBUTING.md](CONTRIBUTING.md):** the `LiveBridge` rule, how to run the three test rings (rings 1 and 2 need no Ableton license), commit and PR expectations.
- **[SECURITY.md](SECURITY.md):** private disclosure path. The Bridge binds loopback only and requires a bearer token.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md):** Contributor Covenant.
- **License:** [MIT](LICENSE).

Built by [Ahmad-Othman](https://github.com/OthmanAdi) (CodingWithAdi).
