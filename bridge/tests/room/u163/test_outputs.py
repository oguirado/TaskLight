"""M3/M4/M5/M6/M8: independent public-output boundary cases."""
import copy
import json
from pathlib import Path

from .support import (CLEAN, HERE, RAW, REDACTED, SECRET, RoomCase, broken_redactor,
                      compact, emit, exporter)

TOOLS = tuple("post_status post_plan post_step close_task read_inbox wait_inbox plan_get "
              "task_add task_update task_claim task_release microtask_set next_work memory_get "
              "room_events room_export memory_history work_acquire".split())
READS = {"read_inbox", "wait_inbox", "plan_get", "next_work", "memory_get", "room_events",
         "room_export", "memory_history"}
RESOURCES = ("plan", "memory")
PROMPTS = ("resume_from_memory", "plan_from_template", "swarm_coordinator")
CLI_VERBS = ("post", "read", "wait", "status", "call", "export")
TEMPLATES = ("list_templates", "get_template", "resource")
GOLD = json.loads((HERE / "clean_outputs.json").read_text(encoding="utf-8"))


def prompt_args(name, text):
    if name == "resume_from_memory":
        return dict(room="demo", agent="alice")
    if name == "plan_from_template":
        return dict(template_id="neutral", brief=text)
    return dict(room="demo", agent="alice", template_id="neutral", brief=text)


def exported(case):
    return {name: (case.home / "exports" / name).read_text(encoding="utf-8")
            for name in ("PLAN.md", "MEMORY.md")}


class OutputRedaction(RoomCase):
    pass


# A-U163o (orchestrator ruling): writes that carry no free text in their arguments.
TEXTLESS_WRITES = {"task_claim", "task_release", "work_acquire"}


def tool_case(name):
    def test(self):
        self.seed()
        args = self.tool_args(name)
        before = self.journal()
        payload, wire = self.ok_tool(name, **args)
        if name in READS:
            self.assertEqual(self.journal(), before, "read must preserve journal bytes")
        elif name in TEXTLESS_WRITES:
            # A-U163o: these tools accept no free text, so there is no owner text to retain; they must still write.
            self.assertNotEqual(self.journal(), before, "write must append")
        else:
            self.assertIn(RAW.encode(), self.journal()[len(before):], "writes must retain owner text")
        self.redacted(wire)
        if name == "memory_history":
            versions = payload["untrusted"]["versions"]
            self.assertEqual([v["text"] for v in versions], ["current " + REDACTED, "old " + REDACTED])
    return test


def clean_tool_case(name):
    def test(self):
        self.seed(CLEAN)
        _, wire = self.ok_tool(name, **self.tool_args(name, CLEAN))
        self.assertEqual(wire, GOLD["tools"][name], "clean MCP bytes changed")
    return test


def failed_tool_case(name):
    def test(self):
        self.seed()
        args = self.tool_args(name)
        with broken_redactor():
            reply, wire = self.tool(name, **args)
        self.refusal(reply, wire)
    return test


for _name in TOOLS:
    setattr(OutputRedaction, "test_tool_" + _name, tool_case(_name))
    setattr(OutputRedaction, "test_clean_tool_" + _name, clean_tool_case(_name))
    setattr(OutputRedaction, "test_failure_tool_" + _name, failed_tool_case(_name))


def resource_case(kind, mode):
    def test(self):
        self.seed(CLEAN if mode == "clean" else SECRET)
        before = self.journal()
        params = dict(uri="tasklight://rooms/demo/" + kind)
        if mode == "failure":
            with broken_redactor():
                reply, wire = self.rpc("resources/read", params)
            self.refusal(reply, wire)
        else:
            reply, wire = self.rpc("resources/read", params)
            self.success(reply)
            json.loads(reply["result"]["contents"][0]["text"])
            if mode == "clean":
                self.assertEqual(wire, GOLD["resources"][kind])
            else:
                self.redacted(wire)
        self.assertEqual(self.journal(), before)
    return test


def prompt_case(name, mode):
    def test(self):
        text = CLEAN if mode == "clean" else SECRET
        self.seed(text)
        before = self.journal()
        params = dict(name=name, arguments=prompt_args(name, text))
        if mode == "failure":
            with broken_redactor():
                reply, wire = self.rpc("prompts/get", params)
            self.refusal(reply, wire)
        else:
            reply, wire = self.rpc("prompts/get", params)
            self.success(reply)
            if mode == "clean":
                self.assertEqual(wire, GOLD["prompts"][name])
            else:
                self.redacted(wire)
        self.assertEqual(self.journal(), before)
    return test


for _mode in ("redacted", "clean", "failure"):
    for _kind in RESOURCES:
        setattr(OutputRedaction, "test_" + _mode + "_resource_" + _kind, resource_case(_kind, _mode))
    for _name in PROMPTS:
        setattr(OutputRedaction, "test_" + _mode + "_prompt_" + _name, prompt_case(_name, _mode))


def cli_case(verb, mode):
    def test(self):
        text = CLEAN if mode == "clean" else SECRET
        self.seed(text)
        before = self.journal()
        if mode == "failure":
            with broken_redactor():
                rc, out, err = self.run_cli(*self.cli_args(verb, text))
            self.assertNotIn(RAW, out + err)
            self.assertNotEqual(rc, 0, "U163: CLI sanitizer failure must exit nonzero")
            if verb == "export":
                self.assertFalse(any((self.home / "exports").glob("*")), "failed export wrote files")
        else:
            rc, out, err = self.run_cli(*self.cli_args(verb, text))
            self.assertEqual(rc, 0, out + err)
            json.loads(out)
            if verb == "export":
                files = exported(self)
                if mode == "clean":
                    self.assertEqual(files, GOLD["exports"])
                    self.assertEqual(out, GOLD["cli"][verb])
                    self.assertEqual(err, "")
                else:
                    self.assertNotIn(RAW, out + err)
                    for content in files.values():
                        self.redacted(content)
            elif mode == "clean":
                self.assertEqual(out, GOLD["cli"][verb])
                self.assertEqual(err, "")
            else:
                self.redacted(out + err)
        if verb != "post":
            self.assertEqual(self.journal(), before)
    return test


for _mode in ("redacted", "clean", "failure"):
    for _verb in CLI_VERBS:
        setattr(OutputRedaction, "test_" + _mode + "_cli_" + _verb, cli_case(_verb, _mode))


def template_case(surface, mode):
    def test(self):
        template = copy.deepcopy(self.template)
        text = CLEAN if mode == "clean" else SECRET
        template["name"] = text
        template["summary"] = text
        for field in template["brief_fields"]:
            field["label"] = text
        for phase in template["phases"]:
            phase.update(label=text, exit=text)
        for kind in template["task_types"]:
            kind.update(label=text, micro_hints=[text])
        template["granularity"]["rule"] = text
        for section in template["memory_sections"]:
            section.update(label=text, hint=text)
        self.install_template(template)
        path = self.home / "templates/neutral.json"
        original = path.read_bytes()
        def request():
            if surface == "resource":
                return self.rpc("resources/read", dict(uri="tasklight://templates/neutral"))
            args = dict(template_id="neutral") if surface == "get_template" else {}
            return self.tool(surface, **args)
        if mode == "failure":
            with broken_redactor():
                reply, wire = request()
            self.refusal(reply, wire)
        else:
            reply, wire = request()
            self.success(reply)
            if mode == "clean":
                self.assertEqual(wire, GOLD["templates"][surface])
            else:
                self.redacted(wire)
                # Hash and template id remain the original structural values.
                self.assertIn(self.template["hash"], wire)
                self.assertIn("neutral", wire)
        self.assertEqual(path.read_bytes(), original, "template reads must not rewrite local templates")
    return test


for _mode in ("redacted", "clean", "failure"):
    for _surface in TEMPLATES:
        setattr(OutputRedaction, "test_" + _mode + "_template_" + _surface, template_case(_surface, _mode))


def diagnostic_case(name, surface):
    def test(self):
        self.seed()
        before = self.journal()
        args = dict(room="demo", agent="alice", **{SECRET: "hostile unknown argument"})
        if surface == "mcp":
            reply, wire = self.tool(name, **args)
            self.assertTrue(reply["result"]["isError"], "invalid input must remain refused")
        else:
            rc, out, err = self.run_cli("call", name, "--json", compact(args))
            self.assertNotEqual(rc, 0)
            wire = out + err
        self.assertEqual(self.journal(), before, "invalid requests must not append")
        self.redacted(wire)
    return test


for _name in ("plan_create", "plan_check"):
    for _surface in ("mcp", "cli"):
        setattr(OutputRedaction, "test_diagnostic_" + _surface + "_" + _name, diagnostic_case(_name, _surface))


def failure_diagnostic_case(name, surface):
    def test(self):
        self.seed()
        before = self.journal()
        args = dict(room="demo", agent="alice", **{SECRET: "hostile argument"})
        with broken_redactor():
            if surface == "mcp":
                reply, wire = self.tool(name, **args)
                self.refusal(reply, wire)
            else:
                rc, out, err = self.run_cli("call", name, "--json", compact(args))
                self.assertNotEqual(rc, 0)
                self.assertNotIn(RAW, out + err, "U163: refusal diagnostics must fail closed too")
        self.assertEqual(self.journal(), before)
    return test


for _name in ("plan_create", "plan_check"):
    for _surface in ("mcp", "cli"):
        setattr(OutputRedaction, "test_failure_diagnostic_" + _surface + "_" + _name,
                failure_diagnostic_case(_name, _surface))


def template_prompt_case(name):
    def test(self):
        template = copy.deepcopy(self.template)
        template.update(name=SECRET, summary=SECRET)
        self.install_template(template)
        reply, wire = self.rpc("prompts/get", dict(name=name, arguments=prompt_args(name, CLEAN)))
        self.success(reply)
        self.redacted(wire)
        self.assertIn(self.template["hash"], wire)
    return test


for _name in ("plan_from_template", "swarm_coordinator"):
    setattr(OutputRedaction, "test_template_text_in_prompt_" + _name, template_prompt_case(_name))
