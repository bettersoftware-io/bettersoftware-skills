import { createWsPrice } from "@fx/client-core";
import { readFileSync } from "node:fs";

export const leak = [createWsPrice, readFileSync];
