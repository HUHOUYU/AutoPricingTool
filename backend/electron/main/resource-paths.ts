import { join } from "node:path";

const DEFAULT_CONFIG_FILE_NAME = "extract_rules.json";

export function resolveBundledDefaultConfigPath(resourceRootDir: string, isPackaged: boolean): string {
  return isPackaged
    ? join(resourceRootDir, "defaults", DEFAULT_CONFIG_FILE_NAME)
    : join(resourceRootDir, "resources", "defaults", DEFAULT_CONFIG_FILE_NAME);
}
