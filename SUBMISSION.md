# TaskLight — Firebase #BuildHybridAI

## Pitch

TaskLight gives developers running multiple AI agents a shared, live view of who owns each task, what is blocked and where attention is needed. Agents maintain plans, microtasks and project memory through MCP. The browser wall shows reported activity and marks liveness as unknown when observations are missing. Firebase AI Logic summarizes the visible work, with Gemini Nano preferred on device. Terminals and human conversations stay in the external harness. [Project overview](README.md)

## Coordinate and review agent work

With native hooks configured, Claude Code and Codex automatically register sub-agents under their parent session and record observed starts and stops. For any CLI lane, `tasklight run` supervises the command as a direct child process and records its lifecycle. [Native hooks](docs/HARNESS_HOOKS.md) · [CLI supervision](docs/HEADLESS.md#supervise-cli-agents)

The `wait_agents` tool wakes the orchestrator when a matching lane finishes or fails and returns any result the lane supplied. Workers can record a verdict and optional summary, receipt and evidence in the room. The orchestrator records immutable ADMIT, HOLD or REJECT decisions there. The Swarm bubble board shows verdicts and available summaries for finished and failed lanes, and task bubbles show the latest decision. Use `room_export` to generate a Markdown integration log of all recorded results and decisions. [Waiting for results](docs/WAIT_AGENTS.md) · [Results and decisions](docs/RESULTS.md)

The waiter and orchestrator snapshot report errors when room storage cannot be read. Tool validation errors can name the argument and rule. For example, `wait_agents` reports that `agents` must be a nonempty array of agent slugs. [Waiter arguments](docs/WAIT_AGENTS.md#tool-contract) · [Orchestrator snapshots](docs/ORCHESTRATOR.md) · [MCP errors](docs/MCP.md#errors)

The wall also shows each agent's harness, current task and microtask, dependencies and plan progress. Revision checks and retry deduplication support concurrent updates. The plan and shared memory can be exported as Markdown. [Planning and MCP tools](docs/MCP.md)

## How Firebase AI Logic is used

The runtime imports `firebase/ai`, creates a model with `getGenerativeModel` and calls `generateContent` for swarm narration. In `PREFER_ON_DEVICE` mode, Gemini Nano runs on device when available. The configured cloud fallback, `gemini-4-hydrogen`, requires both permission under the room's privacy policy and cloud availability. Private rooms use `ONLY_ON_DEVICE`. [Model guide](docs/MODELS.md)

If generation is unavailable, blocked, fails or returns an ungrounded response, TaskLight uses a deterministic **Rules summary**. The live display labels the actual source as **ON_DEVICE · Gemini Nano**, **IN_CLOUD · gemini-4-hydrogen · fallback**, or **Rules summary**. Read-only narration uses selected coordination facts and checks its structured output against them.

**Firebase Hosting is pending.** The public Firebase configuration and reCAPTCHA site key still contain placeholders. Live Firebase inference requires project setup and model availability. A hosted judge URL is not yet available. [Project status](README.md#status)

## Architecture and privacy

The local room journal stores plan, memory, progress and lifecycle events. Agents access it through MCP and the CLI. The native messaging host relays room events with redaction through the Chrome extension to the browser wall. MCP output and Markdown exports also redact free text. The owner journal retains its original contents, and a sanitizer failure blocks output. Agent identifiers are caller-asserted within the local same-user trust boundary. [MCP output rules](docs/MCP.md#tools)

The production Firebase path initializes App Check with reCAPTCHA Enterprise and token auto-refresh. Startup requires real configuration and successful App Check initialization. Production rejects debug tokens.

## How judges try it

The local demo needs a Chrome-family browser and Python. Install dependencies with `npm ci`, then run `node tools/demo/run_demo.mjs --keep` from the repository root. The demo exercises the native host, extension, wall, MCP planning and shared memory, using Rules output. Once hosting is configured, use the desktop setup guide to connect the extension, native host and MCP client, then open Swarm to see the live narration source. [Local demo](tools/demo/README_DEMO.md) · [Desktop setup](docs/DESKTOP_SETUP.md)

## Hackathon work and licence

TaskLight was created during the contest period. The room protocol is a clean-room design. The project excludes third-party proprietary code and declares its open-source dependencies in `package.json`. TaskLight is licensed under AGPL-3.0-only. [Pre-existing work statement](PREEXISTING.md) · [Licence](LICENSE)
