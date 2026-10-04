export function highlight(element: HTMLElement): void {
  element.animate([{ boxShadow: "0 0 0 gold", transform: "none" }, { boxShadow: "0 0 12px gold, 0 0 2px white" }], 400);
}

export function shrink(element: HTMLElement): void {
  element.animate({ transform: ["scaleX(var(--from))", "scaleX(0)"] }, { duration: 1000 });
}

export function replay(element: HTMLElement, frames: Keyframe[]): void {
  element.animate(frames, 300);
}
