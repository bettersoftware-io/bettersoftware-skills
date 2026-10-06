import type { ReactElement, ReactNode } from "react";

import type { ViewModel } from "./createViewModel.ts";
import { ViewModelContext } from "./ViewModelContext.ts";

/** Hands the view model to the tree. Only the composition root and test
 * harnesses render this; components read it with `useViewModel`. */
export function ViewModelProvider({
  viewModel,
  children,
}: ViewModelProviderProps): ReactElement {
  return (
    <ViewModelContext.Provider value={viewModel}>
      {children}
    </ViewModelContext.Provider>
  );
}

interface ViewModelProviderProps {
  viewModel: ViewModel;
  children: ReactNode;
}
