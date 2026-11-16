def _one_line(s) -> str:
    if not isinstance(s, str):
        s = "" if s is None else str(s)
    out = []
    for c in s:
        o = ord(c)
        if o < 0x20 or o == 0x7F:
            out.append(" ")
        else:
            out.append(c)
    return "".join(out).strip()


def _block(s) -> str:
    if not isinstance(s, str):
        s = "" if s is None else str(s)
    out = []
    for c in s:
        o = ord(c)
        if (o < 0x20 and c != "\n") or o == 0x7F:
            out.append(" ")
        else:
            out.append(c)
    return "".join(out)


def render_plan_md(projection: dict, template: dict | None = None) -> str:
    plan = projection.get("plan") if isinstance(projection, dict) else None
    tasks = projection.get("tasks", []) if isinstance(projection, dict) else []
    lines = []
    if plan is None:
        lines.append("# No plan")
        lines.append("")
    else:
        title = _one_line(plan.get("title", ""))
        lines.append(f"# Plan: {title}")
        lines.append("")
        lines.append(f"Phase: {_one_line(plan.get('phase', ''))}")
        lines.append(f"State: {_one_line(plan.get('state', ''))}")
        outcome = plan.get("closed_outcome")
        if outcome is not None:
            lines.append(f"Outcome: {_one_line(outcome)}")
        lines.append("")
    lines.append("## Tasks")
    lines.append("")
    if not tasks:
        lines.append("_No tasks_")
    else:
        for t in sorted(tasks, key=lambda x: x.get("id", "")):
            if not isinstance(t, dict):
                continue
            tid = _one_line(t.get("id", ""))
            title = _one_line(t.get("title", ""))
            state = _one_line(t.get("state", ""))
            lines.append(f"### {tid}: {title}")
            lines.append("")
            lines.append(f"State: {state}")
            lines.append("")
            micros = t.get("microtasks", []) if isinstance(t.get("microtasks"), list) else []
            for m in sorted(micros, key=lambda x: x.get("id", "")):
                if not isinstance(m, dict):
                    continue
                mid = _one_line(m.get("id", ""))
                mtext = _one_line(m.get("text", ""))
                mstate = _one_line(m.get("state", ""))
                lines.append(f"- {mid}: {mtext} ({mstate})")
            if micros:
                lines.append("")
    # Ensure trailing newline and no stray controls
    return "\n".join(lines).rstrip("\n") + "\n"


def render_memory_md(projection: dict, template: dict | None = None) -> str:
    memory = projection.get("memory", {}) if isinstance(projection, dict) else {}
    labels = {}
    if isinstance(template, dict):
        for sec in template.get("memory_sections", []):
            if isinstance(sec, dict) and "id" in sec:
                labels[sec["id"]] = _one_line(sec.get("label", sec.get("id", "")))
    lines = []
    lines.append("# Memory")
    lines.append("")
    if not memory:
        lines.append("_No memory_")
    else:
        for sid in sorted(memory.keys()):
            entry = memory.get(sid, {})
            label = labels.get(sid, sid)
            safe_label = _one_line(label)
            lines.append(f"## {safe_label}")
            lines.append("")
            if isinstance(entry, dict):
                text = _block(entry.get("text", ""))
            else:
                text = _block(str(entry))
            # Trim trailing spaces per line but preserve newlines
            lines.append(text.rstrip())
            lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"
