export type WindowPreferences = {
  rememberSize: boolean;
  width?: number;
  height?: number;
};

export type WindowSize = {
  width: number;
  height: number;
};

export const DEFAULT_WINDOW_SIZE: WindowSize = { width: 1650, height: 1120 };
export const MIN_WINDOW_SIZE: WindowSize = { width: 1100, height: 700 };
const MAX_WINDOW_DIMENSION = 10_000;

function isValidDimension(value: unknown, minimum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= MAX_WINDOW_DIMENSION;
}

export function normalizeWindowPreferences(value: unknown): WindowPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { rememberSize: false };
  }
  const input = value as Record<string, unknown>;
  const preferences: WindowPreferences = { rememberSize: input.rememberSize === true };
  if (isValidDimension(input.width, MIN_WINDOW_SIZE.width)) preferences.width = input.width;
  if (isValidDimension(input.height, MIN_WINDOW_SIZE.height)) preferences.height = input.height;
  return preferences;
}

export function initialWindowSize(preferences: WindowPreferences): WindowSize {
  if (preferences.rememberSize && preferences.width !== undefined && preferences.height !== undefined) {
    return { width: preferences.width, height: preferences.height };
  }
  return DEFAULT_WINDOW_SIZE;
}

export function setRememberedWindowSize(
  preferences: WindowPreferences,
  rememberSize: boolean,
  size: WindowSize,
): WindowPreferences {
  if (!rememberSize) return { ...preferences, rememberSize: false };
  const normalized = normalizeWindowPreferences({ rememberSize: true, ...size });
  return normalized.width !== undefined && normalized.height !== undefined
    ? normalized
    : { rememberSize: true };
}
