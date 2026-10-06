import { useState } from "react";

export function useStart(): number {
  return useState(1)[0];
}
