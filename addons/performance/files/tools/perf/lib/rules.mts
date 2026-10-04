// The animation rules that can be decided from source.
//
//   1. A transition or a @keyframes block animates only `transform` and
//      `opacity` (and the single-transform properties translate/rotate/scale).
//   2. No `transition: all`, written out or implied by naming no property.
//   3. No `var()` inside a transform value in a keyframe.
//   4. One `animation` list does not put two animations of the same property
//      on one element.
//
// The same rules are applied to `element.animate()` keyframes written as a
// literal. Whatever the source does not settle is returned as unjudged.

import type { CssDeclaration } from "./css.mts";
import { splitTopLevel } from "./files.mts";
import { describeCost, isCompositorOnly, isTransformFamily, normaliseProperty } from "./properties.mts";
import type { AnimateCall } from "./waapi.mts";

export interface Finding {
  file: string;
  line: number;
  /** The selector, `@keyframes <name>` or `.animate()`. With `property`, the allow-list key. */
  rule: string;
  property: string;
  message: string;
}

export interface Unjudged {
  file: string;
  line: number;
  why: string;
}

/** How much animation code was judged. All zero means nothing was judged. */
export interface Tally {
  transitions: number;
  keyframes: number;
  animateCalls: number;
}

export interface Judgement {
  findings: Finding[];
  unjudged: Unjudged[];
  tally: Tally;
}

/** @keyframes name → the properties it animates. */
export type KeyframesIndex = Map<string, Set<string>>;

const TIME = /^[+-]?(\d+\.?\d*|\.\d+)(ms|s)$/i;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const GLOBAL_VALUES = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const TIMING_WORDS = new Set([
  "ease",
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step-start",
  "step-end",
  "normal",
  "allow-discrete",
]);
const ANIMATION_WORDS = new Set([
  ...TIMING_WORDS,
  "infinite",
  "reverse",
  "alternate",
  "alternate-reverse",
  "forwards",
  "backwards",
  "both",
  "running",
  "paused",
]);

/** Declarations inside a keyframe that set how it plays, not what it animates. */
const NOT_ANIMATED = new Set(["animation-timing-function", "animation-composition"]);

const VAR_IN_TRANSFORM =
  'Keyframe values must be literal: with a variable, the main thread has to resolve the value before the compositor can run the animation, and again whenever the variable changes. Write the numbers in the keyframes and put the variable in the timing, which is read once when the animation starts: `animation-duration: var(--d)`, or a negative `animation-delay` to start part-way (docs/performance.md, "Progress bars").';

const TRANSITION_ALL =
  "It animates every property that changes, layout and paint ones included, and it starts a new transition for every style change that live data makes on this element. Name what should move: `transition: opacity 0.2s, transform 0.2s`.";

export function indexKeyframes(declarations: CssDeclaration[]): KeyframesIndex {
  const index: KeyframesIndex = new Map();

  for (const { keyframes, property } of declarations) {
    if (keyframes !== undefined && !NOT_ANIMATED.has(property)) {
      index.set(keyframes, (index.get(keyframes) ?? new Set()).add(property));
    }
  }

  return index;
}

/**
 * Judges one stylesheet. `elsewhere` resolves a keyframes name the file itself
 * does not define; it returns nothing when the name is unknown or ambiguous.
 */
export function judgeStylesheet(
  file: string,
  declarations: CssDeclaration[],
  elsewhere: (name: string) => Set<string> | undefined = () => undefined,
): Judgement {
  const findings: Finding[] = [];
  const unjudged: Unjudged[] = [];
  const own = indexKeyframes(declarations);
  const reported = new Set<string>();
  let transitions = 0;

  function report(finding: Omit<Finding, "file">): void {
    const key = `${finding.rule}\n${finding.property}\n${finding.message}`;

    // A property repeated in `from` and `to` is one finding, on its first line.
    if (!reported.has(key)) {
      reported.add(key);
      findings.push({ file, ...finding });
    }
  }

  for (const declaration of declarations) {
    const { line, property, rule, keyframes } = declaration;
    const value = declaration.value.replace(/!important/i, "").trim();

    if (keyframes !== undefined) {
      if (NOT_ANIMATED.has(property)) {
        continue;
      }

      if (!isCompositorOnly(property)) {
        const { cost, instead } = describeCost(property);

        report({ line, rule, property, message: `@keyframes ${keyframes} animates \`${property}\`. ${cost} ${instead}` });
      } else if (isTransformFamily(property) && value.includes("var(")) {
        report({
          line,
          rule,
          property,
          message: `@keyframes ${keyframes} has \`var()\` inside \`${property}\`. ${VAR_IN_TRANSFORM}`,
        });
      }

      continue;
    }

    if (property === "transition" || property === "transition-property") {
      for (const target of transitionTargets(property, value)) {
        if (target === "none") {
          continue;
        }

        if (target === "unknown") {
          unjudged.push({ file, line, why: `\`${property}: ${value}\` takes its property from a variable` });
          continue;
        }

        transitions += 1;

        if (target === "all" || target === "implied-all") {
          const written = target === "all" ? "`transition: all`." : `\`${property}: ${value}\` names no property, which means \`all\`.`;

          report({ line, rule, property: "all", message: `${written} ${TRANSITION_ALL}` });
        } else if (!isCompositorOnly(target)) {
          const { cost, instead } = describeCost(target);

          report({ line, rule, property: target, message: `A transition on \`${target}\`. ${cost} ${instead}` });
        }
      }
    }

    if (property === "animation" || property === "animation-name") {
      const names = animationNames(property, value);
      const resolved = names.map((name) => ({ name, properties: own.get(name) ?? elsewhere(name) }));

      for (const { name, properties } of resolved) {
        if (properties === undefined) {
          unjudged.push({ file, line, why: `animation \`${name}\` has no single @keyframes in the stylesheets that were read` });
        }
      }

      for (const [index, first] of resolved.entries()) {
        for (const second of resolved.slice(index + 1)) {
          for (const shared of first.properties ?? []) {
            if (second.properties?.has(shared)) {
              report({
                line,
                rule,
                property: shared,
                message: `\`${property}\` puts \`${first.name}\` and \`${second.name}\` on one element, and both animate \`${shared}\`. With two animations of one property on an element, the browser composites neither. Merge them into one @keyframes, or move one to a wrapper or a pseudo-element (docs/performance.md, "One animation per property per element").`,
              });
            }
          }
        }
      }
    }
  }

  return { findings, unjudged, tally: { transitions, keyframes: own.size, animateCalls: 0 } };
}

/** Judges the `element.animate()` calls found in one TypeScript file. */
export function judgeAnimateCalls(file: string, calls: AnimateCall[]): Judgement {
  const findings: Finding[] = [];
  const unjudged: Unjudged[] = [];
  let animateCalls = 0;

  for (const { line, properties, unjudged: why } of calls) {
    if (properties === undefined) {
      unjudged.push({ file, line, why: `\`.animate(\`: ${why ?? "the keyframes could not be read"}` });
      continue;
    }

    animateCalls += 1;

    const seen = new Set<string>();

    for (const { property, value } of properties) {
      const varInTransform = isTransformFamily(property) && value.includes("var(");
      const key = `${property}:${varInTransform}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      if (!isCompositorOnly(property)) {
        const { cost, instead } = describeCost(property);

        findings.push({ file, line, rule: ".animate()", property, message: `\`.animate()\` animates \`${property}\`. ${cost} ${instead}` });
      } else if (varInTransform) {
        findings.push({ file, line, rule: ".animate()", property, message: `\`.animate()\` has \`var()\` inside \`${property}\`. ${VAR_IN_TRANSFORM}` });
      }
    }
  }

  return { findings, unjudged, tally: { transitions: 0, keyframes: 0, animateCalls } };
}

/** What each item of a transition animates: a property, `all`, `implied-all`, `none` or `unknown`. */
function transitionTargets(property: string, value: string): string[] {
  if (GLOBAL_VALUES.has(value)) {
    return [];
  }

  return splitTopLevel(value, ",").map((item) => {
    const words = splitTopLevel(item, " ");

    if (property === "transition-property") {
      return item.startsWith("var(") ? "unknown" : normaliseProperty(item);
    }

    const named = words.find((word) => !TIME.test(word) && !TIMING_WORDS.has(word.toLowerCase()) && !word.includes("("));

    if (named !== undefined) {
      return normaliseProperty(named);
    }

    return words.some((word) => word.startsWith("var(")) ? "unknown" : "implied-all";
  });
}

function animationNames(property: string, value: string): string[] {
  if (GLOBAL_VALUES.has(value)) {
    return [];
  }

  return splitTopLevel(value, ",").flatMap((item) => {
    if (property === "animation-name") {
      return item === "none" || item.startsWith("var(") ? [] : [item];
    }

    const name = splitTopLevel(item, " ").find(
      (word) => !TIME.test(word) && !NUMBER.test(word) && !ANIMATION_WORDS.has(word.toLowerCase()) && !word.includes("("),
    );

    return name === undefined || name === "none" ? [] : [name];
  });
}
