export type WorkbookSummary = {
  sheetNames: string[];
};

export async function inspectWorkbook(buffer: ArrayBuffer): Promise<WorkbookSummary> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "array", dense: true });
  return { sheetNames: workbook.SheetNames };
}

export async function createStyledWorkbook(): Promise<import("exceljs").Workbook> {
  const { default: ExcelJS } = await import("exceljs");
  return new ExcelJS.Workbook();
}
