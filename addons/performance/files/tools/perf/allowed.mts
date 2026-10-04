// The exceptions to the animation rules. This file is the project's own: it
// is written once, and an update of the add-on never touches it.
//
// An entry accepts one finding and says why. The only good reason is that live
// data cannot trigger the animation: a hover transition, a dialog that fades
// in when the user opens it. See docs/performance.md, "Exceptions".
//
// An entry with no reason stops the check. An entry that matches no finding
// is itself a finding, so remove an exception when its animation goes.

import type { Allowed } from "./lib/allowed.mts";

const allowed: Allowed = {
  // Findings of `pnpm perf:check`. Copy file, rule and property from the finding:
  //   { file: "packages/client-react/src/ui/Button.module.css", rule: ".button",
  //     property: "background-color", reason: "Hover feedback. Never on live data." },
  animations: [],

  // Findings of `pnpm perf:motion-audit`. Copy the animation's name from the report:
  //   { animation: "transition:background-color", reason: "Hover feedback. Never on live data." },
  motion: [],
};

export default allowed;
