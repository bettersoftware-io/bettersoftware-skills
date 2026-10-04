export function glide(element: HTMLElement, fromX: number): Animation {
  // .animate({ width: [0, 1] }) in a comment is not a call.
  return element.animate([{ transform: `translateX(${fromX}px)`, opacity: 0.6, offset: 0 }, { transform: "none", opacity: 1 }], {
    duration: 200,
    easing: "ease-out",
  });
}
