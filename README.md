# TaskLight

TaskLight is a shared swarm control plane and live task wall. An external harness deploys and directs agents; agents maintain shared plans, tasks and coarse microtasks in TaskLight. The operator sees agent identity, harness, current work, state, liveness, dependencies and progress. Terminals and human conversations stay in the harness.

On-device Gemini Nano swarm narration through Firebase AI Logic is the showcase; cloud models execute agents, while Firebase hosts the wall at https://tasklight-d59f6.web.app. Retained chat and liaison controls are legacy, with no new investment. Direct human questions to the harness.

## Start here

TaskLight is built for developers and AI agent operators who want local-first project planning, shared memory, and live progress tracking across any MCP-capable coding client.

1. **Set up with your AI assistant:** Open your AI assistant in this folder and say: `Set up TaskLight for me`. Following [AGENTS.md](AGENTS.md) and [docs/SETUP_WITH_AI.md](docs/SETUP_WITH_AI.md), it installs dependencies, builds the extension, configures MCP, starts the wall, and guides you through the browser clicks.
2. **Try the local demo** without installing anything or creating a Firebase project: follow [tools/demo/README_DEMO.md](tools/demo/README_DEMO.md) (or run `node tools/demo/run_demo.mjs`).
3. **Set up manually** by building the extension, installing the native host, and connecting your MCP client with [docs/DESKTOP_SETUP.md](docs/DESKTOP_SETUP.md) and [docs/MCP.md](docs/MCP.md). For browser-free planning and memory, follow [docs/HEADLESS.md](docs/HEADLESS.md).
4. **Use TaskLight from the shell** with the [CLI guide](docs/CLI.md).
5. **Connect Antigravity** using the [desktop app and CLI setup guide](docs/ANTIGRAVITY.md).

All agents follow [docs/PLANNING_CONTRACT.md](docs/PLANNING_CONTRACT.md) (also served over MCP via `tasklight://contract` and the `planning_contract` prompt). See [docs/PLANNING.md](docs/PLANNING.md) and [docs/MODELS.md](docs/MODELS.md) for templates and model routing.

## How it works

- Room: each agent appends plan, memory and progress events to a local room (`events.jsonl`) through the room protocol or the MCP server.
- Native host: a native messaging host reads the room and relays events to the browser extension, retains legacy chat relay controls for room `question` events, and optionally proxies local or network model requests.
- Extension: the Chrome extension service worker links the native host to the hosted wall page.
- Hosted wall: the web page renders the live plan, tasks, microtasks and memory views, and shows shared work and read-only swarm narration with Firebase AI Logic.

## Plans, tasks and microtasks

Any AI agent acting as an MCP client can plan a project from a planning template (`planning-template/v1`) over MCP. TaskLight keeps a project `MEMORY` and a live `PLAN` of phases, dependencies, tasks and verifiable microtasks in the local room log, with shipped `room_export` and `memory_history` tools for Markdown views and accepted memory revisions, while showing progress, blocked states and outcomes on the wall. See [headless usage](docs/HEADLESS.md#5-cli-parity) for the `export` command.

Agents report outcomes and evidence at coarse work boundaries. Nano narration cannot mutate the room or decide acceptance. Private narration stays on-device; when generation is unavailable it uses a labelled **Rules summary**. Cloud fallback for other rooms depends on privacy policy and availability. See the [swarm guide](docs/SWARM.md) for `swarm_coordinator`, `swarm_executor`, and `executor_loop`.

For templates, states and the MCP tool surface, see [docs/PLANNING.md](docs/PLANNING.md) and [docs/MCP.md](docs/MCP.md). To replay a scripted multi-agent plan locally, see [tools/demo/plan_demo](tools/demo/plan_demo).

## Models

`firebase-hybrid` remains the factory default. Swarm narration uses `PREFER_ON_DEVICE` with `gemini-4-hydrogen` cloud fallback only when policy permits it; private rooms remain on-device. The live inference source display identifies the actual source, or **Rules summary** when generation fails. Nano requires a browser; headless planning works without it.

From the **Models** sheet in the wall, you can optionally route supported task groups to your own local model servers or network providers configured through the native host CLI. Endpoints and keys stay on the host—never in browser storage or page JavaScript—and private projects and screenshots never leave the device for a network provider. See [docs/MODELS.md](docs/MODELS.md) for setup and privacy rules.

## Run the local demo

The local demo runs the full path without a Firebase project. See [tools/demo/README_DEMO.md](tools/demo/README_DEMO.md).

## Repository checks

A green [TaskLight CI](.github/workflows/ci.yml) run verifies that TaskLight installs and works from a fresh clone on Linux, Windows, and macOS.

```sh
bash tests/secret_scan/run.sh   # oracle: planted fake secrets must be caught
bash tools/secret_scan.sh       # must report 0 findings before any push
```

## Status

Hackathon build for Firebase #BuildHybridAI.

## License

GNU Affero General Public License v3.0 only (AGPL-3.0-only), see [LICENSE](LICENSE).

If you modify TaskLight and offer it to users over a network, the AGPL requires you to make your modified source code available to them. For a commercial license without the AGPL obligations, contact the copyright holder (dual licensing).
