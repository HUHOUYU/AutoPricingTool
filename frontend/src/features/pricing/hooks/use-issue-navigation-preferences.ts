import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_ISSUE_NAVIGATION_KINDS,
  normalizeIssueNavigationKinds,
  type IssueNavigationKind,
} from "@shared/app-settings";
import type { DesktopAPI } from "@shared/desktop-api";

export function useIssueNavigationPreferences(api: DesktopAPI | null): {
  selectedIssueKinds: IssueNavigationKind[];
  toggleIssueKind: (kind: IssueNavigationKind) => void;
} {
  const [selectedIssueKinds, setSelectedIssueKinds] = useState<IssueNavigationKind[]>(DEFAULT_ISSUE_NAVIGATION_KINDS);
  const selectedIssueKindsRef = useRef<IssueNavigationKind[]>(DEFAULT_ISSUE_NAVIGATION_KINDS);
  const selectionRevisionRef = useRef(0);

  useEffect(() => {
    if (!api) return undefined;
    let active = true;
    const requestedRevision = selectionRevisionRef.current;
    void api.getAppPreferences()
      .then((preferences) => {
        if (!active || selectionRevisionRef.current !== requestedRevision) return;
        const restored = normalizeIssueNavigationKinds(preferences.issueNavigationKinds);
        selectedIssueKindsRef.current = restored;
        setSelectedIssueKinds(restored);
      })
      .catch(() => toast.warning("读取异常定位筛选偏好失败，已使用默认范围"));
    return () => {
      active = false;
    };
  }, [api]);

  const toggleIssueKind = useCallback((kind: IssueNavigationKind): void => {
    const current = selectedIssueKindsRef.current;
    const next = current.includes(kind)
      ? current.filter((item) => item !== kind)
      : normalizeIssueNavigationKinds([...current, kind], []);
    selectionRevisionRef.current += 1;
    selectedIssueKindsRef.current = next;
    setSelectedIssueKinds(next);
    void api?.setAppPreferences({ issueNavigationKinds: next })
      .catch(() => toast.warning("保存异常定位筛选偏好失败，本次选择仍然有效"));
  }, [api]);

  return { selectedIssueKinds, toggleIssueKind };
}
