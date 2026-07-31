import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExcelPreviewWorkbook } from "@/features/pricing/hooks/use-excel-preview-workbook";
import type {
  DesktopAPI,
  PriceCheckMapping,
} from "@shared/desktop-api";
import type {
  ExcelPreviewCandidate,
  ExcelPreviewWorkerRequest,
  ExcelPreviewWorkerResponse,
} from "@/lib/excel-preview";

class FakePreviewWorker {
  static instances: FakePreviewWorker[] = [];

  onmessage: ((event: MessageEvent<ExcelPreviewWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  request: ExcelPreviewWorkerRequest | null = null;
  terminate = vi.fn();

  constructor() {
    FakePreviewWorker.instances.push(this);
  }

  postMessage(request: ExcelPreviewWorkerRequest): void {
    this.request = request;
  }

  respond(response: ExcelPreviewWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<ExcelPreviewWorkerResponse>);
  }
}

const candidates: ExcelPreviewCandidate[] = [
  { name: "订单", roles: ["order"] },
  { name: "核价", roles: ["pricing"] },
  { name: "其他", roles: ["pricing"] },
];

const mapping = {
  orderSheet: "订单",
  pricingSheet: "核价",
} as PriceCheckMapping;

beforeEach(() => {
  FakePreviewWorker.instances = [];
  vi.stubGlobal("Worker", FakePreviewWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useExcelPreviewWorkbook", () => {
  it("loads selected sheets through one worker and publishes the workbook", async () => {
    const onWorkbookChange = vi.fn();
    const api = {
      readExcelPreviewFile: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        size: 3,
        modifiedAt: 11,
      })),
    } as unknown as DesktopAPI;
    const { result, unmount } = renderHook(() =>
      useExcelPreviewWorkbook({
        api,
        filePath: "C:\\orders\\load-all.xlsx",
        candidates: [...candidates],
        mapping,
        loadAll: true,
        onWorkbookChange,
      }),
    );

    await waitFor(() => expect(FakePreviewWorker.instances).toHaveLength(1));
    const worker = FakePreviewWorker.instances[0];
    expect(worker.request?.candidates.map((candidate) => candidate.name)).toEqual(["订单", "核价"]);
    expect(worker.request?.loadAll).toBe(true);

    const workbook = { sheets: [] };
    act(() => {
      worker.respond({
        requestId: worker.request?.requestId ?? 0,
        ok: true,
        workbook,
      });
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.fileSize).toBe(3);
    expect(result.current.workbook).toBe(workbook);
    expect(onWorkbookChange).toHaveBeenLastCalledWith(workbook);

    unmount();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("reuses a cached workbook without creating another worker", async () => {
    const api = {
      readExcelPreviewFile: vi.fn(async () => ({
        bytes: new Uint8Array([4]),
        size: 1,
        modifiedAt: 22,
      })),
    } as unknown as DesktopAPI;
    const options = {
      api,
      filePath: "C:\\orders\\cached.xlsx",
      candidates: candidates.slice(0, 1),
      loadAll: false,
    };
    const first = renderHook(() => useExcelPreviewWorkbook(options));

    await waitFor(() => expect(FakePreviewWorker.instances).toHaveLength(1));
    const worker = FakePreviewWorker.instances[0];
    act(() => {
      worker.respond({
        requestId: worker.request?.requestId ?? 0,
        ok: true,
        workbook: { sheets: [] },
      });
    });
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    first.unmount();

    const second = renderHook(() => useExcelPreviewWorkbook(options));
    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    expect(FakePreviewWorker.instances).toHaveLength(1);
    expect(api.readExcelPreviewFile).toHaveBeenCalledTimes(2);
  });

  it("maps file errors and missing desktop access to stable UI states", async () => {
    const api = {
      readExcelPreviewFile: vi.fn(async () => {
        throw new Error("Excel 文件超过 120MB");
      }),
    } as unknown as DesktopAPI;
    const failed = renderHook(() =>
      useExcelPreviewWorkbook({
        api,
        filePath: "C:\\orders\\large.xlsx",
        candidates: candidates.slice(0, 1),
        loadAll: false,
      }),
    );

    await waitFor(() => expect(failed.result.current.status).toBe("error"));
    expect(failed.result.current.errorMessage).toContain("文件超过 120MB");

    const unavailable = renderHook(() =>
      useExcelPreviewWorkbook({
        api: null,
        filePath: "C:\\orders\\missing-api.xlsx",
        candidates: candidates.slice(0, 1),
        loadAll: false,
      }),
    );
    expect(unavailable.result.current.status).toBe("error");
    expect(unavailable.result.current.errorMessage).toBe("桌面文件接口不可用");
  });
});
