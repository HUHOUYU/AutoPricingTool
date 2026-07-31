import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { samePath } from "./path-utils";

export type HeaderTemplateFieldMapping = {
  fieldKey: string;
  label: string;
  sheetName: string;
  headerRow: number;
  column: number;
  header: string;
};

export type HeaderTemplateRecord = {
  id: string;
  createdAt: string;
  createdBy: string;
  fileName: string;
  filePath: string;
  mappings: HeaderTemplateFieldMapping[];
};

type HeaderTemplateStoreOptions = {
  directory: string;
  indexPath: string;
  isSupportedFile: (path: string) => boolean;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function parseMappings(value: unknown): HeaderTemplateFieldMapping[] {
  if (!Array.isArray(value)) throw new TypeError("模板字段映射必须是数组");
  return value.map((item) => {
    const mapping = requireRecord(item, "模板字段映射");
    if (typeof mapping.fieldKey !== "string" || !mapping.fieldKey.trim()
      || typeof mapping.label !== "string" || !mapping.label.trim()
      || typeof mapping.sheetName !== "string" || !mapping.sheetName.trim()
      || !Number.isInteger(mapping.headerRow) || Number(mapping.headerRow) < 1
      || !Number.isInteger(mapping.column) || Number(mapping.column) < 1
      || typeof mapping.header !== "string") {
      throw new TypeError("模板字段映射格式无效");
    }
    return {
      fieldKey: mapping.fieldKey.trim(),
      label: mapping.label.trim(),
      sheetName: mapping.sheetName.trim(),
      headerRow: Number(mapping.headerRow),
      column: Number(mapping.column),
      header: mapping.header.trim(),
    };
  });
}

function isHeaderTemplateRecord(value: unknown): value is HeaderTemplateRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<HeaderTemplateRecord>;
  return typeof record.id === "string"
    && typeof record.createdAt === "string"
    && typeof record.createdBy === "string"
    && typeof record.fileName === "string"
    && typeof record.filePath === "string"
    && Array.isArray(record.mappings);
}

export class HeaderTemplateStore {
  private readonly directory: string;
  private readonly indexPath: string;
  private readonly isSupportedFile: (path: string) => boolean;

  constructor({
    directory,
    indexPath,
    isSupportedFile,
  }: HeaderTemplateStoreOptions) {
    this.directory = directory;
    this.indexPath = indexPath;
    this.isSupportedFile = isSupportedFile;
  }

  async list(): Promise<HeaderTemplateRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isHeaderTemplateRecord) : [];
    } catch {
      return [];
    }
  }

  async createFromFile(sourcePath: string, createdBy: string): Promise<HeaderTemplateRecord> {
    if (!this.isSupportedFile(sourcePath)) {
      throw new TypeError("请选择受支持的 Excel 模板文件");
    }
    await mkdir(this.directory, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const storedPath = join(this.directory, `${id}${extname(sourcePath).toLowerCase()}`);
    await copyFile(sourcePath, storedPath);
    const record: HeaderTemplateRecord = {
      id,
      createdAt: new Date().toISOString(),
      createdBy: createdBy || "当前用户",
      fileName: basename(sourcePath),
      filePath: storedPath,
      mappings: [],
    };
    const records = await this.list();
    records.unshift(record);
    await this.write(records);
    return record;
  }

  async updateMappings(id: unknown, value: unknown): Promise<HeaderTemplateRecord> {
    if (typeof id !== "string" || !id.trim()) throw new TypeError("缺少模板 ID");
    const mappings = parseMappings(value);
    const records = await this.list();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) throw new Error("模板不存在或已被删除");
    records[index] = { ...records[index], mappings };
    await this.write(records);
    return records[index];
  }

  async delete(id: unknown): Promise<void> {
    if (typeof id !== "string" || !id.trim()) throw new TypeError("缺少模板 ID");
    const records = await this.list();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return;
    const [record] = records.splice(index, 1);
    await this.write(records);
    if (samePath(dirname(record.filePath), this.directory)) {
      await rm(record.filePath, { force: true });
    }
  }

  private async write(records: HeaderTemplateRecord[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.indexPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }
}
