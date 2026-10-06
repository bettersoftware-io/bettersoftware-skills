// This package declares no "imports" in its package.json, so the alias leads
// nowhere and no path rule can see this edge.
import { missing } from "#/missing.ts";

export const aliased = [missing];
