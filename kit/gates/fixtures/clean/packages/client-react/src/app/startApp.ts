import { createViewModel } from "@fx/react-bindings";

export function startApp(): void {
  // The composition root is the one place allowed to read configuration.
  const source = import.meta.env.VITE_PRICE_SOURCE;
  void source;
  void createViewModel();
}
