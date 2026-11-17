"""Shared Python/TypeScript diagnostic vectors and published contract checks."""
import copy
import json
import unittest

from bridge.plan import fold_plan
from bridge.plan.conformance import check_conformance
from .support import EvidenceCase, ROOT

CORPUS = json.loads((ROOT / "tests/unit/u164/evidence_cases.json").read_text())


def diagnostic_projection(case):
    projection = fold_plan(CORPUS["history"], templates={CORPUS["template"]["id"]: CORPUS["template"]})
    task = projection["tasks"][0]
    task.update(state=case["task_state"], type=case["task_type"])
    micro = task["microtasks"][0]
    task["microtasks"] = [dict(copy.deepcopy(micro), id="T01.M%02d" % i, state=state, evidence=evidence)
                          for i, (state, evidence) in enumerate(zip(case["micro_states"], case["evidence"]), 1)]
    return projection


class ParityOracle(unittest.TestCase):
    def test_m6_shared_legacy_history_keeps_progress_and_receipts(self):
        projection = fold_plan(CORPUS["history"], templates={CORPUS["template"]["id"]: CORPUS["template"]})
        self.assertEqual(projection["rejected"], [])
        self.assertEqual(projection["rollup"]["progress_pct"], 100)
        self.assertEqual(projection["rollup"]["micro_done"], 2)
        self.assertEqual(projection["tasks"][0]["state"], "done")
        self.assertEqual(len(projection["replayed_ops"]), 2)
        self.assertEqual(fold_plan(copy.deepcopy(CORPUS["history"]), templates={CORPUS["template"]["id"]: CORPUS["template"]}), projection)


def install_case(case):
    def test(self):
        projection, template = diagnostic_projection(case), copy.deepcopy(CORPUS["template"])
        before = copy.deepcopy((projection, template))
        report = check_conformance(projection, template)
        paths = [f["path"] for f in report["findings"] if f["code"] == "missing_evidence"]
        self.assertEqual(paths, case["missing"], "Python diagnostic differs from the shared M8 contract")
        self.assertEqual((projection, template), before, "diagnostics mutated inputs")
    name = "test_m8_" + case["name"]
    test.__name__ = name
    setattr(ParityOracle, name, test)


for _case in CORPUS["cases"]:
    install_case(_case)


class PublishedContractOracle(EvidenceCase):
    def test_m9_server_version_is_shared_unreleased_minor(self):
        result = self.rpc("initialize", {})
        self.assertEqual(result["serverInfo"]["version"], "0.3.0")

    def test_m9_docs_publish_both_codes_and_version(self):
        texts = [(ROOT / "docs" / name).read_text() for name in ("MCP.md", "HEADLESS.md", "PLANNING.md", "PLANNING_CONTRACT.md")]
        combined = "\n".join(texts)
        missing = [token for token in ("missing_evidence", "template_unavailable", "0.3.0") if token not in combined]
        self.assertEqual(missing, [], "published planning contract omits U164 codes or version")


def install_doc(name):
    def test(self):
        text = (ROOT / "docs" / name).read_text().lower()
        self.assertRegex(text, r"(?s)evidence.{0,100}(?:required|requir|must)|(?:required|requir|must).{0,100}evidence",
                         "planning document must state the required-evidence completion rule")
        self.assertRegex(text, r"done|complet", "planning document must discuss completion")
    method_name = "test_m9_rule_" + name.replace(".", "_").lower()
    test.__name__ = method_name
    setattr(PublishedContractOracle, method_name, test)


for _document in ("MCP.md", "HEADLESS.md", "PLANNING.md", "PLANNING_CONTRACT.md"):
    install_doc(_document)
