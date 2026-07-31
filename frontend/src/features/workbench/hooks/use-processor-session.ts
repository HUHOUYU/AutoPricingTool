import { useEffect, useRef, useState } from "react";
import type { MappingValidationState } from "@/features/pricing/components/mapping-editor";
import type {
  PriceAnalysisFile,
  PriceCheckMapping,
  PricePreviewCellEdit,
  PricePreviewWritebackRow,
} from "@shared/desktop-api";
import type {
  FileResult,
  ManualIssueReviewContext,
  ManualIssueReviewResolution,
} from "../types";

type ValidationRequest = {
  path: string;
  mapping: PriceCheckMapping;
  version: number;
};

export function useProcessorSession() {
  const [analyses, setAnalyses] = useState<Record<string, PriceAnalysisFile>>({});
  const [mappings, setMappings] = useState<Record<string, PriceCheckMapping>>({});
  const [results, setResults] = useState<Record<string, FileResult>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [batchStarted, setBatchStarted] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [activePath, setActivePath] = useState("");
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, phase: "", path: "" });
  const [mappingValidations, setMappingValidations] = useState<Record<string, MappingValidationState>>({});
  const [matchedOrderRowsBySheet, setMatchedOrderRowsBySheet] = useState<Record<string, Record<string, number[]>>>({});
  const [writebackEdits, setWritebackEdits] = useState<Record<string, PricePreviewWritebackRow[]>>({});
  const [cellEdits, setCellEdits] = useState<Record<string, PricePreviewCellEdit[]>>({});
  const [analysisCompletedToken, setAnalysisCompletedToken] = useState(0);
  const [manualIssueReviewResolution, setManualIssueReviewResolution] =
    useState<ManualIssueReviewResolution | null>(null);

  const analysesRef = useRef<Record<string, PriceAnalysisFile>>({});
  const resultsRef = useRef<Record<string, FileResult>>({});
  const mappingsRef = useRef<Record<string, PriceCheckMapping>>({});
  const writebackEditsRef = useRef<Record<string, PricePreviewWritebackRow[]>>({});
  const cellEditsRef = useRef<Record<string, PricePreviewCellEdit[]>>({});
  const confirmedPathsRef = useRef<Set<string>>(new Set());
  const autoRunRequestedRef = useRef(false);
  const autoRunTargetPathsRef = useRef<string[]>([]);
  const manualIssueReviewRef = useRef<ManualIssueReviewContext | null>(null);
  const batchIdRef = useRef<string | null>(null);
  const mappingValidationVersionsRef = useRef<Record<string, number>>({});
  const priceRowValidationVersionsRef = useRef<Record<string, number>>({});
  const mappingValidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mappingValidationInFlightRef = useRef(false);
  const activeMappingValidationRef = useRef<ValidationRequest | null>(null);
  const pendingMappingValidationRef = useRef<ValidationRequest | null>(null);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  return {
    analyses,
    setAnalyses,
    mappings,
    setMappings,
    results,
    setResults,
    isAnalyzing,
    setIsAnalyzing,
    isRunning,
    setIsRunning,
    isPaused,
    setIsPaused,
    batchStarted,
    setBatchStarted,
    batchId,
    setBatchId,
    activePath,
    setActivePath,
    expandedPath,
    setExpandedPath,
    progress,
    setProgress,
    mappingValidations,
    setMappingValidations,
    matchedOrderRowsBySheet,
    setMatchedOrderRowsBySheet,
    writebackEdits,
    setWritebackEdits,
    cellEdits,
    setCellEdits,
    analysisCompletedToken,
    setAnalysisCompletedToken,
    manualIssueReviewResolution,
    setManualIssueReviewResolution,
    analysesRef,
    resultsRef,
    mappingsRef,
    writebackEditsRef,
    cellEditsRef,
    confirmedPathsRef,
    autoRunRequestedRef,
    autoRunTargetPathsRef,
    manualIssueReviewRef,
    batchIdRef,
    mappingValidationVersionsRef,
    priceRowValidationVersionsRef,
    mappingValidationTimerRef,
    mappingValidationInFlightRef,
    activeMappingValidationRef,
    pendingMappingValidationRef,
  };
}

export type ProcessorSession = ReturnType<typeof useProcessorSession>;
