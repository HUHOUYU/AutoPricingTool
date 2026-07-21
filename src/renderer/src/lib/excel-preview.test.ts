import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { excelPreviewErrorMessage, findExcelPreviewMatches, parseExcelPreview } from "./excel-preview";

function createWorkbookBuffer(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const orderSheet = XLSX.utils.aoa_to_sheet([
    ["订单号", "金额", "备注", "国家"],
    ["A001", 1234.5, undefined, "US"],
    ["A002", 8, "加急", "DE"],
    ["A003", 16, "", "JP"],
  ]);
  orderSheet.B2.z = "#,##0.00";
  XLSX.utils.book_append_sheet(workbook, orderSheet, "订单");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["SKU", "1"], ["P-1", 12.5]]), "核价");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["不应加载"]]), "说明");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("parseExcelPreview", () => {
  it("filters and merges candidate sheets while preserving formatted and empty cells", () => {
    const preview = parseExcelPreview(createWorkbookBuffer(), [
      { name: "订单", roles: ["order"] },
      { name: "订单", roles: ["pricing"] },
      { name: "核价", roles: ["pricing"] },
    ]);

    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(["订单", "核价"]);
    expect(preview.sheets[0].roles).toEqual(["order", "pricing"]);
    expect(preview.sheets[0].rows[1]).toEqual(["A001", "1,234.50", "", "US"]);
    expect(preview.sheets.some((sheet) => sheet.name === "说明")).toBe(false);
  });

  it("reports original dimensions when row and column previews are truncated", () => {
    const preview = parseExcelPreview(createWorkbookBuffer(), [{ name: "订单", roles: ["order"] }], 2, 2);
    const sheet = preview.sheets[0];

    expect(sheet.rowCount).toBe(4);
    expect(sheet.columnCount).toBe(4);
    expect(sheet.displayedRowCount).toBe(2);
    expect(sheet.displayedColumnCount).toBe(2);
    expect(sheet.truncatedRows).toBe(true);
    expect(sheet.truncatedColumns).toBe(true);
  });

  it("loads every row and column when both limits are disabled", () => {
    const limitedSheet = parseExcelPreview(createWorkbookBuffer(), [{ name: "订单", roles: ["order"] }], 2, 2).sheets[0];
    const sheet = parseExcelPreview(createWorkbookBuffer(), [{ name: "订单", roles: ["order"] }], 0, 0).sheets[0];

    expect(sheet.displayedRowCount).toBeGreaterThan(limitedSheet.displayedRowCount);
    expect(sheet.displayedColumnCount).toBeGreaterThan(limitedSheet.displayedColumnCount);
    expect(sheet.displayedRowCount).toBe(sheet.rowCount);
    expect(sheet.displayedColumnCount).toBe(sheet.columnCount);
    expect(sheet.truncatedRows).toBe(false);
    expect(sheet.truncatedColumns).toBe(false);
  });

  it("maps encrypted and corrupt workbook errors to safe messages", () => {
    expect(excelPreviewErrorMessage(new Error("Unsupported ZIP Encryption"))).toContain("加密");
    expect(excelPreviewErrorMessage(new Error("Invalid ZIP data"))).toContain("损坏");
    expect(() => parseExcelPreview(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).buffer, [{ name: "订单", roles: ["order"] }])).toThrow();
  });
});

describe("findExcelPreviewMatches", () => {
  it("finds partial matches without case sensitivity in row order", () => {
    expect(findExcelPreviewMatches([
      ["SKU", "Country"],
      ["FL2600293-1", "ES"],
      ["fl2600293-2", "FR"],
    ], " FL2600293 ")).toEqual([
      { rowIndex: 1, columnIndex: 0 },
      { rowIndex: 2, columnIndex: 0 },
    ]);
  });

  it("returns no matches for an empty query", () => {
    expect(findExcelPreviewMatches([["SKU"]], "   ")).toEqual([]);
  });
});
