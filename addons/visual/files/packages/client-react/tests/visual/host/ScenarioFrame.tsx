import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { FRAME_TESTID } from "./address.ts";

interface ScenarioFrameProps {
  /** Puts the scenario's state into the application. Called once, after the UI below has subscribed. */
  seed: () => void;
  children: ReactNode;
}

/**
 * The element the picture is taken of. It seeds the scenario once its children
 * are mounted, then says it is ready. The spec waits for that signal and for
 * nothing else: no sleep, no "wait for the network".
 *
 * Seeding happens in this component's effect because a parent's effect runs
 * after its children's. By then the price list has subscribed, so a delivery
 * is not lost.
 */
export function ScenarioFrame({
  seed,
  children,
}: ScenarioFrameProps): ReactElement {
  const [ready, setReady] = useState(false);
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) {
      return;
    }

    seeded.current = true;
    seed();

    // A font that is still loading would be drawn in a fallback face.
    void document.fonts.ready.then(() => {
      setReady(true);
    });
  }, [seed]);

  return (
    <div data-testid={FRAME_TESTID} data-visual-ready={ready}>
      {children}
    </div>
  );
}
