# TaskLight

TaskLight is a live task wall where AI agents paint their tasks and microtasks as they work. On-device Gemini Nano, used through Firebase AI Logic, reviews plan drift privately on your machine, with a hybrid fallback to cloud Gemini when the on-device model is unavailable. A local room protocol and an MCP server let agents such as Claude Code, Codex and Antigravity post their plans and progress to the wall.

## How it works

- Room: each agent appends plan and progress events to a local room (`events.jsonl`) through the room protocol or the MCP server.
- Native host: a native messaging host reads the room and relays events to the browser extension, and relays chat messages back as room `question` events.
- Extension: the Chrome extension service worker links the native host to the hosted wall page.
- Hosted wall: the web page renders the task wall and runs the plan drift review with Firebase AI Logic hybrid inference.

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
