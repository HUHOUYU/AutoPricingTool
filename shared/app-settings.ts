export const APP_SETTINGS_SCHEMA_VERSION = 1;

export const ISSUE_NAVIGATION_KINDS = ["unmatched", "difference", "quantity"] as const;
export type IssueNavigationKind = typeof ISSUE_NAVIGATION_KINDS[number];
export const DEFAULT_ISSUE_NAVIGATION_KINDS: IssueNavigationKind[] = ["unmatched"];

export type AppPreferences = {
  schemaVersion: typeof APP_SETTINGS_SCHEMA_VERSION;
  archiveStandardFiles: boolean;
  autoRevealManualResult: boolean;
  continuousIssueReviewEnabled: boolean;
  issueNavigationKinds: IssueNavigationKind[];
  overwriteSourceFiles: boolean;
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
  issueNavigationKinds: [...DEFAULT_ISSUE_NAVIGATION_KINDS],
  overwriteSourceFiles: false,
  rememberWindowSize: false,
};

export function normalizeIssueNavigationKinds(
  value: unknown,
  fallback: readonly IssueNavigationKind[] = DEFAULT_ISSUE_NAVIGATION_KINDS,
): IssueNavigationKind[] {
  if (!Array.isArray(value)) return [...fallback];
  const selected = new Set(value.filter((item): item is IssueNavigationKind => (
    typeof item === "string"
    && ISSUE_NAVIGATION_KINDS.includes(item as IssueNavigationKind)
  )));
  return ISSUE_NAVIGATION_KINDS.filter((kind) => selected.has(kind));
}

export function defaultAppState(defaultConfigPath: string): AppState {
  return {
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    activeBusinessConfigPath: defaultConfigPath,
    recentInputDirectory: "",
    recentOutputDirectory: "",
  };
}
