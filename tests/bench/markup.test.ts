// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { DiaryDayGroupVM } from "../../src/views/plan";
import { renderPlanDiary } from "../../src/views/plan";

it("renders hostile diary text passively; DOM emulation supplies no paint/scroll evidence", () => {
  const text = "<img src=x onerror=alert(1)>";
  const groups: DiaryDayGroupVM[] = [{ day: "Synthetic day", entries: [{ kind: "microtask", day: "Synthetic day", at: "12:00", title: text,
    outcome: text, took: "1m", author: "alice", evidence: [] }] }];
  const element = renderPlanDiary(document, groups);
  expect(element.textContent).toContain(text);
  expect(element.querySelectorAll("img,script,svg")).toHaveLength(0);
  expect(element.querySelectorAll(".entry")).toHaveLength(1);
});
