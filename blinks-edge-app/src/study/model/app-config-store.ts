import { fetchAppConfig } from "@/study/api/app-config-api";
import {
  clearAppConfigCache,
  loadAppConfigCache,
  storeAppConfigCache,
} from "@/study/storage/app-config-cache";
import type { CachedAppConfig } from "@/study/types/app-config";

export interface AppConfigState {
  username: string | null;
  /** Last successfully loaded app config (server or cache); null = never loaded. */
  config: CachedAppConfig | null;
  studySettingsPin: string | null;
  isRefreshing: boolean;
}

const initialState: AppConfigState = {
  username: null,
  config: null,
  studySettingsPin: null,
  isRefreshing: false,
};

// Module-level store so non-React code (foreground service)
// reads the study values synchronously. The AuthProvider drives restore,
// refresh and clear; React screens subscribe through useAppConfig().
class AppConfigStore {
  private state: AppConfigState = initialState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  getState = (): AppConfigState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(patch: Partial<AppConfigState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** Loads the cached values of this participant (offline start). */
  restore = async (username: string): Promise<void> => {
    if (this.state.username === username && this.state.config) return;
    this.generation += 1;
    const generation = this.generation;
    this.setState({ ...initialState, username });
    const cached = await loadAppConfigCache(username);
    if (generation !== this.generation) return;
    this.setState({
      config: cached.config,
      studySettingsPin: cached.studySettingsPin,
    });
  };

  /**
   * Fetches GET /api/app-config. Each success overwrites the cache; failures
   * keep the cached state.
   */
  refresh = async (): Promise<boolean> => {
    const username = this.state.username;
    if (!username || this.state.isRefreshing) return false;
    const generation = this.generation;
    this.setState({ isRefreshing: true });
    try {
      const response = await fetchAppConfig();
      if (generation !== this.generation) return false;
      const { studySettingsPin, ...config } = response;
      this.setState({ config, studySettingsPin });
      await storeAppConfigCache(username, { config, studySettingsPin }).catch(
        (error) =>
          console.warn("App config cache could not be written:", error),
      );
      return true;
    } catch (error) {
      console.warn("App config could not be loaded; using cache:", error);
      return false;
    } finally {
      if (generation === this.generation)
        this.setState({ isRefreshing: false });
    }
  };

  /** Sign-out: forget the in-memory values and delete this user's cache. */
  clear = async (): Promise<void> => {
    const username = this.state.username;
    this.generation += 1;
    this.setState(initialState);
    if (username) await clearAppConfigCache(username);
  };
}

export const appConfigStore = new AppConfigStore();
