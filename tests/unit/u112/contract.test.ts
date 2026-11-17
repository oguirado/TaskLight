import { expectTypeOf, it } from "vitest";
import type { deriveActivity } from "../../../src/app/activity";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import type { SwarmAgentVM, SwarmRegistration, SwarmViewModel } from "../../../src/app/swarm_vm";
import { renderSwarmView } from "../../../src/views/swarm";
import type { PlanProjection, PlanTask } from "../../../src/plan/types";
import { deterministic, input } from "./fixtures";
import type { Input } from "./fixtures";

type Registration = Readonly<{ lifecycle?: "deployed" | "alive" | "finished" | "failed";
  run_id?: string; swarm?: string; harness?: string }>;
type Agent = Registration & Readonly<{ agent: string; tasks: readonly PlanTask[];
  current_task_id: string | null; active_micro_id: string | null;
  micro_done: number | null; micro_total: number | null; activity: ReturnType<typeof deriveActivity>;
  last_beat_ts: number | null; last_beat_age_ms: number | null;
  waiting_on: readonly Readonly<{ task_id: string; upstream_id: string; owner: string | null; missing: boolean }>[];
  unanswered_questions: number }>;
type ViewModel = Readonly<{ room: string; agents: readonly Agent[];
  progress: PlanProjection["rollup"] | null; refresh_at_ms: number | null }>;

deterministic();
it("M2 freezes exact readonly exports and derivation/render signatures", () => {
  deriveSwarmViewModel(input());
  expectTypeOf<SwarmRegistration>().toEqualTypeOf<Registration>();
  expectTypeOf<SwarmAgentVM>().toEqualTypeOf<Agent>();
  expectTypeOf<SwarmViewModel>().toEqualTypeOf<ViewModel>();
  expectTypeOf<typeof deriveSwarmViewModel>().parameters.toEqualTypeOf<[Input]>();
  expectTypeOf<typeof deriveSwarmViewModel>().returns.toEqualTypeOf<ViewModel>();
  expectTypeOf<typeof renderSwarmView>().parameters.toEqualTypeOf<[Document, SwarmViewModel]>();
  expectTypeOf<typeof renderSwarmView>().returns.toEqualTypeOf<HTMLElement>();
});
