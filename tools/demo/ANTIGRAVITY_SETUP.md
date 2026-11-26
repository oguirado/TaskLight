# ViewPoint on the TaskLight wall

For TaskLight MCP registration in the Antigravity desktop app or CLI, follow
[Antigravity 2 and TaskLight](../../docs/ANTIGRAVITY.md).

From the repository root, start the local wall and the ViewPoint observer:

```sh
node tools/demo/run_tasklight.mjs --viewpoint
```

The observer reads ViewPoint run files and shows each run in the `viewpoint`
room. Agents can continue their work without posting updates. Intent files add
steps, receipts mark steps done or blocked, and `report.json` closes the run.
The observer leaves the runs directory untouched. Add `--history` to show runs
that were already present when the observer started. The launcher prints the
`CW_HOME` it uses. If you also register TaskLight over MCP, use that same directory.
