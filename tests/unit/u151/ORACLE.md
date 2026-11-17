# U151 fail-first oracle

The supplied `.unit/SPEC.md` is read in full. It has no numbered acceptance list
and no Amendment sections. The case numbers below normalize its explicit MUSTs,
Oracle, Hostile and Negative clauses; they do not add another unit's requirements.
The alias names and relationships come from the supplied C7 token table.

| Case | Required behavior | Test name in `density.test.ts` |
| --- | --- | --- |
| AC1 | Add `--wall-*` aliases; resolve against existing tokens in both themes | `AC1 resolves the C7 Wall aliases in %s` |
| AC2 | Confine density rules to `.plan-wall` and `.agent-strip` | `AC2 confines Wall density consumers to the Wall and Agents strip`; `AC2 preserves legacy step boxes and workspace motion outside the Wall` |
| AC3 | Remove boxed steps, with interactive and static branches covered | `AC3 removes boxes from %s in the Wall` |
| AC4 | Make strip records a desktop grid without fixing column widths | `AC4 aligns desktop agent records with a grid` |
| AC5 | Only working microtasks rotate; task rings, agent dots and other activity states remain stationary | `AC5 animates the working microtask`; `AC5 keeps %s microtasks stationary`; `AC5 keeps task rings stationary while microtasks work`; `AC5 keeps agent dots stationary` |
| AC6 | Reduced motion stops rotation, neutralizes transitions, and preserves shape and visible Working text | `AC6 preserves the working shape and word with reduced motion via %s` |
| AC7 | Do not dim completed content through opacity in either theme | `AC7 keeps completed content undimmed in %s` |
| AC8 | Cards, task headers, microtask rows and strip records grow naturally | `AC8 allows cards and rows to grow in $theme at $width px` |
| AC9 | Interactive microtask rows retain the existing `--touch` floor | `AC9 preserves the touch-token floor on interactive microtask rows` |
| H1 | Preserve an unbroken slug of 200 characters at 390 px [CITED: `.unit/SPEC.md`], both themes | `H1 retains wrap opportunities for the unbroken slug at narrow width in %s`; rendered capsule remains pending |
| N1 | Reject a known-bad fixed card height, including logical block size | `N1 rejects a fixed card %s using the same AC8 gate` |

## Explicit token contract

`styles/tokens.css` owns these aliases. Their values must follow the existing
semantic tokens in light and dark rather than baking in one theme's literal.

| Alias | Existing token or C7 value [CITED: supplied C7 table] |
| --- | --- |
| `--wall-reading-max` | `var(--reading-max)` |
| `--wall-task-pad` | `var(--sp-3)` |
| `--wall-task-gap` | `var(--sp-2)` |
| `--wall-row-gap` | `var(--sp-1)` |
| `--wall-row-indent` | `var(--sp-6)` |
| `--wall-task-font` | `var(--fs-3)` |
| `--wall-step-font` | `var(--fs-2)` |
| `--wall-meta-font` | `var(--fs-1)` |
| `--wall-title-font` | `var(--fs-4)` |
| `--wall-control-min` | `var(--touch)` |
| `--wall-strip-row-min` | `2rem`, noninteractive records only |
| `--wall-step-active-bg` | `var(--c-primary-tint)` |
| `--wall-state-working` | `var(--c-primary-ink)` |
| `--wall-state-waiting` | `var(--c-st-waiting)` |
| `--wall-state-failed` | `var(--c-st-blocked)` |
| `--wall-state-done` | `var(--c-st-done)` |
| `--wall-state-unknown` | `var(--c-text-3)` |

## Method, negative control and stop rules

Read existing `styles/tokens.css`, `styles/views.css`, then `styles/plan.css` in
production cascade order. Use existing `renderPhaseTaskCards` and
`renderAgentStrip`; no missing future imports, product stubs, network or timers.
Fixtures exercise disclosure buttons and static microtask rows. Desktop width
1440 px and the touch-token mutation to 68 px are test inputs [TARGET]. CSSOM assertions
select media branches deterministically, and jsdom resolves the authored cascade
and custom properties. Pseudo layers are materialized into empty probe elements
for style comparisons; these probes are not screenshot or layout evidence.

The fixed-height negative is applied only to an in-memory stylesheet. It must
turn the same natural-height assertion red; the negative-control test passes only
when that rejection occurs. It never rewrites production CSS. Likewise, changing
`--touch` in memory detects rows that hard-code a superficially adequate height.
Missing declarations fail assertions, not imports. Preserve existing styles for
legacy markup outside `.plan-wall` and `.agent-strip`; no global animation ban is
imposed on other views or workspace controls.

The hostile unit checks prove intact text, intrinsic wrap opportunities, natural
height and absence of ellipsis/clipping declarations. **Rendered capsule result:
AUSENTE — no inventar.** jsdom has no layout engine: do not treat zero rectangles
or equal zero scroll/client widths as a pass. Before accepting the full hostile
case, a browser capsule must show the complete slug without page overflow at
390 px in light and dark. Without that receipt, the capsule gate stays pending.
If production styles, existing renderer imports or the CSSOM preconditions cannot
be loaded, stop verification; an empty or unavailable surface never passes.

## Out of scope

| Unit or surface | Excluded acceptance cases |
| --- | --- |
| U138p | Remove both chat creation paths and the delegated card-to-chat handler; retain Messages (legacy) |
| U148 | Non-article task roots, header/control order, microtask identity, task versus agent state |
| U149 | Agent list semantics, stable identity, global cap and lifecycle wording |
| U150 | Refresh focus/expansion continuity, persistent lifecycle announcements and quiet beats |
| U152 | Navigation order, mobile navigation disclosure and Models opener |
| U153 | Accessibility-tree automation client selectors, opaque-article pruning and receipt separation |
| U155 | Persona answers, zoom/keyboard matrix, rendered contrast and full capsule judgement |
| Backend units | Mailbox fencing, lifecycle retries, cleanup and work admission |

`src/app/swarm_vm.ts` and `deriveSwarmViewModel` remain read-only. No external
visual receipt is claimed or required to make the CSS assertion suite run.
