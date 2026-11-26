# PF1 fail-first oracle: the side panel gives the hosted wall the whole panel

Scope: `extension/src/panel/panel.html` and `extension/src/panel/panel.ts`.

| Rule | Test | Baseline (tree `fea72f6`) |
| --- | --- | --- |
| PF1-1 | `body has no margin and the frame spans the full width and height without a border`: the page carries a style that makes the frame a borderless block at 100% width and height | RED: no style, computed width and height are `auto` |
| PF1-1 guard | `the language-model permission stays in static markup next to the frame source` | GREEN |
| PF1-2 | `no hello is posted before the frame has loaded` | RED: the hello is posted as soon as the script runs |
| PF1-2 | `after the frame load event exactly one hello goes to the hosted origin` | RED |

Why: on the deployed hosted wall the production side panel drew the wall in a 300 by 150 frame,
and the first legacy hello could be posted before the frame had navigated to the hosted origin,
which the browser drops with a postMessage target-origin warning.

The test DOM never fires the iframe `load` event and keeps the frame document in `loading`, so
`tests/unit/u13/review1.test.ts` needs amendment A-U13-PF1 (dispatch the frame `load` event before
expecting the hello).
