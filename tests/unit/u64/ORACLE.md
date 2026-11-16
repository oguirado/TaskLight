# U64 fail-first oracle

Scope: SPEC_U64, including the entire supplied `.unit/SPEC.md`. That file ends at its AUSENTE list; it contains no Amendment sections.

## Acceptance mapping

The A-prefixes below refer to the numbered acceptance cases in spec section 5. Each row names executable tests; parameterized names expand with their input values.

| Case | Tests | Required observation |
| --- | --- | --- |
| 1 | `wiring.test.ts`: `A1 zero plans has no timers, providers, AI or updates` | Repeated synchronous notifications leave providers, timers, AI, feeds and update calls untouched. |
| 2 | `wiring.test.ts`: `A2 standard context delegates services, commits both feeds and refreshes`, `A2 placeholder build uses the default U63 rules implementation`; `resolver.test.ts`: all `A2` tests; `hosted.test.ts`: `A2 hosted entry wires lazy dependencies, template lookup and both feeds` | Services precede the legacy factory; lazy availability works; external permission is explicit; placeholder builds use rules; both feeds and refresh are wired. |
| 3 | `wiring.test.ts`: `A3 preserves %s source without relabeling`, `A3 real U63 %s fallback stays rules` | Device, cloud, local, remote and rules sources remain exact; real schema rejection and clock timeout fall back to rules. |
| 4 | `wiring.test.ts`: both `A4 %s` tests; `resolver.test.ts`: all `A4` tests | Private tier and kill switch use device floors on both job contexts; hostile external grants are clamped; non-device modes are denied under kill switch. |
| 5 | `wiring.test.ts`: `A5 private canaries never reach logs, storage or external modes` | Independent title, outcome and memory canaries stay out of logs, storage and external modes while review completes. |
| 6 | `wiring.test.ts`: all `A6` tests | One pending debounce, synchronous notification, default and injected concurrency, both job kinds across rooms, and task/memory/plan revision deduplication. |
| 7 | `wiring.test.ts`: all `A7` and `A7/A10` tests | Abort superseded task, memory and plan jobs; discard stale results, vanished plans and post-disposal settlements. |
| 8 | `wiring.test.ts`: `A8 isolates %s and remains callable`; `resolver.test.ts`: all `A8` tests; `hosted.test.ts`: `A8 %s failures leave boot, wall and room callbacks alive` | Synchronous getter/factory/adapter failures and asynchronous generation/review/brief rejection stay isolated; real boot reaches ready; room callbacks continue after plan failures. |
| 9 | `templates.test.ts`: all `A9` tests; `static.test.ts`: `A10 bundled metadata comes from all five static JSON imports` | Exact normalized starter metadata, deep freezing, unknown/prototype identifiers, malformed entries, section and character caps, static bundling. |
| 10 | `static.test.ts`: all `A10` tests; `wiring.test.ts`: all `A10` and `A7/A10` tests; external TypeScript verification | No global timers/time/fetch or DOM/storage access in composition modules; hosted CSS order; cancellation, queue clearing and late-result isolation. TypeScript diagnostics must not increase. |

## Binding interpretation

- `PlanAiOptions` in `src/planai/types.ts` has no `tier` or `floor`. Its `ReviewContext` and `BriefContext` do. The oracle asserts those values on both public job contexts, without inventing U63 option fields.
- `DriftPort` is exported by `src/agents/index.ts`, not `src/app/agent_drift.ts`. The stub imports that existing structural contract; the public signatures otherwise match the spec.
- Debounce means one live pending timer after every burst notification. Cancellation and rearming may create multiple historical `clock.setTimeout` calls, as explicitly required by section 4.5. No test demands one historical call for an entire burst.
- `ModelServices.driftPortFor` is synchronous. Hostile synchronous provider acquisition is tested separately from asynchronous `port.generate` rejection; the oracle does not invent a promise-valued service API.
- Static timer checks distinguish global calls from required `deps.clock` calls, and ignore comments. A literal grep for every `setTimeout` token would reject correct clock use.
- Hosted and bundled-import checks first exercise the required public composition/metadata API. Their initial failures therefore identify the intentional stub, before checking downstream integration requirements. The remaining independent static timer guards can already pass.
- The tuple constant is initialized to the spec IDs. Every stub function body throws `new Error("U64 stub")`; no implementation is supplied.
- No network or real timers: clocks and deferred promises are bounded; hosted tests use fake timers, Firebase ports and SDK factory. JSON fixture reads are test-only.

## Other-unit boundaries

| Surface | Ownership / disposition |
| --- | --- |
| `src/app/agent_store.ts`, `src/app/agent_wall.ts` | U61: projection correctness, DOM feed consumption and legacy fold equivalence belong to its suites. Existing hooks are present. U64 tests its own feeds and the hosted caller passing those hooks. |
| `src/views/**`, `styles/plan.css` | U62: chip labels, rendered layout and accessibility are out of scope. U64 verifies exact source values and the hosted stylesheet import. |
| `src/planai/**` | U63: prompt schema, deterministic rule internals, limits and inference cancellation internals are out of scope. U64 uses the real public reviewer only to verify composition and fallback. |
| `src/app/model_services.ts`, `src/app/model_port.ts`, `src/app/agent_drift.ts` | U52: registry/provider chain internals are out of scope. U64 checks delegation and explicit permissions. |
| `templates/planning/**` | U59: template content validity is out of scope. U64 checks build-time loading and normalized metadata. |
| `src/app/boot.ts`, U66 sync, U67 decompose | Authentication/AppCheck, persistence/sync and decompose are out of scope; boot survival is checked through the hosted caller. |

## Verification

Run `npx vitest run tests/unit/u64` for fail-first results, `npx vitest run --project unit --exclude 'tests/unit/u64/**'` for regression checks, and `npx tsc --noEmit -p .` for diagnostics. The pre-existing TypeScript check fails outside the U64 surface; compare its complete diagnostics before and after, rather than treating absent evidence as a passing typecheck.
