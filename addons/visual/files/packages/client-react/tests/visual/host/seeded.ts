import type { App as Application } from "@app/client-core";

/**
 * The host's clock, as far as a scenario may move it. Nothing else moves it:
 * no timer fires on its own, so a wait passes only when the seeding says so.
 */
export interface HostClock {
  tick: (milliseconds: number) => void;
}

/** What the project's seeding (`../seeding.ts`) hands the host for one scenario. */
export interface Seeded {
  /** The application the UI is rendered on, in the state it starts in. */
  app: Application;
  /**
   * Puts the rest of the scenario's state in, through the harness. The host
   * calls it once, after the UI has subscribed, so no delivery is lost.
   */
  deliver: () => void;
}
