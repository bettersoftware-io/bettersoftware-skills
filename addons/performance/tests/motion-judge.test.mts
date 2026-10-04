import { describe, expect, it } from "vitest";

import {
  describeAnimation,
  describeCompositeFailure,
  judgeMotion,
  readTracedFailures,
} from "../files/tools/perf/lib/motion-judge.mts";
import type { MotionSample, SeenAnimation } from "../files/tools/perf/lib/motion-probe.mts";

describe("the verdict on a census", () => {
  it("passes animations of transform and opacity", () => {
    const sample = createSample([createAnimation({ properties: ["opacity", "transform", "translate"] })]);

    expect(judgeMotion({ sample, traced: [], allowed: [] })).toEqual({ findings: [], accepted: [], chromiumVerdict: true });
  });

  it("fails an animation of any other property, under the name the allow-list uses", () => {
    const sample = createSample([createAnimation({ name: "flash", properties: ["backgroundColor", "opacity"] })]);
    const { findings } = judgeMotion({ sample, traced: [], allowed: [] });

    expect(findings).toMatchObject([{ animation: "flash", target: "td" }]);
    expect(findings[0]?.message).toContain("animates `background-color`. It is a paint property");
  });

  it("names a transition by its property and a script animation without an id as (script)", () => {
    const sample = createSample([
      createAnimation({ kind: "CSSTransition", name: "color", properties: ["color"] }),
      createAnimation({ kind: "Animation", name: "", properties: ["boxShadow"] }),
    ]);

    expect(judgeMotion({ sample, traced: [], allowed: [] }).findings.map((finding) => finding.animation)).toEqual([
      "transition:color",
      "(script)",
    ]);
  });

  it("accepts a finding only through an allow-list entry, and keeps its reason", () => {
    const sample = createSample([
      createAnimation({ name: "flash", properties: ["backgroundColor"] }),
      createAnimation({ name: "grow", properties: ["width"] }),
    ]);
    const verdict = judgeMotion({ sample, traced: [], allowed: [{ animation: "flash", reason: "Runs once a day." }] });

    expect(verdict.accepted).toEqual([{ animation: "flash", target: "td", reason: "Runs once a day." }]);
    expect(verdict.findings.map((finding) => finding.animation)).toEqual(["grow"]);
  });
});

describe("Chromium's own verdict", () => {
  const traced = [{ name: "spin", node: "DIV class='logo'", compositeFailed: 64, unsupportedProperties: [] }];

  it("fails a transform animation that Chromium did not composite, and says why", () => {
    const sample = createSample([createAnimation({ name: "spin", properties: ["transform"] })]);
    const { findings } = judgeMotion({ sample, traced, allowed: [] });

    expect(findings).toMatchObject([{ animation: "spin", target: "DIV class='logo'" }]);
    expect(findings[0]?.message).toContain("the element has another animation of the same property");
  });

  it("ignores a failure for an animation that was not alive in the sampling window", () => {
    const sample = createSample([createAnimation({ name: "pulse", properties: ["opacity"] })]);

    expect(judgeMotion({ sample, traced, allowed: [] }).findings).toEqual([]);
  });

  it("does not report an animation twice when its properties already failed it", () => {
    const sample = createSample([createAnimation({ name: "grow", properties: ["width"] })]);
    const failure = { name: "grow", node: "DIV", compositeFailed: 8224, unsupportedProperties: ["width"] };

    expect(judgeMotion({ sample, traced: [failure], allowed: [] }).findings).toHaveLength(1);
  });
});

describe("a browser that composites nothing", () => {
  it("is not taken as a verdict on any one animation, and says so", () => {
    const sample = createSample([createAnimation({ name: "spin", properties: ["transform"] })]);
    const traced = [{ name: "spin", node: "DIV", compositeFailed: 1, unsupportedProperties: [] }];

    expect(judgeMotion({ sample, traced, allowed: [] })).toEqual({ findings: [], accepted: [], chromiumVerdict: false });
  });
});

describe("the strict reduced-motion pass", () => {
  it("leaves a compositor-only animation alone unless the page must be still", () => {
    const sample = createSample([createAnimation({ name: "pulse", properties: ["opacity"], state: "paused" })], 12);

    expect(judgeMotion({ sample, traced: [], allowed: [] }).findings).toEqual([]);
    expect(judgeMotion({ sample, traced: [], allowed: [], mustBeStill: true }).findings).toEqual([
      { animation: "pulse", target: "td", message: "is paused although the page was asked to be still." },
      {
        animation: "requestAnimationFrame",
        target: "(page)",
        message: "12 animation-frame callback(s) were requested although the page was asked to be still.",
      },
    ]);
  });
});

describe("reading the trace", () => {
  it("joins the events of one animation and keeps only the ones that were not composited", () => {
    const trace = {
      traceEvents: [
        createTraceEvent("0x1", { displayName: "spin", nodeName: "DIV id='a'" }),
        createTraceEvent("0x1", { compositeFailed: 64 }),
        createTraceEvent("0x1", { state: "finished" }),
        createTraceEvent("0x2", { displayName: "fade", nodeName: "DIV id='b'" }),
        createTraceEvent("0x3", { displayName: "grow", nodeName: "DIV id='c'" }),
        createTraceEvent("0x3", { compositeFailed: 8224, unsupportedProperties: ["width"] }),
        { name: "SomethingElse", id2: { local: "0x4" }, args: { data: { compositeFailed: 1 } } },
      ],
    };

    expect(readTracedFailures(trace)).toEqual([
      { name: "spin", node: "DIV id='a'", compositeFailed: 64, unsupportedProperties: [] },
      { name: "grow", node: "DIV id='c'", compositeFailed: 8224, unsupportedProperties: ["width"] },
    ]);
  });

  it("reports one failure for an animation that is started again and again", () => {
    const again = ["0x1", "0x2", "0x3"].flatMap((id) => [
      createTraceEvent(id, { displayName: "color", nodeName: "TD" }),
      createTraceEvent(id, { compositeFailed: 8224, unsupportedProperties: ["color"] }),
    ]);

    expect(readTracedFailures(again)).toHaveLength(1);
  });

  it("names the reasons that were measured, and gives any other bit by number", () => {
    expect(describeCompositeFailure(64)).toBe("the element has another animation of the same property");
    expect(describeCompositeFailure(4096)).toBe("the filter can move pixels (a blur, a drop shadow)");
    expect(describeCompositeFailure(8224)).toBe(
      "the element is not in a state the compositor can animate; it animates a property the compositor cannot animate",
    );
    expect(describeCompositeFailure(1 << 9)).toBe("reason bit 9");
  });
});

describe("a line of the report", () => {
  it("names the kind, the target, the properties and how often it was started", () => {
    const animation = createAnimation({ name: "flash", properties: ["backgroundColor"], elements: 3, seen: 20, started: 5 });

    expect(describeAnimation(animation, 80)).toBe(
      "CSSAnimation flash on td (3 elements): background-color (running, 600ms x 1, alive in 20 of 80 snapshots, started 5 times)",
    );
  });
});

function createAnimation(overrides: Partial<SeenAnimation> = {}): SeenAnimation {
  return {
    kind: "CSSAnimation",
    name: "tick",
    target: "td",
    elements: 1,
    properties: ["opacity"],
    state: "running",
    duration: "600ms",
    iterations: "1",
    seen: 1,
    started: 1,
    ...overrides,
  };
}

function createSample(animations: SeenAnimation[], rafCallbacks = 0): MotionSample {
  return { elapsedMs: 4000, samples: 80, rafCallbacks, animations };
}

function createTraceEvent(id: string, data: Record<string, unknown>): Record<string, unknown> {
  return { name: "Animation", cat: "blink.animations", id2: { local: id }, args: { data } };
}
