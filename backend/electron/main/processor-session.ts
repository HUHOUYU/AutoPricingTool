import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type ProcessorActivity =
  | "scan"
  | "start"
  | "merge"
  | "price-analyze"
  | "price-validate"
  | "price-run";

export type ProcessorCommand = Record<string, unknown> & {
  action: string;
};

type ProcessorSessionOptions = {
  broadcastEvent: (event: unknown) => void;
  cwd: string;
  getExecutablePath: () => string;
  onRunStopped: () => void;
  onStructuredEvent: (event: unknown) => void;
  spawnProcessor?: typeof spawn;
};

export function createProcessorSession(options: ProcessorSessionOptions) {
  let processor: ChildProcessWithoutNullStreams | null = null;
  let activity: ProcessorActivity | null = null;

  function clearProcessor(child: ChildProcessWithoutNullStreams): void {
    if (processor !== child) return;
    processor = null;
    activity = null;
  }

  function ensureProcessor(): ChildProcessWithoutNullStreams {
    if (processor && !processor.killed) return processor;
    const spawnProcessor = options.spawnProcessor ?? spawn;
    const child = spawnProcessor(options.getExecutablePath(), [], {
      cwd: options.cwd,
      env: { ...process.env },
    });
    processor = child;

    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const event = JSON.parse(line) as unknown;
        options.onStructuredEvent(event);
        options.broadcastEvent(event);
      } catch {
        options.broadcastEvent({ type: "log", level: "info", message: line });
      }
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      options.broadcastEvent({ type: "log", level: "error", message: line });
    });
    child.on("exit", (code) => {
      options.broadcastEvent({ type: "state", state: "exited", code });
      clearProcessor(child);
    });
    child.on("error", (error) => {
      options.broadcastEvent({ type: "error", message: `Rust 处理器启动失败: ${error.message}` });
      clearProcessor(child);
    });
    return child;
  }

  function send(command: ProcessorCommand, nextActivity?: ProcessorActivity): void {
    if (nextActivity) activity = nextActivity;
    ensureProcessor().stdin.write(`${JSON.stringify(command)}\n`);
  }

  function stop(): Promise<void> {
    const child = processor;
    const stoppedActivity = activity;
    if (!child || child.killed) {
      options.broadcastEvent({ type: "state", state: "idle" });
      return Promise.resolve();
    }

    return new Promise((resolveStop) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        processor = null;
        activity = null;
        if (stoppedActivity === "start") {
          options.broadcastEvent({
            type: "done",
            stopped: true,
            summaryPath: null,
            outputFiles: [],
            failures: [],
          });
        } else if (stoppedActivity === "price-run") {
          options.broadcastEvent({
            type: "price-done",
            mode: "run",
            stopped: true,
            files: [],
            failures: [],
          });
          options.onRunStopped();
        } else if (stoppedActivity === "price-analyze") {
          options.broadcastEvent({
            type: "price-done",
            mode: "analysis",
            stopped: true,
            files: [],
          });
        }
        resolveStop();
      };
      child.once("exit", finish);
      child.once("error", finish);
      if (!child.kill()) finish();
    });
  }

  function shutdown(): void {
    if (!processor || processor.killed) return;
    processor.stdin.write(`${JSON.stringify({ action: "shutdown" })}\n`);
  }

  return { send, shutdown, stop };
}
