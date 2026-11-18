import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { createAgentLink } from "../../../src/app/agent_link";
import type { RoomGapFrame, RoomSyncedFrame, RoomSyncErrorFrame } from "../../../src/app/agent_link";
import { createAgentStore } from "../../../src/app/agent_store";
import type { PlanningTemplate } from "../../../src/plan";
import { EXT_ID, FakeAppClock, HELLO, pageRuntime } from "../u85/helpers";

type Frame = { t: string; rid?: string; event?: { id: string; lamport: number } };
type Page = { request: { rid: string; since: { demo: number } }; frames: Frame[] };
type ReplayFixture = {
  write: { ok: true } | { code: string };
  first: number;
  current: number;
  gap: number;
  saved: number;
  history: { id: string; lamport: number }[];
  complete: Page[];
  resumed: Page[];
  failed: Page[];
  templates: PlanningTemplate[];
};

function fixture(mode: "cross-boundary" | "legacy"): ReplayFixture {
  const run = spawnSync("python3", ["-B", "-m", "tests.unit.c4m.relay_driver", mode], {
    cwd: process.cwd(), encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  expect(run.error, "offline relay fixture execution").toBeUndefined();
  expect(run.status, run.stderr).toBe(0);
  const result = JSON.parse(run.stdout) as ReplayFixture;
  expect(result.write, "real writer must accept the next plan in the same room").toEqual({ ok: true });
  return result;
}

function replay(data: ReplayFixture, pages: Page[], saved: number, prefix: Frame[] = []) {
  const gaps: RoomGapFrame[] = [];
  const synced: RoomSyncedFrame[] = [];
  const errors: RoomSyncErrorFrame[] = [];
  const resolutions = new Set<string>();
  const requestIds: string[] = [];
  const delivered: { id: string; lamport: number; accepted: string }[] = [];
  const store = createAgentStore({ maxPerRoom: 600, templates: (id, hash) => {
    resolutions.add(`${id}:${hash}`);
    return data.templates.find(template => template.id === id && template.hash === hash);
  } });
  for (const frame of prefix) expect(store.ingestChecked(frame.event)).toBe("accepted");

  const runtime = pageRuntime();
  const clock = new FakeAppClock();
  const link = createAgentLink({
    extId: EXT_ID, connect: runtime.connect, clock, nonce: () => "c4m",
    since: () => ({ demo: saved }),
    onRoomHello: () => undefined,
    onRoomEvent: frame => {
      const event = frame.event as { id: string; lamport: number };
      delivered.push({ id: event.id, lamport: event.lamport, accepted: store.ingestChecked(frame.event) });
    },
    onRoomGap: frame => gaps.push(frame),
    onRoomSynced: frame => synced.push(frame),
    onRoomSyncError: frame => errors.push(frame),
  });
  try {
    link.start();
    const port = runtime.last();
    port.emit({ t: "snapshot", v: 1, nonce: "c4m", items: [] });
    port.emit(HELLO);
    for (const [index, page] of pages.entries()) {
      const request = port.ofType("room_sync")[index];
      expect(request).toMatchObject({ t: "room_sync", v: 1, since: page.request.since });
      expect(request?.rid).toEqual(expect.any(String));
      const rid = String(request?.rid);
      expect(requestIds).not.toContain(rid);
      requestIds.push(rid);
      for (const frame of page.frames) {
        expect(frame.rid).toBe(page.request.rid);
        if (frame.t === "room_event" && frame === page.frames[0]) {
          port.emit({ ...frame, rid: "obsolete-replay" });
        }
        port.emit({ ...frame, rid });
      }
    }
    expect(port.ofType("room_sync")).toHaveLength(pages.length);
    const projection = store.plan("demo")?.projection;
    return { delivered, synced, gaps, errors, projection, resolutions, requestIds,
      ids: store.events("demo").map(event => event.id) };
  } finally {
    link.stop();
  }
}

function checkCompleteReplay(data: ReplayFixture) {
  const full = replay(data, data.complete, 0);
  const prefix = data.complete.flatMap(page => page.frames)
    .filter(frame => frame.event !== undefined && frame.event.lamport <= data.saved);
  const resumed = replay(data, data.resumed, data.saved, prefix);
  for (const [saved, result] of [[0, full], [data.saved, resumed]] as const) {
    const expected = data.history.filter(event => event.lamport > saved && event.lamport !== data.gap);
    expect(result.delivered).toEqual(expected.map(event => ({ ...event, accepted: "accepted" })));
    expect(new Set(result.ids)).toEqual(new Set(data.history
      .filter(event => event.lamport !== data.gap).map(event => event.id)));
    expect(result.errors).toEqual([]);
    expect(result.gaps).toEqual([{
      t: "room_gap", v: 1, room: "demo", rid: result.requestIds[0],
      from_lamport: data.gap, to_lamport: data.gap, reason: "oversize",
    }]);
    expect(result.synced.map(({ rid, upto, more }) => ({ rid, upto, more }))).toEqual([
      { rid: result.requestIds[0], upto: saved + 500, more: true },
      { rid: result.requestIds[1], upto: data.history.at(-1)?.lamport, more: false },
    ]);
    expect(result.projection?.plan).toMatchObject({
      title: "Current plan", template_id: "cli-library", opened_lamport: data.current,
      phase: "api-design", state: "active",
    });
    expect(result.projection?.archived_plans).toMatchObject([
      { title: "Legacy plan", template_id: "blank", tasks_total: 1, tasks_done: 0 },
    ]);
    expect(result.projection?.tasks).toMatchObject([{ id: "T01", title: "Current plan task" }]);
    for (const template of data.templates) {
      expect(result.resolutions).toContain(`${template.id}:${template.hash}`);
    }
  }
  expect(data.first).toBe(1);
  expect(full.projection).toEqual(resumed.projection);
}

it("replays real paged frames from zero and a saved cursor across the old journal ceiling", () => {
  checkCompleteReplay(fixture("cross-boundary"));
});

it("preserves template resolution, gaps and terminal certification on a legacy journal", () => {
  const data = fixture("legacy");
  checkCompleteReplay(data);
  const failed = replay(data, data.failed, data.saved);
  expect(failed.synced).toEqual([]);
  expect(failed.errors).toEqual([
    { t: "room_sync_error", v: 1, rid: failed.requestIds[0], room: "demo", code: "room_sync_failed" },
  ]);
  expect(failed.delivered).toEqual(data.history
    .filter(event => event.lamport > data.saved && event.lamport < data.gap)
    .map(event => ({ ...event, accepted: "accepted" })));
});
