import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppSettingsStore,
  normalizeAppPreferences,
  normalizeAppState,
  validateAppPreferencesUpdate,
  validateAppStateUpdate,
} from "../../../backend/electron/main/app-settings-store";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{
  directory: string;
  preferencesPath: string;
  statePath: string;
  store: AppSettingsStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "auto-pricing-settings-"));
  temporaryDirectories.push(directory);
  const preferencesPath = join(directory, "preferences.json");
  const statePath = join(directory, "state.json");
  return {
    directory,
    preferencesPath,
    statePath,
    store: new AppSettingsStore(preferencesPath, statePath, "C:\\defaults\\extract_rules.json"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AppSettingsStore", () => {
  it("keeps preferences and state in independent files", async () => {
    const { preferencesPath, statePath, store } = await createStore();

    await store.updatePreferences({ continuousIssueReviewEnabled: true });
    await store.updateState({
      activeBusinessConfigPath: "C:\\rules\\business.json",
      recentOutputDirectory: "C:\\output",
    });

    expect(JSON.parse(await readFile(preferencesPath, "utf8"))).toMatchObject({
      continuousIssueReviewEnabled: true,
      autoRevealManualResult: false,
      overwriteSourceFiles: false,
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      activeBusinessConfigPath: "C:\\rules\\business.json",
      recentOutputDirectory: "C:\\output",
    });
    expect(await readFile(preferencesPath, "utf8")).not.toContain("activeBusinessConfigPath");
    expect(await readFile(statePath, "utf8")).not.toContain("continuousIssueReviewEnabled");
  });

  it("does not interpret legacy snake-case runtime fields", () => {
    expect(normalizeAppPreferences({ continuous_issue_review_enabled: true }))
      .toMatchObject({ continuousIssueReviewEnabled: false, overwriteSourceFiles: false });
    expect(normalizeAppState(
      { recent_output_dir: "C:\\legacy" },
      "C:\\defaults\\extract_rules.json",
    )).toMatchObject({
      activeBusinessConfigPath: "C:\\defaults\\extract_rules.json",
      recentOutputDirectory: "",
    });
  });

  it("serializes concurrent updates without dropping fields", async () => {
    const { store } = await createStore();

    await Promise.all([
      store.updateState({ recentInputDirectory: "C:\\input" }),
      store.updateState({ recentOutputDirectory: "C:\\output" }),
    ]);

    expect(await store.readState()).toMatchObject({
      recentInputDirectory: "C:\\input",
      recentOutputDirectory: "C:\\output",
    });
  });

  it("rejects invalid preference and state updates", () => {
    expect(() => validateAppPreferencesUpdate({ continuousIssueReviewEnabled: "yes" }))
      .toThrow("必须是布尔值");
    expect(() => validateAppPreferencesUpdate({ overwriteSourceFiles: "yes" }))
      .toThrow("必须是布尔值");
    expect(() => validateAppStateUpdate({ recentOutputDirectory: 42 }))
      .toThrow("必须是有效路径字符串");
  });
});
