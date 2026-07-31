import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";

export type BatchLayout = "empty" | "ready" | "locked" | null;

const EMPTY_PANEL_RESERVED_HEIGHT = 116;
const UPLOAD_PANEL_HEIGHT = 108;
const READY_HEADER_HEIGHT = 56;
const READY_PANEL_GAP = 8;

gsap.registerPlugin(useGSAP);

export function useBatchLayoutAnimation(batchLayout: BatchLayout) {
  const workspaceRef = useRef<HTMLElement>(null);
  const previousBatchLayoutRef = useRef<BatchLayout>(null);

  useGSAP(() => {
    const workspace = workspaceRef.current;
    const previousLayout = previousBatchLayoutRef.current;
    previousBatchLayoutRef.current = batchLayout;
    if (!workspace || !batchLayout) return;

    if (batchLayout === "locked") {
      gsap.set(workspace, { clearProps: "gridTemplateRows" });
      return;
    }

    const finalRows = batchLayout === "empty"
      ? `calc(100% - ${EMPTY_PANEL_RESERVED_HEIGHT}px) ${UPLOAD_PANEL_HEIGHT}px`
      : `${READY_HEADER_HEIGHT}px calc(100% - ${READY_HEADER_HEIGHT + READY_PANEL_GAP}px)`;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      || navigator.userAgent.includes("jsdom");
    if (!previousLayout || previousLayout === batchLayout || reducedMotion) {
      gsap.set(workspace, { clearProps: "gridTemplateRows" });
      return;
    }

    const workspaceHeight = workspace.clientHeight;
    const emptyRows = `${Math.max(
      0,
      workspaceHeight - EMPTY_PANEL_RESERVED_HEIGHT,
    )}px ${UPLOAD_PANEL_HEIGHT}px`;
    const readyRows = `${READY_HEADER_HEIGHT}px ${Math.max(
      0,
      workspaceHeight - READY_HEADER_HEIGHT - READY_PANEL_GAP,
    )}px`;
    const lockedRows = `0px ${workspaceHeight}px`;
    const timeline = gsap.timeline({
      onComplete: () => gsap.set(workspace, { clearProps: "gridTemplateRows" }),
    });

    timeline.fromTo(workspace, {
      gridTemplateRows: previousLayout === "empty"
        ? emptyRows
        : previousLayout === "ready"
          ? readyRows
          : lockedRows,
    }, {
      gridTemplateRows: finalRows,
      duration: 1,
      ease: "power3.inOut",
    }, 0);

    if (batchLayout === "ready") {
      timeline.fromTo(
        ".cyber-file-table tbody",
        { autoAlpha: 0, y: 10 },
        { autoAlpha: 1, y: 0, duration: 0.42, ease: "power2.out" },
        0.5,
      );
      timeline.fromTo(
        ".cyber-pagination",
        { autoAlpha: 0, y: 10 },
        { autoAlpha: 1, y: 0, duration: 0.4, ease: "power2.out" },
        0.58,
      );
      return;
    }
    timeline.fromTo(
      ".cyber-upload-panel",
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.5, ease: "power2.out" },
      0.08,
    );
    timeline.fromTo(
      ".cyber-dropzone",
      { autoAlpha: 0, y: -8 },
      { autoAlpha: 1, y: 0, duration: 0.52, ease: "power2.out" },
      0.18,
    );
  }, {
    scope: workspaceRef,
    dependencies: [batchLayout],
    revertOnUpdate: true,
  });

  return workspaceRef;
}
