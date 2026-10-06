import { useContext } from "react";

import type { ViewModel } from "./createViewModel.ts";
import { ViewModelContext } from "./ViewModelContext.ts";

export function useViewModel(): ViewModel {
  const viewModel = useContext(ViewModelContext);

  if (viewModel === null) {
    throw new Error(
      "useViewModel needs a <ViewModelProvider> above it in the tree",
    );
  }

  return viewModel;
}
