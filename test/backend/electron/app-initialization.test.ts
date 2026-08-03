import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appInitializationTargets,
  clearAppInitializationData,
  type AppInitializationPaths,
} from "../../../backend/electron/main/app-initialization";

const temporaryDirectories: string[] = [];

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createInitializationFixture(removeConfigDirectory: boolean): Promise<{
  paths: AppInitializationPaths;
  userDataDirectory: string;
  chromiumCacheFile: string;
  unrelatedConfigFile: string;
}> {
  const testRoot = await mkdtemp(join(tmpdir(), "auto-pricing-initialization-"));
  temporaryDirectories.push(testRoot);
  const userDataDirectory = join(testRoot, "user-data");
  const projectDirectory = join(testRoot, "project");
  const configDirectory = removeConfigDirectory
    ? join(userDataDirectory, "config")
    : join(projectDirectory, "config");
  const paths: AppInitializationPaths = {
    defaultConfigPath: join(configDirectory, "extract_rules.json"),
    runtimeDirectory: removeConfigDirectory
      ? join(userDataDirectory, "runtime")
      : join(projectDirectory, "runtime"),
    templatesDirectory: join(userDataDirectory, "templates"),
    preferencesPath: join(userDataDirectory, "preferences.json"),
    statePath: join(userDataDirectory, "state.json"),
    legacyWindowPreferencesPath: join(userDataDirectory, "window-preferences.json"),
    removeConfigDirectory,
  };
  const chromiumCacheFile = join(userDataDirectory, "Cache", "managed-by-electron.bin");
  const unrelatedConfigFile = join(configDirectory, "keep.txt");
  await mkdir(join(userDataDirectory, "Cache"), { recursive: true });
  await mkdir(paths.templatesDirectory, { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  await mkdir(paths.runtimeDirectory, { recursive: true });
  await writeFile(chromiumCacheFile, "cache", "utf8");
  await writeFile(paths.preferencesPath, "{}", "utf8");
  await writeFile(paths.statePath, "{}", "utf8");
  await writeFile(paths.defaultConfigPath, "{}", "utf8");
  await writeFile(`${paths.defaultConfigPath}.bak`, "{}", "utf8");
  await writeFile(unrelatedConfigFile, "keep", "utf8");
  await writeFile(join(paths.runtimeDirectory, "task-history.jsonl"), "history", "utf8");
  await writeFile(join(paths.templatesDirectory, "templates.json"), "[]", "utf8");
  return { paths, userDataDirectory, chromiumCacheFile, unrelatedConfigFile };
}

describe("app initialization", () => {
  it("deletes the packaged config directory but keeps the Chromium root", async () => {
    const fixture = await createInitializationFixture(true);

    await clearAppInitializationData(fixture.paths);

    expect(await pathExists(fixture.userDataDirectory)).toBe(true);
    expect(await pathExists(fixture.chromiumCacheFile)).toBe(true);
    expect(await pathExists(fixture.paths.preferencesPath)).toBe(false);
    expect(await pathExists(fixture.paths.statePath)).toBe(false);
    expect(await pathExists(fixture.paths.templatesDirectory)).toBe(false);
    expect(await pathExists(fixture.paths.runtimeDirectory)).toBe(false);
    expect(await pathExists(fixture.paths.defaultConfigPath)).toBe(false);
    expect(await pathExists(fixture.unrelatedConfigFile)).toBe(false);
  });

  it("only deletes the generated config files during development", async () => {
    const fixture = await createInitializationFixture(false);

    await clearAppInitializationData(fixture.paths);

    expect(await pathExists(fixture.paths.defaultConfigPath)).toBe(false);
    expect(await pathExists(`${fixture.paths.defaultConfigPath}.bak`)).toBe(false);
    expect(await pathExists(fixture.unrelatedConfigFile)).toBe(true);
  });

  it("never targets the userData root", () => {
    const userDataDirectory = join("C:", "Users", "demo", "AppData", "Roaming", "auto-pricing-tool");
    const targets = appInitializationTargets({
      defaultConfigPath: join(userDataDirectory, "config", "extract_rules.json"),
      runtimeDirectory: join(userDataDirectory, "runtime"),
      templatesDirectory: join(userDataDirectory, "templates"),
      preferencesPath: join(userDataDirectory, "preferences.json"),
      statePath: join(userDataDirectory, "state.json"),
      legacyWindowPreferencesPath: join(userDataDirectory, "window-preferences.json"),
      removeConfigDirectory: true,
    });

    expect(targets).not.toContain(userDataDirectory);
    expect(targets).toContain(join(userDataDirectory, "config"));
  });
});
