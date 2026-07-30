import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseConfigContent, validateConfigContent } from "./config-validation";
import { samePath } from "./path-utils";

export type ConfigDocument = {
  path: string;
  content: string;
  modifiedAt: number;
  isDefault: boolean;
};

type ConfigDocumentServiceOptions = {
  bundledDefaultConfigPath: string;
  defaultConfigPath: string;
  getActiveConfigPath: () => string | undefined;
  maxProcessingWorkers: number;
  selectSavePath: (defaultPath: string) => Promise<string | null>;
  setActiveConfigPath: (path: string) => Promise<void>;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createConfigDocumentService(options: ConfigDocumentServiceOptions) {
  const validate = (content: string) =>
    validateConfigContent(content, options.maxProcessingWorkers);

  async function ensureWritableConfig(): Promise<void> {
    await mkdir(dirname(options.defaultConfigPath), { recursive: true });
    if (!(await pathExists(options.defaultConfigPath))) {
      await copyFile(options.bundledDefaultConfigPath, options.defaultConfigPath);
    }
  }

  async function resolveActiveConfigPath(candidatePath?: string): Promise<string> {
    await ensureWritableConfig();
    if (candidatePath && (await pathExists(candidatePath))) return candidatePath;
    const activePath = options.getActiveConfigPath();
    if (activePath && (await pathExists(activePath))) return activePath;
    return options.defaultConfigPath;
  }

  async function readDocument(candidatePath?: string): Promise<ConfigDocument> {
    const configPath = await resolveActiveConfigPath(candidatePath);
    const [content, fileStat] = await Promise.all([
      readFile(configPath, "utf8"),
      stat(configPath),
    ]);
    return {
      path: configPath,
      content,
      modifiedAt: fileStat.mtimeMs,
      isDefault: samePath(configPath, options.defaultConfigPath),
    };
  }

  async function atomicWrite(configPath: string, content: string): Promise<ConfigDocument> {
    const validation = validate(content);
    if (!validation.valid) {
      throw new Error(`配置校验失败：${validation.issues[0]?.path} ${validation.issues[0]?.message}`);
    }
    const normalizedContent = `${JSON.stringify(parseConfigContent(content), null, 2)}\n`;
    await mkdir(dirname(configPath), { recursive: true });
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    if (await pathExists(configPath)) await copyFile(configPath, `${configPath}.bak`);
    await writeFile(temporaryPath, normalizedContent, "utf8");
    await rename(temporaryPath, configPath);
    return readDocument(configPath);
  }

  async function saveDocument(payload: unknown): Promise<ConfigDocument> {
    const input = requireRecord(payload, "配置保存参数");
    if (typeof input.path !== "string" || !isAbsolute(input.path) || typeof input.content !== "string") {
      throw new TypeError("配置保存参数无效");
    }
    if (typeof input.expectedModifiedAt === "number" && (await pathExists(input.path))) {
      const currentStat = await stat(input.path);
      if (Math.abs(currentStat.mtimeMs - input.expectedModifiedAt) > 1) {
        throw new Error("配置文件已被外部修改，请重新加载后再保存");
      }
    }
    const document = await atomicWrite(resolve(input.path), input.content);
    await options.setActiveConfigPath(document.path);
    return readDocument(document.path);
  }

  async function saveDocumentAs(content: string): Promise<ConfigDocument | null> {
    const validation = validate(content);
    if (!validation.valid) {
      throw new Error(`配置校验失败：${validation.issues[0]?.path} ${validation.issues[0]?.message}`);
    }
    const selectedPath = await options.selectSavePath(
      options.getActiveConfigPath() || options.defaultConfigPath,
    );
    if (!selectedPath) return null;
    const document = await atomicWrite(resolve(selectedPath), content);
    await options.setActiveConfigPath(document.path);
    return readDocument(document.path);
  }

  async function restoreDefault(): Promise<ConfigDocument> {
    const current = await readDocument();
    const bundledContent = await readFile(options.bundledDefaultConfigPath, "utf8");
    return atomicWrite(current.path, bundledContent);
  }

  return {
    ensureWritableConfig,
    readDocument,
    resolveActiveConfigPath,
    restoreDefault,
    saveDocument,
    saveDocumentAs,
    validate,
  };
}
