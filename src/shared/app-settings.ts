export const APP_SETTINGS_SCHEMA_VERSION = 1;

export type AppPreferences = {
  schemaVersion: typeof APP_SETTINGS_SCHEMA_VERSION;
  archiveStandardFiles: boolean;
  autoRevealManualResult: boolean;
  continuousIssueReviewEnabled: boolean;
  rememberWindowSize: boolean;
};

export type AppState = {
  schemaVersion: typeof APP_SETTINGS_SCHEMA_VERSION;
  activeBusinessConfigPath: string;
  recentInputDirectory: string;
  recentOutputDirectory: string;
  windowWidth?: number;
  windowHeight?: number;
};

export type AppPreferencesUpdate = Partial<Omit<AppPreferences, "schemaVersion">>;
export type AppStateUpdate = Partial<Omit<AppState, "schemaVersion">>;

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
  archiveStandardFiles: false,
  autoRevealManualResult: false,
  continuousIssueReviewEnabled: false,
  rememberWindowSize: false,
};

export function defaultAppState(defaultConfigPath: string): AppState {
  return {
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    activeBusinessConfigPath: defaultConfigPath,
    recentInputDirectory: "",
    recentOutputDirectory: "",
  };
}
