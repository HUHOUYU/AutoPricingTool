import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createProcessorSession } from "../../../backend/electron/main/processor-session";

function createChild() {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(emitter, {
    killed: false,
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => {
      queueMicrotask(() => emitter.emit("exit", 0));
      return true;
    }),
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, stdin, stdout };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createProcessorSession", () => {
  it("serializes commands and forwards structured processor events", async () => {
    const { child, stdin, stdout } = createChild();
    const broadcastEvent = vi.fn();
    const onStructuredEvent = vi.fn();
    const session = createProcessorSession({
      broadcastEvent,
      cwd: "C:\\app",
      getExecutablePath: () => "processor.exe",
      onRunStopped: vi.fn(),
      onStructuredEvent,
      spawnProcessor: vi.fn(() => child) as unknown as typeof spawn,
    });
    const written: string[] = [];
    stdin.on("data", (chunk) => written.push(String(chunk)));

    session.send({ action: "scan", files: ["a.xlsx"] }, "scan");
    stdout.write(`${JSON.stringify({ type: "progress", current: 1 })}\n`);
    await nextTurn();

    expect(written.join("")).toBe('{"action":"scan","files":["a.xlsx"]}\n');
    expect(onStructuredEvent).toHaveBeenCalledWith({ type: "progress", current: 1 });
    expect(broadcastEvent).toHaveBeenCalledWith({ type: "progress", current: 1 });
  });

  it("emits a stopped run event and completes task tracking", async () => {
    const { child } = createChild();
    const broadcastEvent = vi.fn();
    const onRunStopped = vi.fn();
    const session = createProcessorSession({
      broadcastEvent,
      cwd: "C:\\app",
      getExecutablePath: () => "processor.exe",
      onRunStopped,
      onStructuredEvent: vi.fn(),
      spawnProcessor: vi.fn(() => child) as unknown as typeof spawn,
    });

    session.send({ action: "price-check-run" }, "price-run");
    await session.stop();

    expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "price-done",
      mode: "run",
      stopped: true,
    }));
    expect(onRunStopped).toHaveBeenCalledOnce();
  });
});
