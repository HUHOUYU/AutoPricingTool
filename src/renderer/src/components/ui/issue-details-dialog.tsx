import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowDown, ArrowUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type IssueSkuTag = {
  role: "previous" | "main";
  label: string;
  value: string;
};

export type IssueDetail = {
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

type IssueDetailsDialogProps = {
  open: boolean;
  title: string;
  summary: string;
  issues: IssueDetail[];
  onClose: () => void;
};

function highlightedReason(
  message: string,
  highlights: IssueDetail["messageHighlights"],
): React.JSX.Element | string {
  const distinctHighlights = highlights
    ?.filter((item, index, items) => (
      item.value
      && items.findIndex((candidate) => candidate.value.toLocaleUpperCase() === item.value.toLocaleUpperCase()) === index
    ))
    .sort((left, right) => right.value.length - left.value.length);
  if (!distinctHighlights?.length) return message;
  const escapedValues = distinctHighlights.map((item) => item.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = new RegExp(`(${escapedValues.join("|")})`, "gi");
  const toneByValue = new Map(distinctHighlights.map((item) => [item.value.toLocaleUpperCase(), item.tone]));
  return (
    <>
      {message.split(matcher).map((part, index) => {
        const tone = toneByValue.get(part.toLocaleUpperCase());
        return tone
          ? <mark className={`is-${tone}`} key={`${part}-${index}`}>{part}</mark>
          : part;
      })}
    </>
  );
}

function SkuIssueValue({
  role,
  tag,
}: {
  role: "previous" | "main";
  tag?: IssueSkuTag;
}): React.JSX.Element {
  const roleLabel = role === "main" ? "主要" : "次要";
  if (!tag) {
    return (
      <span
        className={`issue-details-dialog-sku-value is-${role} is-empty`}
        aria-label={`无${roleLabel} SKU 信息`}
      >
        —
      </span>
    );
  }
  const value = tag.value || "空值";
  return (
    <span
      className={`issue-details-dialog-sku-value is-${role}`}
      aria-label={`${roleLabel} SKU ${tag.label} ${value}`}
      title={`${tag.label} · ${value}`}
    >
      <small>{tag.label}</small>
      <i aria-hidden="true">·</i>
      <strong>{value}</strong>
    </span>
  );
}

export function IssueDetailsDialog({
  open,
  title,
  summary,
  issues,
  onClose,
}: IssueDetailsDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const summaryId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  return createPortal(
    <div
      className="issue-details-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="issue-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
      >
        <header>
          <span className="issue-details-dialog-icon" aria-hidden="true"><AlertTriangle /></span>
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={summaryId}>{summary}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="issue-details-dialog-close"
            aria-label="关闭问题详情"
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        <div className="issue-details-dialog-body">
          <div className="issue-details-dialog-count">
            <strong>{issues.length} 个具体问题</strong>
            <span>请按源数据行定位并修正</span>
          </div>
          <div className="issue-details-dialog-table-frame">
            <div ref={tableScrollRef} className="issue-details-dialog-table-scroll">
              <table aria-label="数量问题明细">
                <colgroup>
                  <col className="is-source-row" />
                  <col className="is-sku" />
                  <col className="is-sku" />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">源行</th>
                    <th scope="col"><span className="is-previous" aria-label="次要 SKU">SKU</span></th>
                    <th scope="col"><span className="is-main" aria-label="主要 SKU">SKU</span></th>
                    <th scope="col">问题原因</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((issue, index) => {
                    const previousSku = issue.skuTags?.find((tag) => tag.role === "previous");
                    const mainSku = issue.skuTags?.find((tag) => tag.role === "main");
                    return (
                      <tr key={`${issue.label}-${issue.message}-${index}`}>
                        <th scope="row">{issue.label}</th>
                        <td><SkuIssueValue role="previous" tag={previousSku} /></td>
                        <td><SkuIssueValue role="main" tag={mainSku} /></td>
                        <td>
                          <div className="issue-details-dialog-reason">
                            {issue.emphasis?.length ? (
                              <div className="issue-details-dialog-reason-markers">
                                {issue.emphasis.map((item) => (
                                  <span className={`is-${item.tone}`} key={`${item.label}-${item.value}`}>
                                    <small>{item.label}</small>
                                    <strong>{item.value}</strong>
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            <span className="issue-details-dialog-reason-detail" title={issue.message}>
                              {highlightedReason(issue.message, issue.messageHighlights)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="issue-details-dialog-scroll-actions">
              <button
                type="button"
                aria-label="滚动到表头"
                title="滚动到表头"
                onClick={() => tableScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
              >
                <ArrowUp />
              </button>
              <button
                type="button"
                aria-label="滚动到表尾"
                title="滚动到表尾"
                onClick={() => {
                  const scrollContainer = tableScrollRef.current;
                  scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
                }}
              >
                <ArrowDown />
              </button>
            </div>
          </div>
        </div>
        <footer>
          <Button type="button" onClick={onClose}>知道了</Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
