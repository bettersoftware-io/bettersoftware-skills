// The census that runs inside the page: which animations are alive, on what,
// animating which properties, and how many animation-frame callbacks the page
// asks for.
//
// `document.getAnimations()` lists every CSS animation, CSS transition and
// script animation. It shows what no screenshot and no jsdom test can: a
// transition started again by every data update, a flash retriggered per
// tick, a loop left paused instead of removed.
//
// `sampleMotion` MUST stay self-contained. Playwright sends its source text to
// the page, so it cannot use an import or anything declared outside itself.
// The browser types it needs are declared here, by hand, because the project's
// tooling is typechecked without the DOM library.

export interface MotionSampleOptions {
  /** How many snapshots to take. */
  samples: number;
  /** Milliseconds between snapshots. */
  intervalMs: number;
}

export interface SeenAnimation {
  /** `CSSAnimation`, `CSSTransition`, or `Animation` for one started by script. */
  kind: string;
  /** The keyframes name, the transitioned property, or a script animation's id (often empty). */
  name: string;
  /** The element, as `tag#id[data-testid="…"].class::pseudo`, with its nearest named ancestor when it has no name of its own. */
  target: string;
  /** How many separate elements match that description. */
  elements: number;
  /** Keys of the keyframes as script names them, e.g. `backgroundColor`. */
  properties: string[];
  /** The play state when last seen: `running` or `paused`. */
  state: string;
  /** Duration of one iteration, e.g. `600ms`. */
  duration: string;
  /** Iteration count, e.g. `1` or `Infinity`. */
  iterations: string;
  /** Snapshots it was alive in. */
  seen: number;
  /** Separate animation objects seen under this description: above 1, it was started again. */
  started: number;
}

export interface MotionSample {
  elapsedMs: number;
  samples: number;
  /** `requestAnimationFrame` calls made while sampling. */
  rafCallbacks: number;
  /** Every animation seen alive (not `finished`, not `idle`) in any snapshot. */
  animations: SeenAnimation[];
}

interface PageElement {
  tagName: string;
  id: string;
  parentElement: PageElement | null;
  getAttribute(name: string): string | null;
}

interface PageEffect {
  target?: PageElement | null;
  pseudoElement?: string | null;
  getKeyframes?(): Record<string, unknown>[];
  getTiming(): { duration?: number | string; iterations?: number };
}

interface PageAnimation {
  id: string;
  playState: string;
  animationName?: string;
  transitionProperty?: string;
  effect: PageEffect | null;
}

interface Page {
  document: { getAnimations(): PageAnimation[] };
  requestAnimationFrame(callback: (time: number) => void): number;
}

export async function sampleMotion(options: MotionSampleOptions): Promise<MotionSample> {
  const page = globalThis as unknown as Page;
  const started = performance.now();
  const originalRaf = page.requestAnimationFrame;
  let rafCallbacks = 0;

  page.requestAnimationFrame = (callback) => {
    rafCallbacks += 1;

    return originalRaf.call(page, callback);
  };

  function nameOf(element: PageElement): string {
    const testId = element.getAttribute("data-testid");
    const classes = (element.getAttribute("class") ?? "").trim();

    return [
      element.id === "" ? "" : `#${element.id}`,
      testId === null ? "" : `[data-testid="${testId}"]`,
      classes === "" ? "" : `.${classes.split(/\s+/).slice(0, 2).join(".")}`,
    ].join("");
  }

  function describeTarget(effect: PageEffect | null): string {
    const element = effect?.target;

    if (element === undefined || element === null) {
      return "(no element)";
    }

    const own = `${element.tagName.toLowerCase()}${nameOf(element)}${effect?.pseudoElement ?? ""}`;

    if (nameOf(element) !== "") {
      return own;
    }

    // A bare `td` says little: add the nearest ancestor that has a name.
    for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      if (nameOf(ancestor) !== "") {
        return `${own} in ${ancestor.tagName.toLowerCase()}${nameOf(ancestor)}`;
      }
    }

    return own;
  }

  function describe(animation: PageAnimation): SeenAnimation {
    const timing = animation.effect?.getTiming();
    const properties = new Set<string>();

    for (const keyframe of animation.effect?.getKeyframes?.() ?? []) {
      for (const key of Object.keys(keyframe)) {
        if (key !== "offset" && key !== "computedOffset" && key !== "easing" && key !== "composite") {
          properties.add(key);
        }
      }
    }

    const kind =
      animation.animationName !== undefined ? "CSSAnimation" : animation.transitionProperty !== undefined ? "CSSTransition" : "Animation";

    return {
      kind,
      name: animation.animationName ?? animation.transitionProperty ?? animation.id,
      target: describeTarget(animation.effect),
      properties: [...properties].sort(),
      state: animation.playState,
      duration: typeof timing?.duration === "number" ? `${Math.round(timing.duration)}ms` : "auto",
      iterations: String(timing?.iterations ?? 1),
      elements: 0,
      seen: 0,
      started: 0,
    };
  }

  const seen = new Map<string, SeenAnimation>();
  const objects = new Set<PageAnimation>();
  const elements = new Map<string, Set<PageElement>>();

  try {
    for (let index = 0; index < options.samples; index += 1) {
      for (const animation of page.document.getAnimations()) {
        if (animation.playState === "finished" || animation.playState === "idle") {
          continue;
        }

        const description = describe(animation);
        const key = [description.kind, description.name, description.target, description.properties.join(",")].join("|");
        const entry = seen.get(key) ?? description;

        entry.state = description.state;
        entry.seen += 1;

        if (!objects.has(animation)) {
          objects.add(animation);
          entry.started += 1;
        }

        const targets = elements.get(key) ?? new Set();
        const target = animation.effect?.target;

        if (target !== undefined && target !== null) {
          targets.add(target);
        }

        elements.set(key, targets);
        entry.elements = targets.size;

        seen.set(key, entry);
      }

      await new Promise((resolve) => {
        setTimeout(resolve, options.intervalMs);
      });
    }
  } finally {
    page.requestAnimationFrame = originalRaf;
  }

  return {
    elapsedMs: Math.round(performance.now() - started),
    samples: options.samples,
    rafCallbacks,
    animations: [...seen.values()],
  };
}
