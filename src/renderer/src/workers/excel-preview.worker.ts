import {
  excelPreviewErrorMessage,
  parseExcelPreview,
  type ExcelPreviewWorkerRequest,
  type ExcelPreviewWorkerResponse,
} from "../lib/excel-preview";

self.onmessage = (event: MessageEvent<ExcelPreviewWorkerRequest>): void => {
  const request = event.data;
  let response: ExcelPreviewWorkerResponse;
  try {
    response = {
      requestId: request.requestId,
      ok: true,
      workbook: parseExcelPreview(request.buffer, request.candidates),
    };
  } catch (error) {
    response = {
      requestId: request.requestId,
      ok: false,
      message: excelPreviewErrorMessage(error),
    };
  }
  self.postMessage(response);
};

export {};
