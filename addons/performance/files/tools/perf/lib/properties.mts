// Which properties an animation may touch, and what to say about the others.
// Shared by the static check and the runtime audit, so both give the same
// verdict and the same advice for the same property.

/**
 * The properties every engine can animate on the compositor thread, without
 * running style, layout or paint on the main thread for each frame.
 */
const COMPOSITOR_ONLY = new Set(["transform", "opacity", "translate", "rotate", "scale"]);

const TRANSFORM_FAMILY = new Set(["transform", "translate", "rotate", "scale"]);

const LAYOUT = /^(width|height|min-|max-|block-size|inline-size|padding|margin|top$|right$|bottom$|left$|inset|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-width$|border-spacing|font-size|font-weight|line-height|letter-spacing|word-spacing|flex|gap$|row-gap|column-gap|grid|order$|aspect-ratio)/;

const PAINT = /^(color$|background|border|outline|box-shadow|text-shadow|text-decoration|fill|stroke|visibility$|clip-path|mask|accent-color|caret-color)/;

const FILTER = /^(filter|backdrop-filter)$/;

const GUIDE = "docs/performance.md";

/** `-webkit-transform` → `transform`; lower-cased. */
export function normaliseProperty(property: string): string {
  return property.trim().toLowerCase().replace(/^-(webkit|moz|ms|o)-/, "");
}

/** `boxShadow` → `box-shadow`, the way a Web Animations keyframe names a property. */
export function fromKeyframeKey(key: string): string {
  if (key === "cssFloat") {
    return "float";
  }

  if (key === "cssOffset") {
    return "offset";
  }

  return key.startsWith("--") ? key : normaliseProperty(key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`));
}

export function isCompositorOnly(property: string): boolean {
  return COMPOSITOR_ONLY.has(property);
}

export function isTransformFamily(property: string): boolean {
  return TRANSFORM_FAMILY.has(property);
}

/** What animating `property` costs, and what to write instead. One sentence each. */
export function describeCost(property: string): { cost: string; instead: string } {
  if (property.startsWith("--")) {
    return {
      cost: "A custom property is resolved on the main thread on every frame, along with every style that reads it.",
      instead: `Animate \`transform\` or \`opacity\` with literal values, and keep variables for the timing (${GUIDE}, "Progress bars").`,
    };
  }

  if (LAYOUT.test(property)) {
    return {
      cost: "It is a layout property: style and layout are recalculated on every frame, for the element and everything laid out around it.",
      instead: `Give the element its final size and animate \`transform\` (a scale or a translate) instead (${GUIDE}, "Progress bars").`,
    };
  }

  if (FILTER.test(property)) {
    return {
      cost: "A filter is evaluated again for every frame the page produces while its layer is on screen, whatever caused the frame.",
      instead: `Bake the effect into the layer (a wider gradient, a pre-blurred image) and animate \`opacity\` or \`transform\` (${GUIDE}, "Soft glows and blurs").`,
    };
  }

  if (PAINT.test(property)) {
    return {
      cost: "It is a paint property: style is recalculated and the element repainted on every frame.",
      instead: `Put the target look on an overlay (\`::after\`, \`inset: 0\`) and animate the overlay's \`opacity\` (${GUIDE}, "Colour, glow and fill").`,
    };
  }

  return {
    cost: "Only `transform` and `opacity` can be animated without the main thread; this runs on it every frame.",
    instead: `Rebuild the effect from \`transform\` and \`opacity\` (${GUIDE}, "Fix patterns").`,
  };
}
