// The config `pnpm lint:types` runs. This file is the project's: add a block
// after `typedLint()` to add a rule, change one or switch one off.
//
// The project's own config comes first, so this run reports everything
// `pnpm lint` does and a disable comment for one of those rules is still
// counted as used.

import base from "../../eslint.config.mts";
import { typedLint } from "./eslint.typed.base.mts";

export default [...base, ...typedLint()];
