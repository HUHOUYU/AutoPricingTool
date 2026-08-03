import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const APP_INITIALIZATION_RELAUNCH_DELAY_MS = 180;
export const APP_INITIALIZATION_RELOAD_DELAY_MS = 80;

export type AppInitializationPaths = {
  defaultConfigPath: string;
  runtimeDirectory: string;
  templatesDirectory: string;
  preferencesPath: string;
  statePath: string;
  legacyWindowPreferencesPath: string;
  removeConfigDirectory: boolean;
};

export function appInitializationTargets(paths: AppInitializationPaths): string[] {
  return [
    ...(paths.removeConfigDirectory
      ? [resolve(dirname(paths.defaultConfigPath))]
      : [resolve(paths.defaultConfigPath), resolve(`${paths.defaultConfigPath}.bak`)]),
    resolve(paths.runtimeDirectory),
    resolve(paths.templatesDirectory),
    resolve(paths.preferencesPath),
    resolve(paths.statePath),
    resolve(paths.legacyWindowPreferencesPath),
  ];
}

export async function clearAppInitializationData(paths: AppInitializationPaths): Promise<void> {
  await Promise.all(appInitializationTargets(paths).map((target) => (
    rm(target, { recursive: true, force: true })
  )));
}
