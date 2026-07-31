import { useMemo, useState } from "react";
import { IssueDetailsDialog } from "@/components/ui/issue-details-dialog";
import { quantityIssueDetails } from "@/features/pricing/issues";
import type {
  PricePreviewWritebackRow,
  PriceUnmatchedIssue,
} from "@shared/desktop-api";

function DecisionMappingText({ value }: { value: string }): React.JSX.Element {
  const mappingPairs = value.split("、").map((pair) =>
    /^(SKU\s+[A-Z]+(?:（[^）]*）|\([^)]*\))?)\s*\/\s*(数量\s+[A-Z]+(?:（[^）]*）|\([^)]*\))?)$/
      .exec(pair.trim()));
  if (mappingPairs.every((pair) => pair !== null)) {
    return (
      <span className="decision-reason-value is-paired">
        {mappingPairs.map((pair, index) => (
          <span className="decision-mapping-pair" key={`${pair[1]}-${pair[2]}-${index}`}>
            <em className="decision-mapping-token is-sku">{pair[1]}</em>
            <em className="decision-mapping-token is-quantity">{pair[2]}</em>
          </span>
        ))}
      </span>
    );
  }
  const parts = value
    .split(/((?:SKU|数量)\s+[A-Z]+(?:（[^）]*）|\([^)]*\))?)/g)
    .filter(Boolean);
  return (
    <span className="decision-reason-value is-inline">
      {parts.map((part, index) => {
        const tone = part.startsWith("SKU ")
          ? "is-sku"
          : part.startsWith("数量 ")
            ? "is-quantity"
            : "";
        return tone
          ? <em className={`decision-mapping-token ${tone}`} key={`${part}-${index}`}>{part}</em>
          : <span key={`${part}-${index}`}>{part}</span>;
      })}
    </span>
  );
}

export function ValidationMessage({
  message,
  quantityIssues,
  unmatchedIssues,
  onOpenUnmatchedDetails,
  onUseOriginalSkuQuantity,
}: {
  message: string;
  quantityIssues: PricePreviewWritebackRow[];
  unmatchedIssues: PriceUnmatchedIssue[];
  onOpenUnmatchedDetails: (summary: string) => void;
  onUseOriginalSkuQuantity: (rows: PricePreviewWritebackRow[]) => void;
}): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const hasQuantityDetails = message.includes("数量无法计算") && quantityIssues.length > 0;
  const hasUnmatchedDetails = (
    message.includes("覆盖率")
    || message.includes("试算少于")
  ) && unmatchedIssues.length > 0;
  const hasDetails = hasQuantityDetails || hasUnmatchedDetails;
  const detailIssues = useMemo(
    () => dialogOpen && hasQuantityDetails ? quantityIssueDetails(quantityIssues) : [],
    [dialogOpen, hasQuantityDetails, quantityIssues],
  );
  return (
    <div className="issue-status-message-row">
      <span>{message}</span>
      {hasDetails ? (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={hasQuantityDetails ? dialogOpen : undefined}
          aria-label={hasQuantityDetails ? "查看数量异常详情" : "查看未匹配详情"}
          onClick={() => {
            if (hasQuantityDetails) setDialogOpen(true);
            else onOpenUnmatchedDetails(message);
          }}
        >
          详情
        </button>
      ) : null}
      <IssueDetailsDialog
        open={dialogOpen && hasQuantityDetails}
        title="数量计算问题"
        summary={message}
        issues={detailIssues}
        actionLabel="使用原始 SKU 和数量"
        onAction={() => {
          onUseOriginalSkuQuantity(quantityIssues);
          setDialogOpen(false);
        }}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}

export function DecisionReason({
  reason,
  bestScore,
  runnerUpScore,
  scoreKind,
  quantityIssues,
  unmatchedIssues,
  onOpenUnmatchedDetails,
  onUseOriginalSkuQuantity,
}: {
  reason: string;
  bestScore?: number | null;
  runnerUpScore?: number | null;
  scoreKind?: "field" | "sheet" | null;
  quantityIssues: PricePreviewWritebackRow[];
  unmatchedIssues: PriceUnmatchedIssue[];
  onOpenUnmatchedDetails: (summary: string) => void;
  onUseOriginalSkuQuantity: (rows: PricePreviewWritebackRow[]) => void;
}): React.JSX.Element {
  const comparison = /^(.*?)(?:：|:)\s*最优\s*\[(.*?)\]\s*[；;]\s*次优\s*\[(.*?)\]\s*$/
    .exec(reason);
  if (!comparison) {
    return (
      <li className="decision-reason is-plain">
        <ValidationMessage
          message={reason}
          quantityIssues={quantityIssues}
          unmatchedIssues={unmatchedIssues}
          onOpenUnmatchedDetails={onOpenUnmatchedDetails}
          onUseOriginalSkuQuantity={onUseOriginalSkuQuantity}
        />
      </li>
    );
  }
  const score = (
    value: number | null | undefined,
  ): React.JSX.Element | null => value == null
    ? null
    : <small>{scoreKind === "sheet" ? "Sheet" : "字段"} {value.toFixed(1)} 分</small>;
  return (
    <li className="decision-reason is-comparison">
      <p>{comparison[1]}</p>
      <div className="decision-candidate is-best">
        <span><b>最优</b>{score(bestScore)}</span>
        <DecisionMappingText value={comparison[2]} />
      </div>
      <div className="decision-candidate is-alternate">
        <span><b>次选</b>{score(runnerUpScore)}</span>
        <DecisionMappingText value={comparison[3]} />
      </div>
    </li>
  );
}
