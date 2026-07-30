import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigDocumentService } from "../../../backend/electron/main/config-document-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "auto-pricing-config-"));
  temporaryDirectories.push(root);
  const bundledPath = join(root, "bundled.json");
  const defaultPath = join(root, "config", "extract_rules.json");
  await writeFile(bundledPath, "{}\n", "utf8");
  let activePath: string | undefined;
  const setActiveConfigPath = vi.fn(async (path: string) => {
    activePath = path;
  });
  const service = createConfigDocumentService({
    bundledDefaultConfigPath: bundledPath,
    defaultConfigPath: defaultPath,
    getActiveConfigPath: () => activePath,
    maxProcessingWorkers: 7,
    selectSavePath: async () => null,
    setActiveConfigPath,
  });
  return { defaultPath, service, setActiveConfigPath };
}

describe("createConfigDocumentService", () => {
  it("copies and reads the bundled default configuration", async () => {
    const { defaultPath, service } = await createFixture();

    const document = await service.readDocument();

    expect(document).toMatchObject({
      path: defaultPath,
      content: "{}\n",
      isDefault: true,
    });
  });

  it("validates, backs up, and atomically saves a configuration", async () => {
    const { defaultPath, service, setActiveConfigPath } = await createFixture();
    const initial = await service.readDocument();
    const currentStat = await stat(defaultPath);

    const saved = await service.saveDocument({
      path: defaultPath,
      content: JSON.stringify({ automation: { auto_run: true } }),
      expectedModifiedAt: currentStat.mtimeMs,
    });

    expect(saved.content).toContain('"auto_run": true');
    expect(await readFile(`${defaultPath}.bak`, "utf8")).toBe(initial.content);
    expect(setActiveConfigPath).toHaveBeenCalledWith(defaultPath);
  });
});
