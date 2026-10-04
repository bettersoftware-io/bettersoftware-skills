import { createContext } from "react";

import type { ViewModel } from "./createViewModel.ts";

export const ViewModelContext = createContext<ViewModel | null>(null);
