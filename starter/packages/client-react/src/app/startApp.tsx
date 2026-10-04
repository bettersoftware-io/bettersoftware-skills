import { createApp } from "@app/client-core";
import { createViewModel, ViewModelProvider } from "@app/react-bindings";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../ui/App.tsx";
import { buildPorts } from "./buildPorts.ts";

/**
 * The composition root. It reads the configuration, picks the adapters, builds
 * the application and the view model once, and hands the view model to the UI.
 * Nothing else in the client does any of those things.
 */
export function startApp(): void {
  const container = document.getElementById("root");

  if (container === null) {
    throw new Error("index.html has no #root element");
  }

  const viewModel = createViewModel(createApp(buildPorts(import.meta.env.VITE_SERVER_URL)));

  createRoot(container).render(
    <StrictMode>
      <ViewModelProvider viewModel={viewModel}>
        <App />
      </ViewModelProvider>
    </StrictMode>,
  );
}
