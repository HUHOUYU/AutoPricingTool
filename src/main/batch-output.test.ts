import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  batchOutputFolderName,
  archiveUnprocessedFiles,
  createBatchOutputDirectory,
  remapBatchOutputPath,
  renameBatchOutputDirectory,
} from "./batch-output";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "auto-pricing-batch-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("batch output directory", () => {
  it("uses a filesystem-safe batch name", () => {
    expect(batchOutputFolderName("  法国/补发:7月.  ", "batch-12345678")).toBe("法国_补发_7月");
    expect(batchOutputFolderName("CON", "batch-12345678")).toBe("批次-12345678");
  });

  it("creates a unique directory for duplicate batch names", async () => {
    const root = await temporaryDirectory();
    expect(await createBatchOutputDirectory(root, "法国补发", "batch-1")).toBe(join(root, "法国补发"));
    expect(await createBatchOutputDirectory(root, "法国补发", "batch-2")).toBe(join(root, "法国补发 (2)"));
  });

  it("renames the batch directory and remaps result files", async () => {
    const root = await temporaryDirectory();
    const current = join(root, "旧批次");
    await mkdir(current);
    await writeFile(join(current, "订单_核价结果.xlsx"), "result");

    const renamed = await renameBatchOutputDirectory(root, current, "新批次", "batch-1");
    expect(renamed).toBe(join(root, "新批次"));
    expect(remapBatchOutputPath(join(current, "订单_核价结果.xlsx"), current, renamed))
      .toBe(join(renamed, "订单_核价结果.xlsx"));
  });

  it("copies unresolved files without changing the sources", async () => {
    const root = await temporaryDirectory();
    const batchDirectory = join(root, "法国补发");
    const firstSourceDirectory = join(root, "source-a");
    const secondSourceDirectory = join(root, "source-b");
    await Promise.all([
      mkdir(batchDirectory),
      mkdir(firstSourceDirectory),
      mkdir(secondSourceDirectory),
    ]);
    const firstSource = join(firstSourceDirectory, "订单.xlsx");
    const secondSource = join(secondSourceDirectory, "订单.xlsx");
    await writeFile(firstSource, "first");
    await writeFile(secondSource, "second");

    const archived = await archiveUnprocessedFiles(
      batchDirectory,
      "batch-12345678",
      [firstSource, secondSource],
    );

    expect(archived.directory).toBe(join(batchDirectory, "未处理"));
    expect(archived.files.map((file) => file.archivedPath)).toEqual([
      join(batchDirectory, "未处理", "订单.xlsx"),
      join(batchDirectory, "未处理", "订单 (2).xlsx"),
    ]);
    expect(await readFile(firstSource, "utf8")).toBe("first");
    expect(await readFile(secondSource, "utf8")).toBe("second");
    expect(await readFile(archived.files[0]!.archivedPath, "utf8")).toBe("first");
    expect(await readFile(archived.files[1]!.archivedPath, "utf8")).toBe("second");
  });
});
