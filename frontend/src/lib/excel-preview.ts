import * as XLSX from "xlsx";

export const EXCEL_PREVIEW_MAX_ROWS = 500;
export const EXCEL_PREVIEW_MAX_COLUMNS = 80;

export type ExcelPreviewSheetRole = "order" | "pricing";

export type ExcelPreviewCandidate = {
  name: string;
  roles: ExcelPreviewSheetRole[];
  scores?: Partial<Record<ExcelPreviewSheetRole, number>>;
};

export type ExcelPreviewSheet = {
  name: string;
  roles: ExcelPreviewSheetRole[];
  rows: string[][];
  startRow: number;
  startColumn: number;
  rowCount: number;
  columnCount: number;
  displayedRowCount: number;
  displayedColumnCount: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
};

export type ExcelPreviewWorkbook = {
  sheets: ExcelPreviewSheet[];
};

export type ExcelPreviewSearchMatch = {
  rowIndex: number;
  columnIndex: number;
};

export type ExcelPreviewWorkerRequest = {
  requestId: number;
  buffer: ArrayBuffer;
  candidates: ExcelPreviewCandidate[];
  loadAll?: boolean;
};

export type ExcelPreviewWorkerResponse =
  | { requestId: number; ok: true; workbook: ExcelPreviewWorkbook }
  | { requestId: number; ok: false; message: string };

function normalizeCandidates(candidates: ExcelPreviewCandidate[]): ExcelPreviewCandidate[] {
  const merged = new Map<string, { roles: Set<ExcelPreviewSheetRole>; scores: Partial<Record<ExcelPreviewSheetRole, number>> }>();
  for (const candidate of candidates) {
    const name = candidate.name.trim();
    if (!name) continue;
    const entry = merged.get(name) ?? { roles: new Set<ExcelPreviewSheetRole>(), scores: {} };
    candidate.roles.forEach((role) => entry.roles.add(role));
    Object.assign(entry.scores, candidate.scores);
    merged.set(name, entry);
  }
  return Array.from(merged, ([name, entry]) => ({ name, roles: Array.from(entry.roles), scores: entry.scores }));
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

export function findExcelPreviewMatches(rows: string[][], query: string): ExcelPreviewSearchMatch[] {
  const termGroups = query
    .split(/[,，]/)
    .map((group) => Array.from(new Set(group
      .split("|")
      .map((term) => term.trim().toLocaleLowerCase())
      .filter(Boolean))))
    .filter((group) => group.length > 0);
  if (termGroups.length === 0) return [];
  const matches: ExcelPreviewSearchMatch[] = [];
  rows.forEach((row, rowIndex) => {
    const normalizedCells = row.map((cell) => cell.toLocaleLowerCase());
    if (!termGroups.every((group) => group.some((term) => normalizedCells.some((cell) => cell === term)))) return;
    const columnIndex = normalizedCells.findIndex((cell) => termGroups[0].some((term) => cell === term));
    matches.push({ rowIndex, columnIndex: Math.max(0, columnIndex) });
  });
  return matches;
}

function parseRange(reference: string | undefined): XLSX.Range | null {
  if (!reference) return null;
  try {
    return XLSX.utils.decode_range(reference);
  } catch {
    return null;
  }
}

function parseSheet(
  worksheet: XLSX.WorkSheet,
  candidate: ExcelPreviewCandidate,
  maxRows: number,
  maxColumns: number,
): ExcelPreviewSheet {
  const parsedRange = parseRange(worksheet["!ref"]);
  const fullRange = parseRange(typeof worksheet["!fullref"] === "string" ? worksheet["!fullref"] : worksheet["!ref"]);

  if (!parsedRange || !fullRange) {
    return {
      name: candidate.name,
      roles: candidate.roles,
      rows: [],
      startRow: 0,
      startColumn: 0,
      rowCount: 0,
      columnCount: 0,
      displayedRowCount: 0,
      displayedColumnCount: 0,
      truncatedRows: false,
      truncatedColumns: false,
    };
  }

  const rowCount = Math.max(0, fullRange.e.r - fullRange.s.r + 1);
  const columnCount = Math.max(0, fullRange.e.c - fullRange.s.c + 1);
  const displayRange: XLSX.Range = {
    s: { ...parsedRange.s },
    e: {
      r: maxRows > 0 ? Math.min(parsedRange.e.r, parsedRange.s.r + maxRows - 1) : parsedRange.e.r,
      c: maxColumns > 0 ? Math.min(parsedRange.e.c, parsedRange.s.c + maxColumns - 1) : parsedRange.e.c,
    },
  };
  const displayedRowCount = Math.max(0, displayRange.e.r - displayRange.s.r + 1);
  const displayedColumnCount = Math.max(0, displayRange.e.c - displayRange.s.c + 1);
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    range: displayRange,
    raw: false,
    defval: "",
    blankrows: true,
  });
  const rows = Array.from({ length: displayedRowCount }, (_, rowIndex) => {
    const rawRow = rawRows[rowIndex] ?? [];
    return Array.from({ length: displayedColumnCount }, (_, columnIndex) => stringValue(rawRow[columnIndex]));
  });

  return {
    name: candidate.name,
    roles: candidate.roles,
    rows,
    startRow: displayRange.s.r,
    startColumn: displayRange.s.c,
    rowCount,
    columnCount,
    displayedRowCount,
    displayedColumnCount,
    truncatedRows: rowCount > displayedRowCount,
    truncatedColumns: columnCount > displayedColumnCount,
  };
}

export function parseExcelPreview(
  buffer: ArrayBuffer,
  candidates: ExcelPreviewCandidate[],
  maxRows = EXCEL_PREVIEW_MAX_ROWS,
  maxColumns = EXCEL_PREVIEW_MAX_COLUMNS,
): ExcelPreviewWorkbook {
  const normalizedCandidates = normalizeCandidates(candidates);
  if (normalizedCandidates.length === 0) return { sheets: [] };

  const workbook = XLSX.read(buffer, {
    type: "array",
    dense: true,
    sheets: normalizedCandidates.map((candidate) => candidate.name),
    sheetRows: maxRows > 0 ? maxRows : 0,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellText: true,
  });
  const sheets = normalizedCandidates.flatMap((candidate) => {
    const worksheet = workbook.Sheets[candidate.name];
    return worksheet ? [parseSheet(worksheet, candidate, maxRows, maxColumns)] : [];
  });
  return { sheets };
}

export function excelPreviewErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/password|encrypt/i.test(message)) return "工作簿已加密，无法在应用内预览";
  if (/zip|corrupt|unsupported|invalid/i.test(message)) return "工作簿损坏或格式不受支持";
  return "无法解析 Excel 工作簿";
}
