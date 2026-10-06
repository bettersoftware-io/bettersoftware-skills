import FakeTimers from "@sinonjs/fake-timers";
import { createRoot } from "react-dom/client";

// biome-ignore format: this file is the add-on's, and an update compares it byte for byte. The scope in this line is the project's, and a longer one would have the formatter wrap it.
import { createViewModel, ViewModelProvider } from "@app/react-bindings";

// The app's real global stylesheet, loaded the way src/main.tsx loads it. A
// copy of its rules here would drift, and the goldens would be of a page that
// does not exist.
import "#/index.css";
import { App } from "#/ui/App.tsx";

import { type Scenario, scenarios } from "../scenarios.ts";
import { seedScenario } from "../seeding.ts";
import { ScenarioFrame } from "./ScenarioFrame.tsx";

// After the app's stylesheet, by its group: the host's two rules win a tie.
import "./host.css";

// The visual host: the real UI on the real application, with only the outside
// world replaced. It shows the one scenario named in the address
// (`/?scenario=row-stale`) and then holds still:
//
// - State comes from the project's seeding (`../seeding.ts`), by hand, through
//   the app harness. There is no simulator, no server and no network.
// - Time is a clock this page owns. It moves only when the seeding says a wait
//   has passed, so no timer ever fires on its own and a slow machine takes the
//   same picture as a fast one.
//
// This file is the add-on's, and an update replaces it. Nothing here knows
// what a scenario holds: a new field of `Scenario` is delivered in
// `../seeding.ts`, which is the project's.

/** Any fixed moment. The UI shows no date today; if it ever does, the goldens will not change by the hour. */
const NOW = new Date("2026-01-01T12:00:00Z");

const name = new URLSearchParams(window.location.search).get("scenario");
const scenario: Scenario | undefined = (scenarios as Record<string, Scenario>)[
  name ?? ""
];
const container = document.getElementById("root");

if (scenario === undefined) {
  throw new Error(
    `No scenario called "${name}". The address needs ?scenario=<name>, one of: ${Object.keys(scenarios).join(", ")}`,
  );
}

if (container === null) {
  throw new Error("the visual host's index.html has no #root element");
}

// Only the timer functions and the date are replaced. React's own scheduling
// is left alone, so rendering is not held up by the stopped clock.
const clock = FakeTimers.install({
  now: NOW,
  toFake: [
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "Date",
  ],
});

// After the clock is installed: whatever the seeding builds reads this clock.
const seeded = seedScenario(scenario, {
  tick: (milliseconds: number): void => {
    clock.tick(milliseconds);
  },
});

createRoot(container).render(
  <ViewModelProvider viewModel={createViewModel(seeded.app)}>
    <ScenarioFrame seed={seeded.deliver}>
      <App />
    </ScenarioFrame>
  </ViewModelProvider>,
);
