import { access, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export const BATCH_OUTPUT_FOLDER_MAX_LENGTH = 100;
export const UNPROCESSED_OUTPUT_FOLDER_NAME = "未处理";
const UNPROCESSED_STAGING_FOLDER_PREFIX = ".未处理-";
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;

function fallbackBatchFolderName(batchId: string): string {
  return `批次-${batchId.slice(-8)}`;
}

export function batchOutputFolderName(batchName: string, batchId: string): string {
  const normalized = batchName
    .trim()
    .replace(WINDOWS_INVALID_CHARACTERS, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, BATCH_OUTPUT_FOLDER_MAX_LENGTH)
    .replace(/[. ]+$/g, "");
  if (!normalized || WINDOWS_RESERVED_NAME.test(normalized)) return fallbackBatchFolderName(batchId);
  return normalized;
}

function candidateDirectory(outputRoot: string, folderName: string, sequence: number): string {
  if (sequence === 1) return join(outputRoot, folderName);
  const suffix = ` (${sequence})`;
  const baseName = folderName.slice(0, Math.max(1, BATCH_OUTPUT_FOLDER_MAX_LENGTH - suffix.length)).replace(/[. ]+$/g, "");
  return join(outputRoot, `${baseName}${suffix}`);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function createBatchOutputDirectory(
  outputRoot: string,
  batchName: string,
  batchId: string,
): Promise<string> {
  const resolvedRoot = resolve(outputRoot);
  await mkdir(resolvedRoot, { recursive: true });
  const folderName = batchOutputFolderName(batchName, batchId);
  for (let sequence = 1; ; sequence += 1) {
    const candidate = candidateDirectory(resolvedRoot, folderName, sequence);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
}

export function remapBatchOutputPath(outputPath: string, previousDirectory: string, nextDirectory: string): string {
  const relativePath = relative(resolve(previousDirectory), resolve(outputPath));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return outputPath;
  return join(nextDirectory, relativePath);
}

export async function renameBatchOutputDirectory(
  outputRoot: string,
  currentDirectory: string,
  batchName: string,
  batchId: string,
): Promise<string> {
  const resolvedRoot = resolve(outputRoot);
  const resolvedCurrent = resolve(currentDirectory);
  if (dirname(resolvedCurrent).toLocaleLowerCase() !== resolvedRoot.toLocaleLowerCase()) return resolvedCurrent;
  const folderName = batchOutputFolderName(batchName, batchId);
  for (let sequence = 1; ; sequence += 1) {
    const candidate = candidateDirectory(resolvedRoot, folderName, sequence);
    if (candidate.toLocaleLowerCase() === resolvedCurrent.toLocaleLowerCase()) return resolvedCurrent;
    try {
      await rename(resolvedCurrent, candidate);
      return candidate;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
}

function uniqueArchivedFileName(fileName: string, usedNames: Set<string>): string {
  const extension = extname(fileName);
  const stem = basename(fileName, extension);
  for (let sequence = 1; ; sequence += 1) {
    const candidate = sequence === 1 ? fileName : `${stem} (${sequence})${extension}`;
    const key = candidate.toLocaleLowerCase();
    if (usedNames.has(key)) continue;
    usedNames.add(key);
    return candidate;
  }
}

export type ArchivedBatchFile = {
  sourcePath: string;
  archivedPath: string;
};

export async function archiveUnprocessedFiles(
  batchDirectory: string,
  batchId: string,
  sourcePaths: string[],
): Promise<{ directory: string; files: ArchivedBatchFile[] }> {
  const resolvedBatchDirectory = resolve(batchDirectory);
  const targetDirectory = join(resolvedBatchDirectory, UNPROCESSED_OUTPUT_FOLDER_NAME);
  const stagingDirectory = join(
    resolvedBatchDirectory,
    `${UNPROCESSED_STAGING_FOLDER_PREFIX}${batchId.slice(-8)}.tmp`,
  );
  await mkdir(resolvedBatchDirectory, { recursive: true });
  if (await pathExists(targetDirectory)) {
    throw new Error(`未处理目录已存在：${targetDirectory}`);
  }
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory);

  const usedNames = new Set<string>();
  const stagedFiles: Array<{ sourcePath: string; fileName: string }> = [];
  try {
    for (const sourcePath of sourcePaths) {
      const fileName = uniqueArchivedFileName(basename(sourcePath), usedNames);
      await copyFile(resolve(sourcePath), join(stagingDirectory, fileName));
      stagedFiles.push({ sourcePath: resolve(sourcePath), fileName });
    }
    await rename(stagingDirectory, targetDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    directory: targetDirectory,
    files: stagedFiles.map((file) => ({
      sourcePath: file.sourcePath,
      archivedPath: join(targetDirectory, file.fileName),
    })),
  };
}
