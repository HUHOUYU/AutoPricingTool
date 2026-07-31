import { useEffect, useMemo, useRef, useState } from "react";
import type { DesktopAPI, PriceCheckMapping } from "@shared/desktop-api";
import type {
  ExcelPreviewCandidate,
  ExcelPreviewWorkbook,
  ExcelPreviewWorkerRequest,
  ExcelPreviewWorkerResponse,
} from "@/lib/excel-preview";

export type ExcelPreviewLoadStatus = "empty" | "loading" | "ready" | "error";

type UseExcelPreviewWorkbookOptions = {
  api: DesktopAPI | null;
  filePath: string;
  candidates: ExcelPreviewCandidate[];
  mapping?: PriceCheckMapping | null;
  loadAll: boolean;
  onWorkbookChange?: (workbook: ExcelPreviewWorkbook | null) => void;
};

type PreviewCacheEntry = {
  workbook: ExcelPreviewWorkbook;
  lastAccessedAt: number;
};

const PREVIEW_CACHE_LIMIT = 3;
const previewCache = new Map<string, PreviewCacheEntry>();
const apiCacheIds = new WeakMap<object, number>();
let nextApiCacheId = 1;

function apiCacheId(api: DesktopAPI): number {
  const existing = apiCacheIds.get(api);
  if (existing !== undefined) return existing;
  const id = nextApiCacheId;
  nextApiCacheId += 1;
  apiCacheIds.set(api, id);
  return id;
}

function previewCacheKey(
  api: DesktopAPI,
  filePath: string,
  modifiedAt: number,
  candidates: ExcelPreviewCandidate[],
  loadAll: boolean,
): string {
  const candidateKey = candidates
    .map((candidate) => `${candidate.name}:${candidate.roles.join(",")}:${candidate.scores?.order ?? ""}:${candidate.scores?.pricing ?? ""}`)
    .join("|");
  return `${apiCacheId(api)}\u0000${filePath}\u0000${modifiedAt}\u0000${loadAll ? "all" : "preview"}\u0000${candidateKey}`;
}

function cachedPreview(key: string): ExcelPreviewWorkbook | null {
  const entry = previewCache.get(key);
  if (!entry) return null;
  entry.lastAccessedAt = Date.now();
  return entry.workbook;
}

function cachePreview(key: string, workbook: ExcelPreviewWorkbook): void {
  previewCache.set(key, { workbook, lastAccessedAt: Date.now() });
  if (previewCache.size <= PREVIEW_CACHE_LIMIT) return;
  const oldestKey = [...previewCache.entries()]
    .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)[0]?.[0];
  if (oldestKey) previewCache.delete(oldestKey);
}

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
    && bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function loadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("120MB")) return "文件超过 120MB，无法在应用内预览，请打开原始文件查看";
  if (message.includes("不存在") || message.includes("无法访问")) return "Excel 文件不存在或无法访问";
  if (message.includes("加密")) return "工作簿已加密，无法在应用内预览";
  if (message.includes("损坏") || message.includes("格式不受支持")) return "工作簿损坏或格式不受支持";
  if (message.includes("Worker")) return "当前环境无法启动 Excel 预览组件";
  return "无法读取 Excel 文件，请打开原始文件查看";
}

export function useExcelPreviewWorkbook({
  api,
  filePath,
  candidates,
  mapping,
  loadAll,
  onWorkbookChange,
}: UseExcelPreviewWorkbookOptions) {
  const requestIdRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const [status, setStatus] = useState<ExcelPreviewLoadStatus>(
    candidates.length > 0 ? "loading" : "empty",
  );
  const [workbook, setWorkbook] = useState<ExcelPreviewWorkbook | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [fileSize, setFileSize] = useState<number | null>(null);

  const previewCandidates = useMemo(() => {
    if (!loadAll || !mapping) return candidates;
    const selectedSheetNames = new Set([mapping.orderSheet, mapping.pricingSheet]);
    const selectedCandidates = candidates.filter((candidate) => selectedSheetNames.has(candidate.name));
    return selectedCandidates.length > 0 ? selectedCandidates : candidates;
  }, [candidates, loadAll, mapping?.orderSheet, mapping?.pricingSheet]);

  useEffect(() => () => {
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => {
    setWorkbook(null);
    setFileSize(null);
    setErrorMessage("");
    if (candidates.length === 0) {
      setStatus("empty");
      return;
    }
    if (!api) {
      setStatus("error");
      setErrorMessage("桌面文件接口不可用");
      return;
    }

    let cancelled = false;
    const requestId = ++requestIdRef.current;
    setStatus("loading");

    void api.readExcelPreviewFile(filePath).then((source) => {
      if (cancelled) return;
      setFileSize(source.size);
      const cacheKey = previewCacheKey(api, filePath, source.modifiedAt, previewCandidates, loadAll);
      const cachedWorkbook = cachedPreview(cacheKey);
      if (cachedWorkbook) {
        setWorkbook(cachedWorkbook);
        setStatus("ready");
        return;
      }
      if (typeof Worker === "undefined") throw new Error("Worker is unavailable");
      const worker = workerRef.current
        ?? new Worker(new URL("../../../workers/excel-preview.worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<ExcelPreviewWorkerResponse>): void => {
        if (cancelled || event.data.requestId !== requestId) return;
        if (event.data.ok) {
          cachePreview(cacheKey, event.data.workbook);
          setWorkbook(event.data.workbook);
          setStatus("ready");
        } else {
          setErrorMessage(event.data.message);
          setStatus("error");
        }
      };
      worker.onerror = (): void => {
        if (cancelled) return;
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
        setErrorMessage("Excel 预览组件运行失败");
        setStatus("error");
      };
      const buffer = transferableBuffer(source.bytes);
      const request: ExcelPreviewWorkerRequest = {
        requestId,
        buffer,
        candidates: previewCandidates,
        loadAll,
      };
      worker.postMessage(request, [buffer]);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setErrorMessage(loadErrorMessage(error));
      setStatus("error");
    });

    return () => {
      cancelled = true;
    };
  }, [api, candidates.length, filePath, loadAll, previewCandidates]);

  useEffect(() => {
    onWorkbookChange?.(workbook);
  }, [onWorkbookChange, workbook]);

  return {
    status,
    workbook,
    errorMessage,
    fileSize,
    previewCandidates,
  };
}
