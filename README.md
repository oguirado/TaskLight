# TaskLight

TaskLight is a live task wall where AI agents turn plans into tasks and microtasks as they work. On-device Gemini Nano, used through Firebase AI Logic, reviews plan progress and drift privately on your machine, with a hybrid fallback to cloud Gemini when the on-device model is unavailable and the project's privacy tier allows it. A local room protocol and an MCP server let any MCP client publish plans, memory and progress to the wall.

## How it works

- Room: each agent appends plan, memory and progress events to a local room (`events.jsonl`) through the room protocol or the MCP server.
- Native host: a native messaging host reads the room and relays events to the browser extension, relays chat messages back as room `question` events, and optionally proxies local or network model requests.
- Extension: the Chrome extension service worker links the native host to the hosted wall page.
- Hosted wall: the web page renders the live plan, tasks, microtasks and memory views, and runs task and drift review with Firebase AI Logic hybrid inference.

## Plans, tasks and microtasks

Any AI agent acting as an MCP client can plan a project from a planning template (`planning-template/v1`) over MCP. TaskLight keeps a project `MEMORY` and a live `PLAN` of phases, dependencies, tasks and verifiable microtasks in the local room log, exporting human-readable `PLAN.md` and `MEMORY.md` views while showing progress, blocked states and outcomes on the wall.

While any MCP client can author and update the plan, on-device Gemini Nano through Firebase AI Logic reviews each task against its acceptance criteria and checks for plan drift locally. Plan and memory data stay on your machine.

For templates, states and the MCP tool surface, see [docs/PLANNING.md](docs/PLANNING.md) and [docs/MCP.md](docs/MCP.md). To replay a scripted multi-agent plan locally, see [tools/demo/plan_demo](tools/demo/plan_demo).

## Models

Firebase AI Logic hybrid inference is the default for every task group: Gemini Nano runs on device first, falling back to cloud Gemini when needed and allowed by the project's privacy policy.

From the **Models** sheet in the wall, you can optionally route supported task groups to your own local model servers or network providers configured through the native host CLI. Endpoints and keys stay on the host—never in browser storage or page JavaScript—and private projects and screenshots never leave the device for a network provider. See [docs/MODELS.md](docs/MODELS.md) for setup and privacy rules.

## Run the local demo

The local demo runs the full path without a Firebase project. See [tools/demo/README_DEMO.md](tools/demo/README_DEMO.md).

## Repository checks

```sh
bash tests/secret_scan/run.sh   # oracle: planted fake secrets must be caught
bash tools/secret_scan.sh       # must report 0 findings before any push
```

## Status

Hackathon build for Firebase #BuildHybridAI. The Firebase project is pending, so hosted features are not yet deployed.

## License

GNU Affero General Public License v3.0 only (AGPL-3.0-only), see [LICENSE](LICENSE).

If you modify TaskLight and offer it to users over a network, the AGPL requires you to make your modified source code available to them. For a commercial license without the AGPL obligations, contact the copyright holder (dual licensing).
