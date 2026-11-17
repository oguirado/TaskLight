"""U137 documentation and manually activated prompt contracts."""
import os
from pathlib import Path
import unittest

from .support import (ADAPTER, COORDINATOR, EXECUTOR, FALLBACK, GUIDE,
                      PUBLIC_ARTIFACTS, ROOT, ArtifactCase, exclusive_modes,
                      fallback_provenance)


class RegistrationDocumentation(ArtifactCase):
    def test_a1_raw_config_navigation_and_manual_preservation(self):
        text = self.text(GUIDE)
        self.mentions(text, "Agent", "MCP Servers", "Manage MCP Servers", "View raw config")
        self.rule(text, r"preserv\w*.{0,100}(?:unrelated|other).{0,40}servers", "M1 preserve unrelated servers")
        self.rule(text, r"malformed.{0,100}(?:untouched|unchanged|do not|never)|(?:untouched|unchanged|do not|never).{0,100}malformed", "M1 malformed configuration is left untouched")
        self.rule(text, r"(?:no|never|not).{0,70}automatic.{0,50}(?:replace|replacement|overwrite)", "M1 no automatic replacement")

    def test_a1_unknown_client_capabilities_are_ausente(self):
        text = self.text(GUIDE)
        for concept in (r"\bcwd\b", r"\benv\b", r"(?:configuration|config).{0,30}(?:location|path)", r"reload"):
            self.rule(text, r"(?:" + concept + r").{0,220}AUSENTE|AUSENTE.{0,220}(?:" + concept + r")",
                      "M1 unsupported client details must remain AUSENTE")

    def test_a1_tasklight_registration_is_separate_from_firebase(self):
        text = self.text(GUIDE)
        self.rule(text, r"Firebase.{0,120}(?:not|separate|distinct).{0,120}TaskLight|TaskLight.{0,120}(?:not|separate|distinct).{0,120}Firebase", "M1 separate MCP registrations")
        self.rule(text, r"skills?.{0,120}optional|optional.{0,120}skills?", "M6 skills are optional guidance")
        self.rule(text, r"(?:never|not|no).{0,80}(?:install|packages?).{0,60}automatic|(?:never|not|no).{0,60}automatic.{0,60}install", "M6 no automatic package installation")

    def test_a1_live_compatibility_receipts_cannot_be_inferred(self):
        text = self.text(GUIDE)
        self.mentions(text, "Antigravity 2", "AUSENTE", "version", "configuration", "wall")
        self.rule(text, r"(?:mock|fixture|stdio).{0,180}(?:not|cannot|doesn.t).{0,120}(?:compatib|live|prove)", "A1 server evidence does not prove live client compatibility")
        self.rule(text, r"(?:unexecuted|untested|missing).{0,120}AUSENTE|AUSENTE.{0,120}(?:unexecuted|untested|missing)", "M7 unexecuted checks stay AUSENTE")


class CoordinationTemplates(ArtifactCase):
    def test_a2_manual_activation_and_unknown_native_triggers(self):
        text = self.text(GUIDE)
        self.rule(text, r"manual.{0,120}(?:copy|paste)|(?:copy|paste).{0,120}manual", "M2 manual activation")
        for concept in ("rules", "workflow", "triggers"):
            self.rule(text, concept + r".{0,220}AUSENTE|AUSENTE.{0,220}" + concept, "M2 native integration is unknown")
        for relative in (COORDINATOR, EXECUTOR, FALLBACK):
            self.assertTrue(self.text(relative).strip())

    def test_a2_discover_prompts_before_get_and_version_fallback_copies(self):
        text = self.text(GUIDE)
        self.mentions(text, "prompts/list", "prompts/get", "swarm_coordinator", "swarm_executor")
        self.assertLess(text.index("prompts/list"), text.index("prompts/get"))
        self.rule(text, r"(?:not|cannot|unavailable|does not).{0,100}(?:expose|prompts?).{0,220}(?:cop|version)|(?:version|cop).{0,220}(?:not|unavailable).{0,100}prompts?", "M2 versioned copies when MCP prompts are unavailable")
        for relative, name in ((COORDINATOR, "swarm_coordinator"), (EXECUTOR, "swarm_executor")):
            template = self.text(relative)
            self.mentions(template, "U111", name)
            self.rule(template, r"(?:version|revision|snapshot|source).{0,100}\S", "M2 identify U111 source version")
            self.assertNotRegex(template, r"(?im)^\s*(?:/prompt|prompts\s+select|mcp\s+prompt\s+select)\b")

    def test_a2_coordinator_reads_plans_assigns_routes_and_reconciles(self):
        text = self.text(COORDINATOR)
        self.mentions(text, "memory_get", "plan_get", "read_inbox", "plan_create", "room_send", "template", "assignee")
        self.rule(text, r"reconcil", "M2 coordinator reconciles")
        self.rule(text, r"deploy.{0,180}(?:external|harness)|(?:external|harness).{0,180}deploy", "M2 deploy outside TaskLight")
        self.rule(text, r"(?:human|terminal).{0,120}harness|harness.{0,120}(?:human|terminal)", "M6 keep conversation and terminal controls in the harness")

    def test_a2_executor_claims_before_editing_and_keeps_identity(self):
        text = self.text(EXECUTOR)
        self.mentions(text, "task_claim", "microtask_set", "depend", "coarse", "evidence", "boundar", "run_id", "slug")
        self.rule(text, r"claim.{0,140}before.{0,120}(?:edit|writ|work)|before.{0,120}(?:edit|writ).{0,120}claim", "M2 claim before editing")
        self.rule(text, r"stable.{0,120}(?:slug|agent)|(?:slug|agent).{0,120}stable", "M2 stable agent slug")
        self.rule(text, r"run_id.{0,140}attempt|attempt.{0,140}run_id", "M2 stable run identity per attempt")

    def test_a2_beats_retired_runs_and_takeover_rule(self):
        text = self.text(EXECUTOR) + "\n" + self.text(GUIDE)
        self.mentions(text, "activity_beat", "run_id", "retired", "takeover")
        self.rule(text, r"activity_beat.{0,180}30\s*(?:s|second)|30\s*(?:s|second).{0,180}activity_beat", "M2 preserve 30 s cadence")
        self.rule(text, r"(?:600[ ,]?000\s*ms|10\s*minutes?)", "M6 preserve the existing takeover boundary")
        self.rule(text, r"90\s*(?:s|second).{0,180}unknown|unknown.{0,180}90\s*(?:s|second)", "M6 beat expiry is Liveness unknown")
        self.rule(text, r"(?:never|not|no).{0,120}(?:infer|fabricat).{0,100}fail|(?:expiry|expired|unknown).{0,180}(?:not|never).{0,120}fail", "M6 do not infer failure from silence")

    def test_a5_interpolated_text_and_untrusted_results_are_passive(self):
        for relative in (COORDINATOR, EXECUTOR, FALLBACK):
            text = self.text(relative)
            self.mentions(text, "untrusted", "passive")
            self.rule(text, r"(?:task|brief|interpolat).{0,180}(?:passive|data)|(?:passive|data).{0,180}(?:task|brief|interpolat)", "M2 interpolated task text is data")
            self.rule(text, r"(?:never|not|no).{0,100}(?:execute|follow|obey).{0,140}(?:instruction|directive|data)|(?:instruction|directive).{0,140}(?:never|not).{0,100}(?:execute|follow|obey)", "M2 injected directives have no authority")


class LifecycleFallback(ArtifactCase):
    def test_a4_explicit_enablement_and_r39_exception(self):
        text = self.text(FALLBACK)
        self.mentions(text, "agent_lifecycle", "deployed", "alive", "finished", "failed", "R39", "U111")
        self.rule(text, r"explicit.{0,120}(?:enable|opt.in)|(?:enable|opt.in).{0,120}explicit", "M5 fallback requires explicit enablement")
        self.rule(text, r"deployed.{0,120}before.{0,100}work|before.{0,100}work.{0,120}deployed", "M5 deploy report precedes work")
        self.rule(text, r"(?:truthful|observed).{0,140}(?:failed|reports?)|(?:failed|reports?).{0,140}(?:truthful|observed)", "M5 report truthful observed states")
        self.rule(text, r"exception|override", "M5 narrow connection-specific exception to U111")

    def test_a4_fallback_provenance_is_agent_reported(self):
        fallback_provenance(self.text(FALLBACK))

    def test_a4_bookkeeping_tokens_and_limited_c1_coverage(self):
        text = self.text(GUIDE) + "\n" + self.text(FALLBACK)
        self.rule(text, r"(?:consume|cost|use|require)\w*.{0,100}(?:model|bookkeeping).{0,50}tokens?|tokens?.{0,100}(?:consum|cost|bookkeeping)", "M3/M5 fallback has bookkeeping token cost")
        self.rule(text, r"(?:not|never|no).{0,100}(?:zero|0).{0,40}(?:model\s+)?tokens?", "M5 no zero-token claim")
        self.rule(text, r"(?:not|cannot|doesn.t).{0,120}(?:satisfy|pass|meet).{0,100}C-1|C-1.{0,120}(?:not|cannot|unmet)", "M6 fallback is not independent lifecycle acceptance")

    def test_a4_graceful_release_and_abrupt_kill_limit(self):
        text = self.text(FALLBACK)
        self.mentions(text, "task_release", "run_id", "op_id", "retry")
        self.rule(text, r"(?:failed|failure).{0,180}task_release|task_release.{0,180}(?:failed|failure)", "M5 release on graceful failure")
        self.rule(text, r"finish\w*.{0,160}open.{0,160}(?:release|task_release)|(?:release|task_release).{0,160}finish\w*.{0,160}open", "M5 release open work at finish")
        self.rule(text, r"(?:kill|abrupt|terminat).{0,180}(?:cannot|not reliably|unreliable|unable)", "M5 abrupt death cannot reliably report or release")
        self.rule(text, r"(?:stable|same|preserv|reuse).{0,120}op_id|op_id.{0,120}(?:stable|same|preserv|reuse)", "M5 preserve same-action retry identity")

    def test_a5_hook_fallback_same_run_collision_stop_rule(self):
        exclusive_modes(self.text(FALLBACK))
        exclusive_modes(self.text(GUIDE))

    def test_a6_provenance_mutant_is_rejected_after_positive_control(self):
        original = self.text(FALLBACK)
        fallback_provenance(original)
        mutant = original.replace("Antigravity 2 (agent-reported)", "Antigravity 2 (harness-recorded)")
        self.assertNotEqual(mutant, original, "A6 mutation did not change the template")
        with self.assertRaisesRegex(AssertionError, "fallback harness provenance"):
            fallback_provenance(mutant)

    def test_a6_missing_template_is_not_a_detected_mutant(self):
        with self.assertRaisesRegex(AssertionError, "agent-reported label missing"):
            fallback_provenance("")


class NativeGateAndScope(ArtifactCase):
    def test_a3_no_adapter_without_public_native_contract(self):
        # The supplied corpus has no event/payload/retry/invocation contract.
        self.assertFalse((ROOT / ADAPTER).exists(), "M3 native contract AUSENTE: adapter must not ship")

    def test_a3_guide_declares_native_contract_and_automatic_lifecycle_ausente(self):
        text = self.text(GUIDE)
        self.rule(text, r"automatic.{0,140}(?:lifecycle|hook).{0,180}AUSENTE|AUSENTE.{0,180}automatic.{0,140}(?:lifecycle|hook)", "M3 automatic lifecycle AUSENTE")
        self.mentions(text, "event", "payload", "retry", "invocation", "version")
        self.rule(text, r"PostToolUse.{0,200}(?:not|no|only)|(?:not|no|only).{0,200}PostToolUse", "M3 Claude todo hook supplies no Antigravity contract")
        self.rule(text, r"(?:rule|workflow|MCP).{0,140}agent-reported", "M3 model-executed reports are not automatic hooks")

    @unittest.skip("BLOCKED A3/A6: native contract AUSENTE; no fixture or adapter may be invented")
    def test_a3_native_replay_failure_release_bound_and_op_id_mutant(self):
        """Requires public fixtures and U133 admission; see ORACLE.md."""

    def test_a3_conditional_contract_covers_persistence_without_model_calls(self):
        text = self.text(GUIDE)
        self.mentions(text, "U132", "U133", "op_id", "run_id", "agent_lifecycle")
        self.rule(text, r"2\s*(?:s\b|seconds?)", "M4 conditional execution bound")
        self.rule(text, r"exit.{0,140}(?:not|doesn.t).{0,120}persist|(?:not|doesn.t).{0,140}exit.{0,120}persist", "M4 exit zero is not persistence evidence")
        self.rule(text, r"(?:no|never|not).{0,120}(?:provider|model).{0,100}(?:import|call)|(?:no|never|not).{0,120}(?:import|call).{0,100}(?:provider|model)", "M4 hooks must not invoke providers")

    def test_a5_caller_asserted_identity_and_same_user_boundary(self):
        text = self.text(GUIDE)
        self.mentions(text, "caller-asserted", "same-user", "CW_HOME", "provider", "Antigravity")
        self.rule(text, r"(?:not|no).{0,120}authenticat", "M6 provenance labels do not authenticate identity")
        self.rule(text, r"(?:not|do not|does not).{0,120}(?:govern|restrict|control).{0,120}(?:Antigravity|routing)|Antigravity.{0,120}(?:not|independent).{0,120}(?:restriction|provider|routing)", "M6 TaskLight policy does not control harness routing")

    def test_a5_public_artifacts_contain_no_operator_or_secret_leaks(self):
        for relative in PUBLIC_ARTIFACTS:
            text = self.text(relative)
            self.assertNotIn(os.uname().nodename, text, "operator hostname leaked")
            self.assertNotIn(str(Path.home()), text, "operator home path leaked")
            self.assertNotRegex(text, r"(?:^|[\s\"'])/(?:home|Users|root)/", "local user path leaked")
            self.assertNotRegex(text, r"\bscr-[a-z][a-z0-9-]+\b", "private dispatcher name leaked")
            self.assertNotRegex(text, r"(?i)\b(?:receipt|spool)[_ -]?(?:path|file)?\s*[:=]\s*[\"']?/", "private receipt/spool path leaked")
            self.assertNotRegex(text, r"-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}")
