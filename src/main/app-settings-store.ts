import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  APP_SETTINGS_SCHEMA_VERSION,
  DEFAULT_APP_PREFERENCES,
  defaultAppState,
  type AppPreferences,
  type AppPreferencesUpdate,
  type AppState,
  type AppStateUpdate,
} from "../shared/app-settings";

const MAX_PATH_LENGTH = 32_767;
const MAX_WINDOW_DIMENSION = 10_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PATH_LENGTH;
}

function validWindowDimension(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= MAX_WINDOW_DIMENSION;
}

export function normalizeAppPreferences(value: unknown): AppPreferences {
  const input = asRecord(value);
  return {
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    archiveStandardFiles: input.archiveStandardFiles === true,
    autoRevealManualResult: input.autoRevealManualResult === true,
    continuousIssueReviewEnabled: input.continuousIssueReviewEnabled === true,
    rememberWindowSize: input.rememberWindowSize === true,
  };
}

export function normalizeAppState(value: unknown, defaultConfigPath: string): AppState {
  const input = asRecord(value);
  const result = defaultAppState(defaultConfigPath);
  if (validPath(input.activeBusinessConfigPath) && input.activeBusinessConfigPath) {
    result.activeBusinessConfigPath = input.activeBusinessConfigPath;
  }
  if (validPath(input.recentInputDirectory)) result.recentInputDirectory = input.recentInputDirectory;
  if (validPath(input.recentOutputDirectory)) result.recentOutputDirectory = input.recentOutputDirectory;
  if (validWindowDimension(input.windowWidth)) result.windowWidth = input.windowWidth;
  if (validWindowDimension(input.windowHeight)) result.windowHeight = input.windowHeight;
  return result;
}

export function validateAppPreferencesUpdate(value: unknown): AppPreferencesUpdate {
  const input = asRecord(value);
  const result: AppPreferencesUpdate = {};
  for (const key of [
    "archiveStandardFiles",
    "autoRevealManualResult",
    "continuousIssueReviewEnabled",
    "rememberWindowSize",
  ] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw new TypeError(`应用偏好字段 ${key} 必须是布尔值`);
    result[key] = input[key];
  }
  return result;
}

export function validateAppStateUpdate(value: unknown): AppStateUpdate {
  const input = asRecord(value);
  const result: AppStateUpdate = {};
  for (const key of [
    "activeBusinessConfigPath",
    "recentInputDirectory",
    "recentOutputDirectory",
  ] as const) {
    if (input[key] === undefined) continue;
    if (!validPath(input[key])) throw new TypeError(`应用状态字段 ${key} 必须是有效路径字符串`);
    result[key] = input[key];
  }
  for (const key of ["windowWidth", "windowHeight"] as const) {
    if (input[key] === undefined) continue;
    if (!validWindowDimension(input[key])) throw new TypeError(`应用状态字段 ${key} 必须是有效整数`);
    result[key] = input[key];
  }
  return result;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export class AppSettingsStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly preferencesPath: string,
    private readonly statePath: string,
    private readonly defaultConfigPath: string,
  ) {}

  async readPreferences(): Promise<AppPreferences> {
    try {
      return normalizeAppPreferences(await readJson(this.preferencesPath));
    } catch {
      return { ...DEFAULT_APP_PREFERENCES };
    }
  }

  async readState(): Promise<AppState> {
    try {
      return normalizeAppState(await readJson(this.statePath), this.defaultConfigPath);
    } catch {
      return defaultAppState(this.defaultConfigPath);
    }
  }

  async updatePreferences(update: AppPreferencesUpdate): Promise<AppPreferences> {
    return this.enqueueUpdate(async () => {
      const next: AppPreferences = {
        ...(await this.readPreferences()),
        ...update,
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      };
      await atomicWriteJson(this.preferencesPath, next);
      return next;
    });
  }

  async updateState(update: AppStateUpdate): Promise<AppState> {
    return this.enqueueUpdate(async () => {
      const next: AppState = {
        ...(await this.readState()),
        ...update,
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      };
      await atomicWriteJson(this.statePath, next);
      return next;
    });
  }

  private enqueueUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.catch(() => undefined).then(operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
