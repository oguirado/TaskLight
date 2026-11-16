# Model Selection in TaskLight

TaskLight lets you choose which model runs each task group while keeping Firebase AI Logic hybrid inference as the default and safety net.

## Why Firebase AI Logic Hybrid Is the Default

`firebase-hybrid` is the factory default for every task group and requires no local host setup. It runs Gemini Nano on your device first and falls back to Gemini in the cloud when the on-device model is unavailable and project privacy allows it. App Check remains mandatory for the Firebase path and is never weakened by external providers.

Every external provider chain falls back at most once to Firebase:
- For non-private tasks: `[selected] -> firebase-hybrid -> Rules`
- For `private` tasks: `[selected local] -> firebase-ondevice -> Rules`

If the native host is absent or an external server fails, times out, or returns invalid JSON, TaskLight stays functional by falling back automatically.

## Provider Kinds

| Kind | Transport | Behaviour |
|---|---|---|
| `firebase-hybrid` (default) | Firebase AI Logic SDK | Uses Remote Config per-task modes; prefers on-device Gemini Nano with cloud Gemini fallback. |
| `firebase-ondevice` | Firebase AI Logic SDK | Forces `ONLY_ON_DEVICE` mode; never sends data to the cloud. |
| `firebase-cloud` | Firebase AI Logic SDK | Forces `ONLY_IN_CLOUD` mode; refused when `kill_switch_cloud` is active, and never offered for `private` or `screenshot`. |
| `local-openai-compatible` | Page -> extension -> native host -> loopback HTTP/HTTPS | Calls a local OpenAI-compatible server. The native host verifies at connect time that the host resolves to loopback and refuses redirects. |
| `remote-openai-compatible` | Page -> extension -> native host -> HTTPS | Calls a remote OpenAI-compatible provider. HTTPS only, redirects refused, and the API key is held exclusively by the native host. |

## Privacy Rules by Tier

Privacy policy is fail-closed and takes precedence over user selection and Remote Config modes:

| Tier / Task | `firebase-ondevice` | `firebase-cloud` | `local-openai-compatible` (loopback) | `remote-openai-compatible` |
|---|---|---|---|---|
| `private` | Allowed | Denied | Allowed only when `allow_private` is enabled for that endpoint in the host config | Denied (no override) |
| `standard` | Allowed | Allowed | Allowed | Allowed if endpoint is enabled |
| `shared` | Allowed | Allowed | Allowed | Denied |
| `screenshot` (any tier) | Allowed | Denied | Denied | Denied (no override) |

## Liaison task group

The `liaison` task group uses `firebase-hybrid` as its factory default and
can be assigned a user-configured endpoint under the same privacy rules
as other groups. Network models are optional user-configured endpoints;
TaskLight supplies no bundled network provider selection or credentials.
The liaison drafts, clarifies, and summarizes. It never sends to executors
without human action and cannot claim tasks, complete work, or issue rulings.
An unavailable model leaves the human's draft and direct messaging available.
Browser on-device inference requires the browser; headless planning and
memory remain usable without inference. See [HEADLESS.md](HEADLESS.md).

## Configuring Endpoints in the Native Host

TaskLight ships zero third-party endpoints, API keys, or external SDKs. You bring your own endpoint and credentials, and you are responsible for complying with your chosen provider's terms of service.

The desktop config is `$CW_HOME/wall.config.json` when `CW_HOME` is set,
otherwise `~/.context-wall/wall.config.json`. The historical
`.contextwall/wall.config.json` path is not a supported default.

To enable the model relay in the native host, add `"models": {}` (or `{"models": {"home": "<dir>"}}` to override the storage directory) in your local `wall.config.json`:

1. Enable the relay in `wall.config.json` with `"models": {}` (optionally `{"home": "<dir>"}`).
2. Manage endpoints using the native host models CLI (`python3 -m bridge.models`):
   - Add an endpoint:
     `python3 -m bridge.models add --id ID --kind local|remote --base-url URL --model NAME [--label L] [--allow-private] [--rung N]`
     (use `--allow-private` only for trusted local endpoints that should serve `private` projects).
   - Set or clear an API key (read from stdin or a hidden prompt, never from `argv`):
     `python3 -m bridge.models set-key --id ID [--clear]`
   - List, probe, or remove endpoints:
     `python3 -m bridge.models list`
     `python3 -m bridge.models probe --id ID`
     `python3 -m bridge.models remove --id ID`
3. Keep the generated store files private: endpoints and keys are stored in `<cw-home>/models/endpoints.json` and `<cw-home>/models/keys.json` (where `<cw-home>` is `$CW_HOME` or `~/.context-wall`). Both files must have mode `0600` and be owned by your user; the native host refuses loose permissions. Never commit `wall.config.json`, `endpoints.json`, or `keys.json` to git.

Security boundaries enforced by the native host and extension:
- Page JavaScript and `chrome.storage` store and transmit endpoint `id` values only—never URLs, model names, or API keys.
- Prompts, completions, headers, and keys are never written to logs or browser storage.
- Payloads sent through the native host are bounded under the host frame limit (up to 48 KiB request body).
- Health probes (`GET <base>/models`) time out at 1,500 ms; local generation times out at 30,000 ms and remote generation at 60,000 ms.

## Remote Config Flags

Three Firebase Remote Config flags govern provider availability, evaluated in order of precedence (`privacy policy > Remote Config flags/kill switches > user selection > Remote Config modes > defaults`):

- `external_providers_enabled`: master switch allowing external (`local-openai-compatible` and `remote-openai-compatible`) providers.
- `remote_providers_enabled`: allows `remote-openai-compatible` network providers when external providers are enabled.
- `kill_switch_cloud`: disables cloud inference (`firebase-cloud` and cloud fallback).

External model names are never sent through Remote Config.

## The Models Sheet and Source Chips

Click the status line in the TaskLight rail to open the **Models** sheet:

- **Firebase AI Logic**: Hybrid (recommended, default), On-device only, and Cloud only, each showing live device readiness.
- **Your local models**: plain-text `<label> · <model>` entries reported by the native host (hidden when the native host is absent).
- **Your network providers**: plain-text entries with the notice *"Not used for private projects or screenshots"*.
- **Task assignment and reset**: assign models per task group (Capsule tasks, Digest, Routing, Drift review, Liaison) or click **Reset to Firebase hybrid**.

Endpoint states shown in the sheet:
- **Ready**: probe succeeded and policy allows use.
- **Needs setup**: host absent or key missing (links to `docs/MODELS.md`).
- **Offline. Using Firebase hybrid.**: health probe failed.
- **Not allowed for this project's privacy level**: blocked by privacy policy or Remote Config.

Every result displays a source chip showing which path **actually answered**, never merely what was selected:

- **On device**: answered by Gemini Nano via Firebase AI Logic.
- **Cloud**: answered by Gemini in the cloud via Firebase AI Logic.
- **Local model**: answered by a local OpenAI-compatible server via the native host.
- **Network model**: answered by a remote OpenAI-compatible provider via the native host.
- **Rules**: answered by the deterministic rules fallback.
