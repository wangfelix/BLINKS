import { useSyncExternalStore } from "react";

import {
  appConfigStore,
  type AppConfigState,
} from "@/study/model/app-config-store";

export const useAppConfig = (): AppConfigState =>
  useSyncExternalStore(appConfigStore.subscribe, appConfigStore.getState);
