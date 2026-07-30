import type {
  PricePreviewWritebackRow,
  PriceUnmatchedIssue,
  TaskIssueSummary,
} from "../../../../backend/electron/preload";
import { classifyTaskIssue, TASK_ISSUE_LABELS } from "../../../../shared/task-history";

const TASK_ISSUE_SAMPLE_LIMIT = 20;

type IssueSkuTag = {
  role: "previous" | "main";
  label: string;
  value: string;
};

export type IssueDetail = {
  sourceRow?: number;
  label: string;
  message: string;
  skuTags?: IssueSkuTag[];
  emphasis?: Array<{
    label: string;
    value: string;
    tone: "danger" | "warning" | "info";
  }>;
  messageHighlights?: Array<{
    value: string;
    tone: "warning" | "info";
  }>;
};

export type IssueDetailsRequest = {
  kind: "quantity" | "unmatched";
  sourceRow: number | null;
  summary: string;
};

export function excelColumnLetter(column: number): string {
  let value = column;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label || "?";
}

export function quantityIssueMessage(error: string | null | undefined): string {
  if (!error) return "数量无法计算";
  if (error.includes("无共同组件")) return "两个 SKU 没有共同组件，无法换算数量";
  if (error.includes("组件比例冲突")) return "共同组件的倍数比例冲突，无法确定数量";
  return error;
}

export function quantityIssueDetails(
  quantityIssues: PricePreviewWritebackRow[],
): IssueDetail[] {
  return quantityIssues.map((issue) => ({
    sourceRow: issue.sourceRow,
    label: `第 ${issue.sourceRow} 行`,
    message: quantityIssueMessage(issue.quantityError),
    skuTags: issue.quantityIssueContext ? [
      {
        role: "previous" as const,
        label: `${excelColumnLetter(issue.quantityIssueContext.previousSkuColumn)} 列`,
        value: issue.quantityIssueContext.previousSku,
      },
      {
        role: "main" as const,
        label: `${excelColumnLetter(issue.quantityIssueContext.mainSkuColumn)} 列`,
        value: issue.quantityIssueContext.mainSku,
      },
    ] : undefined,
  }));
}

export function unmatchedIssueDetails(unmatchedIssues: PriceUnmatchedIssue[]): IssueDetail[] {
  return unmatchedIssues.map((issue) => {
    const reasonSeparator = issue.reason.indexOf("：");
    const reasonType = reasonSeparator >= 0 ? issue.reason.slice(0, reasonSeparator) : "价格未匹配";
    const reasonDetail = reasonSeparator >= 0 ? issue.reason.slice(reasonSeparator + 1) : issue.reason;
    const pricingSheet = /核价 Sheet (.+?) 中/u.exec(reasonDetail)?.[1]?.trim();
    return {
      sourceRow: issue.sourceRow,
      label: `第 ${issue.sourceRow} 行`,
      message: reasonDetail,
      emphasis: [
        { label: "类型", value: reasonType, tone: "danger" as const },
        { label: "国家", value: issue.country || "缺失", tone: "warning" as const },
        { label: "数量", value: String(issue.quantity), tone: "info" as const },
      ],
      messageHighlights: [
        ...(pricingSheet ? [{ value: pricingSheet, tone: "info" as const }] : []),
        ...issue.country.split("/").map((value) => value.trim()).filter(Boolean)
          .map((value) => ({ value, tone: "warning" as const })),
        ...(issue.sku ? [{ value: issue.sku, tone: "info" as const }] : []),
        { value: String(issue.quantity), tone: "info" as const },
      ],
      skuTags: issue.sku ? [{
        role: "main" as const,
        label: issue.skuColumn > 0 ? `${excelColumnLetter(issue.skuColumn)} 列` : "SKU",
        value: issue.sku,
      }] : undefined,
    };
  });
}

export function taskIssueSummaries(
  unmatchedIssues: PriceUnmatchedIssue[],
  quantityIssues: PricePreviewWritebackRow[],
): TaskIssueSummary[] {
  const summaries = new Map<TaskIssueSummary["code"], TaskIssueSummary>();
  const addIssue = (
    reason: string,
    sample: TaskIssueSummary["samples"][number],
  ): void => {
    const code = classifyTaskIssue(reason);
    const current = summaries.get(code) ?? {
      code,
      label: TASK_ISSUE_LABELS[code],
      count: 0,
      samples: [],
    };
    current.count += 1;
    if (current.samples.length < TASK_ISSUE_SAMPLE_LIMIT) current.samples.push(sample);
    summaries.set(code, current);
  };
  for (const issue of unmatchedIssues) {
    addIssue(issue.reason, {
      sourceRow: issue.sourceRow,
      country: issue.country,
      sku: issue.sku,
      quantity: issue.quantity,
      reason: issue.reason,
    });
  }
  for (const issue of quantityIssues) {
    if (!issue.quantityError) continue;
    addIssue(issue.quantityError, {
      sourceRow: issue.sourceRow,
      country: "",
      sku: issue.quantityIssueContext?.mainSku ?? "",
      quantity: issue.quantity,
      reason: issue.quantityError,
    });
  }
  return [...summaries.values()].sort((left, right) => right.count - left.count);
}
