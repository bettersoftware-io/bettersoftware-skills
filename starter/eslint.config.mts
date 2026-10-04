import { architectureLint } from "./tools/arch/eslint.config.mts";

export default [{ ignores: ["tools/**"] }, ...architectureLint()];
