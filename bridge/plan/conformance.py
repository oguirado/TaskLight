import copy


def check_conformance(projection: dict, template: dict) -> dict:
    # Pure, deterministic; does not mutate inputs
    findings = []

    def add(code: str, path: str, message: str):
        findings.append({"code": code, "severity": "error", "path": path, "message": message})

    plan = projection.get("plan")
    tasks = projection.get("tasks", []) if isinstance(projection, dict) else []
    memory = projection.get("memory", {}) if isinstance(projection, dict) else {}

    tpl = template if isinstance(template, dict) else {}
    phases = tpl.get("phases", []) if isinstance(tpl, dict) else []
    phase_ids = {p["id"] for p in phases if isinstance(p, dict) and "id" in p}
    task_types = tpl.get("task_types", []) if isinstance(tpl, dict) else []
    type_by_id = {t["id"]: t for t in task_types if isinstance(t, dict) and "id" in t}
    brief_fields = tpl.get("brief_fields", []) if isinstance(tpl, dict) else []
    memory_sections = tpl.get("memory_sections", []) if isinstance(tpl, dict) else []
    gran = tpl.get("granularity", {}) if isinstance(tpl, dict) else {}
    tasks_max = gran.get("tasks_max")
    micro_min = gran.get("micro_min")
    micro_max = gran.get("micro_max")

    if plan is None:
        # No plan: required brief/phase cannot be satisfied
        for bf in brief_fields:
            if isinstance(bf, dict) and bf.get("required") is True:
                add("missing_brief", f"plan.brief.{bf.get('id')}", f"Missing required brief field {bf.get('id')}")
        add("missing_plan", "plan", "Missing plan")
    else:
        brief = plan.get("brief", {}) if isinstance(plan.get("brief"), dict) else {}
        for bf in brief_fields:
            if not isinstance(bf, dict):
                continue
            fid = bf.get("id")
            if bf.get("required") is True:
                val = brief.get(fid)
                if not isinstance(val, str) or val == "":
                    add("missing_brief", f"plan.brief.{fid}", f"Missing required brief field {fid}")
        if plan.get("phase") not in phase_ids:
            add("invalid_phase", "plan.phase", "Invalid plan phase")

    # Task-level checks in task order
    for idx, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        tid = task.get("id", str(idx))
        if task.get("phase") not in phase_ids:
            add("invalid_phase", f"tasks.{tid}.phase", f"Invalid phase for {tid}")
        ttype = task.get("type")
        if ttype not in type_by_id:
            add("invalid_type", f"tasks.{tid}.type", f"Invalid type for {tid}")
        else:
            tdef = type_by_id[ttype]
            if tdef.get("accept_required") is True:
                acc = task.get("accept", "")
                if not isinstance(acc, str) or acc == "":
                    add("missing_accept", f"tasks.{tid}.accept", f"Missing accept for {tid}")
            if task.get("state") == "done" and tdef.get("evidence_required") is True:
                micros = task.get("microtasks", [])
                for m in micros:
                    if isinstance(m, dict) and m.get("state") == "done":
                        ev = m.get("evidence", [])
                        if not isinstance(ev, list) or len(ev) == 0:
                            mid = m.get("id", "")
                            add("missing_evidence", f"tasks.{tid}.microtasks.{mid}.evidence", f"Missing evidence for done micro {mid}")
        micros = task.get("microtasks", []) if isinstance(task.get("microtasks"), list) else []
        if isinstance(micro_min, int) and not isinstance(micro_min, bool):
            if len(micros) < micro_min:
                add("micro_below_min", f"tasks.{tid}.microtasks", f"Microtask count below minimum for {tid}")
        if isinstance(micro_max, int) and not isinstance(micro_max, bool):
            if len(micros) > micro_max:
                add("micro_above_max", f"tasks.{tid}.microtasks", f"Microtask count above maximum for {tid}")

    # Granularity tasks_max
    if isinstance(tasks_max, int) and not isinstance(tasks_max, bool):
        if len(tasks) > tasks_max:
            add("tasks_above_max", "tasks", "Task count above template maximum")

    # Memory sections
    mem = memory if isinstance(memory, dict) else {}
    for sec in memory_sections:
        if not isinstance(sec, dict):
            continue
        sid = sec.get("id")
        if sec.get("required") is True:
            entry = mem.get(sid)
            if not isinstance(entry, dict):
                add("missing_memory", f"memory.{sid}", f"Missing required memory section {sid}")
                continue
            text = entry.get("text", "")
            if not isinstance(text, str) or text == "":
                add("missing_memory", f"memory.{sid}.text", f"Empty required memory section {sid}")
                continue
            max_chars = sec.get("max_chars")
            if isinstance(max_chars, int) and not isinstance(max_chars, bool):
                if isinstance(text, str) and len(text) > max_chars:
                    add("memory_above_max", f"memory.{sid}.text", f"Memory section {sid} exceeds max_chars")
        else:
            entry = mem.get(sid)
            if isinstance(entry, dict):
                text = entry.get("text", "")
                max_chars = sec.get("max_chars")
                if isinstance(max_chars, int) and not isinstance(max_chars, bool):
                    if isinstance(text, str) and len(text) > max_chars:
                        add("memory_above_max", f"memory.{sid}.text", f"Memory section {sid} exceeds max_chars")

    ok = len(findings) == 0
    return {"ok": ok, "findings": findings}
