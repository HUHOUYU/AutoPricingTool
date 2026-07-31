import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { HeaderTemplateStore } from "../../../backend/electron/main/header-template-store";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{
  root: string;
  directory: string;
  indexPath: string;
  store: HeaderTemplateStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "auto-pricing-templates-"));
  temporaryDirectories.push(root);
  const directory = join(root, "templates");
  const indexPath = join(directory, "templates.json");
  return {
    root,
    directory,
    indexPath,
    store: new HeaderTemplateStore({
      directory,
      indexPath,
      isSupportedFile: (path) => [".xlsx", ".xlsm", ".xlsb", ".xls"].includes(extname(path).toLowerCase()),
    }),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("HeaderTemplateStore", () => {
  it("owns template copies, mapping validation and deletion", async () => {
    const { root, store } = await createStore();
    const sourcePath = join(root, "source.xlsx");
    await writeFile(sourcePath, "template");

    const created = await store.createFromFile(sourcePath, "tester");
    expect(created).toMatchObject({
      createdBy: "tester",
      fileName: "source.xlsx",
      mappings: [],
    });
    expect(await readFile(created.filePath, "utf8")).toBe("template");
    expect(await store.list()).toHaveLength(1);

    const updated = await store.updateMappings(created.id, [{
      fieldKey: " sku ",
      label: " SKU ",
      sheetName: " 订单 ",
      headerRow: 1,
      column: 2,
      header: " SKU编码 ",
    }]);
    expect(updated.mappings).toEqual([{
      fieldKey: "sku",
      label: "SKU",
      sheetName: "订单",
      headerRow: 1,
      column: 2,
      header: "SKU编码",
    }]);

    await store.delete(created.id);
    expect(await store.list()).toEqual([]);
    expect(await exists(created.filePath)).toBe(false);
  });

  it("treats damaged indexes as empty and rejects invalid input", async () => {
    const { root, directory, indexPath, store } = await createStore();
    await writeFile(join(root, "notes.txt"), "not excel");
    await expect(store.createFromFile(join(root, "notes.txt"), "tester"))
      .rejects.toThrow("请选择受支持的 Excel 模板文件");

    await writeFile(join(root, "source.xlsx"), "template");
    const created = await store.createFromFile(join(root, "source.xlsx"), "tester");
    await expect(store.updateMappings(created.id, [{ fieldKey: "" }]))
      .rejects.toThrow("模板字段映射格式无效");

    await writeFile(indexPath, "{ damaged", "utf8");
    expect(await store.list()).toEqual([]);
    expect(await exists(directory)).toBe(true);
  });

  it("never deletes a file outside the managed template directory", async () => {
    const { root, indexPath, store } = await createStore();
    const outsidePath = join(root, "outside.xlsx");
    await writeFile(outsidePath, "keep");
    await store.createFromFile(outsidePath, "tester");
    const [record] = await store.list();
    await writeFile(indexPath, JSON.stringify([
      { ...record, filePath: outsidePath },
    ]));

    await store.delete(record.id);
    expect(await exists(outsidePath)).toBe(true);
  });
});
