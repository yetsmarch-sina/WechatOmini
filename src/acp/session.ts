import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AcpClient } from "./client.js";
import type { AgentPreset } from "../config.js";
import type { Logger } from "../logger.js";

export interface AcpSessionOptions {
  workspaceId: string;
  preset: AgentPreset;
  cwd: string;
  log: Logger;
  onTyping?: () => Promise<void>;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class AcpSession {
  private process?: ChildProcess;
  private connection?: acp.ClientSideConnection;
  private sessionId?: string;
  private client?: AcpClient;

  constructor(private readonly options: AcpSessionOptions) {}

  get pid(): number | undefined {
    return this.process?.pid;
  }

  async start(): Promise<void> {
    const { preset, cwd, log } = this.options;
    const useShell = process.platform === "win32";

    log(`[workspace:${this.options.workspaceId}] spawning ${preset.command} ${preset.args.join(" ")} (cwd: ${cwd})`);

    const child = spawn(preset.command, preset.args, {
      cwd,
      env: process.env,
      shell: useShell,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });

    child.on("error", (error) => {
      log(`[workspace:${this.options.workspaceId}] agent process error: ${String(error)}`);
    });
    child.on("exit", (code, signal) => {
      log(`[workspace:${this.options.workspaceId}] agent exited: code=${code} signal=${signal}`);
      this.options.onExit?.(code, signal);
    });

    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error("Failed to open ACP subprocess stdio");
    }

    const client = new AcpClient(log, this.options.onTyping);
    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);
    const connection = new acp.ClientSideConnection(() => client, stream);

    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: {
        name: "wechat-acp-manager",
        title: "WeChat ACP Manager",
        version: "0.1.0",
      },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });
    log(`[workspace:${this.options.workspaceId}] ACP initialized (${initResult.protocolVersion})`);

    const newSessionResult = await connection.newSession({
      cwd,
      mcpServers: [],
    });
    log(`[workspace:${this.options.workspaceId}] ACP session created: ${newSessionResult.sessionId}`);

    this.process = child;
    this.client = client;
    this.connection = connection;
    this.sessionId = newSessionResult.sessionId;
  }

  async prompt(text: string): Promise<{ reply: string; stopReason?: acp.StopReason }> {
    if (!this.connection || !this.sessionId || !this.client) {
      throw new Error("ACP session is not started");
    }

    this.client.startTurn();
    const result = await this.connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });

    let reply = this.client.flush();
    if (result.stopReason === "cancelled") {
      reply += "\n[cancelled]";
    } else if (result.stopReason === "refusal") {
      reply += "\n[agent refused to continue]";
    }

    if (!reply.trim() && !this.client.hasProducedText) {
      reply = emptyTurnNotice(result.stopReason);
    }

    return { reply, stopReason: result.stopReason };
  }

  async cancel(): Promise<boolean> {
    if (!this.connection || !this.sessionId) return false;
    await this.connection.cancel({ sessionId: this.sessionId });
    return true;
  }

  stop(): void {
    if (!this.process || this.process.killed) return;
    this.process.kill("SIGTERM");
    const child = this.process;
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  }
}

function emptyTurnNotice(stopReason: acp.StopReason | undefined): string {
  switch (stopReason) {
    case "max_tokens":
      return "The agent stopped at its output length limit before sending a reply.";
    case "max_turn_requests":
      return "The agent reached its tool-call limit before sending a reply.";
    case "refusal":
      return "The agent declined to respond.";
    case "cancelled":
      return "The request was cancelled before the agent sent a reply.";
    default:
      return "The agent finished without sending a reply.";
  }
}
