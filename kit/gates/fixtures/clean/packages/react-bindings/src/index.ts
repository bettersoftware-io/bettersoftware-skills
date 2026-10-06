import { createWsPrice } from "@fx/client-core";
import { useState } from "react";

export function createViewModel(): { priceSource: unknown } {
  void useState;

  return { priceSource: createWsPrice() };
}
