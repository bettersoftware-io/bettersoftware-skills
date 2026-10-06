import { useState } from "react";

export function useThing(): number {
  return useState(1)[0];
}
