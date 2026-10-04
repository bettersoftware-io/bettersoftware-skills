// Turns what the audit saw into a verdict. No browser here: these functions
// take the census and the trace as data, so they can be tested without one.
//
// Two things fail an animation that is alive in steady state:
//
//   1. It animates a property other than `transform` and `opacity`. That is
//      the rule that holds in every browser engine.
//   2. Chromium reports that it did not composite it (`compositeFailed` in the
//      trace). That is the browser's own verdict, and it catches what the
//      property list cannot: two animations of one property on an element, a
//      filter that moves pixels, an SVG element the compositor will not take.

import type { AllowedMotion } from "./allowed.mts";
import type { MotionSample, SeenAnimation } from "./motion-probe.mts";
import { describeCost, fromKeyframeKey, isCompositorOnly } from "./properties.mts";

/** One animation Chromium reported as not composited. */
export interface TracedFailure {
  /** The keyframes name, the transitioned property, or a script animation's id. */
  name: string;
  /** The element, as Chromium names it: `DIV id='x' class='a b'`. */
  node: string;
  /** Chromium's `CompositorAnimations::FailureReason` bits. */
  compositeFailed: number;
  unsupportedProperties: string[];
}

export interface MotionFinding {
  /** The name to use in the allow-list's `motion` list. */
  animation: string;
  target: string;
  message: string;
}

export interface MotionVerdict {
  findings: MotionFinding[];
  accepted: { animation: string; target: string; reason: string }[];
  /**
   * False when this browser composites nothing at all, so its trace says
   * nothing about any one animation. The property rule was still applied.
   */
  chromiumVerdict: boolean;
}

export interface JudgeOptions {
  sample: MotionSample;
  traced: TracedFailure[];
  allowed: AllowedMotion[];
  /** Fail on anything alive at all, and on any animation-frame callback. */
  mustBeStill?: boolean;
}

interface TraceEvent {
  name?: string;
  id?: string;
  id2?: { local?: string };
  args?: { data?: { displayName?: string; nodeName?: string; compositeFailed?: number; unsupportedProperties?: string[] } };
}

/** Set on every animation when the browser has compositor animations switched off. */
const COMPOSITING_OFF = 1;

/** The reasons seen in measurement. Any other bit is printed as its number. */
const FAILURE_REASONS: Record<number, string> = {
  0: "compositor animations are switched off in this browser",
  5: "the element is not in a state the compositor can animate",
  6: "the element has another animation of the same property",
  12: "the filter can move pixels (a blur, a drop shadow)",
  13: "it animates a property the compositor cannot animate",
  17: "the animation changes nothing visible",
  19: "an SVG element is animated with translate, rotate or scale",
};

/** The name an animation is printed under, and accepted under. */
export function animationName({ kind, name }: Pick<SeenAnimation, "kind" | "name">): string {
  if (kind === "CSSTransition") {
    return `transition:${name}`;
  }

  return name === "" ? "(script)" : name;
}

/** Reads Chromium's trace for the animations it refused to composite. */
export function readTracedFailures(trace: unknown): TracedFailure[] {
  const events = (Array.isArray(trace) ? trace : ((trace as { traceEvents?: unknown[] } | null)?.traceEvents ?? [])) as TraceEvent[];
  const byAnimation = new Map<string, TracedFailure>();

  for (const event of events) {
    const data = event.args?.data;
    const id = event.id2?.local ?? event.id;

    if (event.name !== "Animation" || data === undefined || id === undefined) {
      continue;
    }

    const entry = byAnimation.get(id) ?? { name: "", node: "", compositeFailed: 0, unsupportedProperties: [] };

    byAnimation.set(id, {
      name: data.displayName ?? entry.name,
      node: data.nodeName ?? entry.node,
      compositeFailed: entry.compositeFailed | (data.compositeFailed ?? 0),
      unsupportedProperties: [...new Set([...entry.unsupportedProperties, ...(data.unsupportedProperties ?? [])])],
    });
  }

  const distinct = new Map<string, TracedFailure>();

  for (const failure of byAnimation.values()) {
    if (failure.compositeFailed !== 0) {
      distinct.set(`${failure.name}|${failure.node}|${failure.compositeFailed}`, failure);
    }
  }

  return [...distinct.values()];
}

export function describeCompositeFailure(bits: number): string {
  const reasons: string[] = [];

  for (let bit = 0; bit < 31; bit += 1) {
    if ((bits & (1 << bit)) !== 0) {
      reasons.push(FAILURE_REASONS[bit] ?? `reason bit ${bit}`);
    }
  }

  return reasons.join("; ");
}

export function judgeMotion({ sample, traced, allowed, mustBeStill = false }: JudgeOptions): MotionVerdict {
  const findings: MotionFinding[] = [];
  const accepted: MotionVerdict["accepted"] = [];

  function report(animation: string, target: string, message: string): void {
    const entry = allowed.find((candidate) => candidate.animation === animation);

    if (entry === undefined) {
      findings.push({ animation, target, message });
    } else {
      accepted.push({ animation, target, reason: entry.reason });
    }
  }

  for (const animation of sample.animations) {
    const name = animationName(animation);

    for (const property of animation.properties.map(fromKeyframeKey).filter((candidate) => !isCompositorOnly(candidate))) {
      const { cost, instead } = describeCost(property);

      report(name, animation.target, `animates \`${property}\`. ${cost} ${instead}`);
    }

    if (mustBeStill) {
      report(name, animation.target, `is ${animation.state} although the page was asked to be still.`);
    }
  }

  const chromiumVerdict = !traced.some((failure) => (failure.compositeFailed & COMPOSITING_OFF) !== 0);

  // Chromium's trace covers the whole page load. Only an animation the census
  // saw alive in the sampling window is steady-state, so only those count.
  for (const failure of chromiumVerdict ? traced : []) {
    const alive = sample.animations.filter((animation) => animation.name === failure.name);

    // An animation already failed for its properties is not reported twice.
    const alreadyFailed = alive.some((animation) => animation.properties.some((key) => !isCompositorOnly(fromKeyframeKey(key))));

    if (alive.length === 0 || alreadyFailed) {
      continue;
    }

    const properties = failure.unsupportedProperties.length === 0 ? "" : ` (${failure.unsupportedProperties.join(", ")})`;

    report(
      animationName(alive[0] as SeenAnimation),
      failure.node,
      `was not composited by Chromium: ${describeCompositeFailure(failure.compositeFailed)}${properties}. It runs on the main thread on every frame (docs/performance.md, "Reading a trace").`,
    );
  }

  if (mustBeStill && sample.rafCallbacks > 0) {
    findings.push({
      animation: "requestAnimationFrame",
      target: "(page)",
      message: `${sample.rafCallbacks} animation-frame callback(s) were requested although the page was asked to be still.`,
    });
  }

  return { findings, accepted, chromiumVerdict };
}

/** One line per animation seen, for the report. */
export function describeAnimation(animation: SeenAnimation, samples: number): string {
  const properties = animation.properties.map(fromKeyframeKey).join(", ") || "no properties";
  const again = animation.started > 1 ? `, started ${animation.started} times` : "";
  const elements = animation.elements > 1 ? ` (${animation.elements} elements)` : "";

  return `${animation.kind} ${animationName(animation)} on ${animation.target}${elements}: ${properties} (${animation.state}, ${animation.duration} x ${animation.iterations}, alive in ${animation.seen} of ${samples} snapshots${again})`;
}
