import { fetchProfile } from "@/profile/api/profile-api";
import { fetchAppConfig } from "@/study/api/app-config-api";
import {
  clearAppConfigCache,
  loadAppConfigCache,
  storeAppConfigCache,
} from "@/study/storage/app-config-cache";
import type { CachedAppConfig } from "@/study/types/app-config";

export { desiredCaptureIntervalMs } from "@/study/utils/capture-interval";

export interface AppConfigState {
  username: string | null;
  /** Last successfully loaded app config (server or cache); null = never loaded. */
  config: CachedAppConfig | null;
  studySettingsPin: string | null;
  /** The participant's camera form factor as last seen from the server. */
  cameraFormFactor: string | null;
  isRefreshing: boolean;
}

const initialState: AppConfigState = {
  username: null,
  config: null,
  studySettingsPin: null,
  cameraFormFactor: null,
  isRefreshing: false,
};

// Module-level store so non-React code (BLE camera link, foreground service)
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
      cameraFormFactor: cached.cameraFormFactor,
    });
  };

  /**
   * Fetches GET /api/app-config and the profile's camera form factor. Each
   * success overwrites the cache; failures keep the cached state.
   */
  refresh = async (): Promise<boolean> => {
    const username = this.state.username;
    if (!username || this.state.isRefreshing) return false;
    const generation = this.generation;
    this.setState({ isRefreshing: true });
    try {
      const [response, profile] = await Promise.all([
        fetchAppConfig(),
        fetchProfile().catch(() => null),
      ]);
      if (generation !== this.generation) return false;
      const { studySettingsPin, ...config } = response;
      const cameraFormFactor = profile
        ? profile.cameraFormFactor
        : this.state.cameraFormFactor;
      this.setState({ config, studySettingsPin, cameraFormFactor });
      await storeAppConfigCache(username, {
        config,
        studySettingsPin,
        cameraFormFactor,
      }).catch((error) =>
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

  /** Study Settings changed the form factor: applies to the BLE link at once. */
  setCameraFormFactor = (cameraFormFactor: string | null): void => {
    if (cameraFormFactor === this.state.cameraFormFactor) return;
    this.setState({ cameraFormFactor });
    const { username, config, studySettingsPin } = this.state;
    if (!username) return;
    void storeAppConfigCache(username, {
      config,
      studySettingsPin,
      cameraFormFactor,
    }).catch(() => {});
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
