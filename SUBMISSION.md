# TaskLight — Firebase #BuildHybridAI

## Pitch

TaskLight gives developers running multiple AI agents a shared, live view of who is doing what, what is blocked, and where attention is needed. Agents maintain plans, coarse microtasks and project memory through MCP; the operator follows their work on a browser wall. Firebase AI Logic powers read-only swarm narration, preferring on-device Gemini Nano and allowing cloud fallback only under the room's privacy policy. The value is less context switching between agent conversations and a clearer handoff when work spans several assistants.

## The problem

As agents work in parallel, operators lose track of ownership, dependencies, progress and missing updates. Conversations and terminals contain fragments of the story. TaskLight brings reported work into a shared view and explicitly distinguishes observed activity from unknown liveness, so silence does not imply that an agent is working.

## What TaskLight does

The wall shows agent identity, harness, current task and microtask, lifecycle, liveness, dependency owners and plan progress. Agents coordinate through planning templates, task claims, revision checks and retry deduplication. Shared memory retains accepted revisions and can be exported alongside the plan as Markdown. Task details and archived plans preserve context across work sessions.

External harnesses deploy and direct agents; TaskLight displays and coordinates their reported work. Terminals and human conversations remain in the harness. Narration does not verify implementation quality or grant acceptance.

## How Firebase AI Logic is used

The runtime imports `firebase/ai`, creates a model with `getGenerativeModel`, and calls `generateContent` for swarm narration. The hybrid mode is `PREFER_ON_DEVICE`: Gemini Nano runs on device when available, with `gemini-4-hydrogen` as the configured cloud fallback only when privacy policy and cloud availability permit it.

Private rooms select `ONLY_ON_DEVICE`, without cloud narration. If generation is unavailable, blocked, fails, or returns an ungrounded response, a deterministic **Rules summary** remains available. The narrator validates structured output against current agent facts. Its live source display identifies **ON_DEVICE · Gemini Nano**, **IN_CLOUD · gemini-4-hydrogen · fallback**, or **Rules summary**, rather than presenting a configured preference as an actual inference result.

Narration never mutates the room, claims tasks, completes work or decides acceptance. Its input contains selected coordination facts rather than task titles, evidence or full history.

**Hosting is pending until the Firebase project is configured.** The public Firebase configuration and reCAPTCHA site key still contain placeholders; the hosted application is not yet deployed. Live Firebase inference therefore requires setup and model availability.

## Architecture

- **Local room journal:** append-only plan, memory and progress events provide shared state.
- **MCP server and CLI:** agents read and update the room, with serialized writes, revision checks and idempotent retries.
- **Native messaging host:** reads room events and relays them to the browser with redaction.
- **Chrome extension:** connects the native host to the wall page.
- **Browser wall and narrator:** render shared work and policy-gated Firebase AI Logic summaries; Firebase Hosting is the deployment target.

## Privacy and security

The Firebase production boot path initializes App Check with reCAPTCHA Enterprise and token auto-refresh. Placeholder configuration or an App Check initialization failure blocks startup; production rejects debug tokens. Deployment still needs project-side configuration.

The browser relay redacts sensitive strings before delivery. This is a display boundary, not a guarantee that local journals, MCP reads or exports contain no sensitive data. Private-room narration stays on device or uses Rules. External harness traffic follows the harness's own data policies. Local room access is a same-user trust boundary: agent identifiers are caller-asserted, not authenticated identities.

## How judges try it

For the local demo without a Firebase project, follow [the demo guide](tools/demo/README_DEMO.md). Install dependencies with `npm ci`, then run `node tools/demo/run_demo.mjs --keep` from the repository root. A Chrome-family browser and Python are required. The demo exercises the native-host/extension/wall connection, plan rendering, MCP planning and shared memory; Rules output does not demonstrate live Firebase inference.

Once deployed, open the published wall and follow [desktop setup](docs/DESKTOP_SETUP.md) to connect the extension, native host and MCP client. Inspect the Swarm view and refresh narration to check its actual inference source. A hosted judge URL is not yet available.

## Hackathon work and pre-existing material

[PREEXISTING.md](PREEXISTING.md) declares that this project was created during the contest period and that the room protocol is a clean-room design. The submitted project includes the room protocol, planning and memory tools, browser wall, extension bridge and hybrid narration. Open-source dependencies are declared in `package.json`; no third-party proprietary code is included, according to that statement.

## Licence

TaskLight is licensed under **AGPL-3.0-only**, an OSI-approved open-source licence. See [LICENSE](LICENSE).
