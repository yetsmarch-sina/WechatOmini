import fs from "node:fs";
import path from "node:path";
import { AGENT_PRESETS, type AgentPreset } from "../config.js";
import { AcpSession } from "../acp/session.js";
import type { Logger } from "../logger.js";
import type { MemoryStore, ContextBundle, WorkspaceRecord } from "../memory/store.js";
import type { AgentKind, IncomingMessage, MessageTransport, ReplyTarget } from "../types.js";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface RunningWorkspace {
  record: WorkspaceRecord;
  preset: AgentPreset;
  session: AcpSession;
}

export class WorkspaceManager {
  private readonly running = new Map<string, RunningWorkspace>();
  private readonly queues = new Map<string, Promise<void>>();
  private activeWorkspaceId?: string;

  constructor(
    private readonly store: MemoryStore,
    private readonly transport: MessageTransport,
    private readonly log: Logger,
  ) {}

  async handleIncoming(message: IncomingMessage): Promise<void> {
    const trimmed = message.text.trim();
    const target: ReplyTarget = {
      userId: message.userId,
      contextToken: message.contextToken,
    };

    try {
      if (trimmed.startsWith("/")) {
        const reply = await this.handleCommand(trimmed, message.userId);
        await this.transport.sendReply(target, reply);
        return;
      }

      const previous = this.queues.get(message.userId) ?? Promise.resolve();
      const next = previous
        .catch(() => {})
        .then(() => this.handlePrompt(message, target));
      this.queues.set(message.userId, next);
      await next;
    } catch (error) {
      this.log(`message handling failed: ${String(error)}`);
      const messageText = error instanceof Error ? error.message : String(error);
      await this.transport.sendReply(target, `Error: ${messageText}`);
    }
  }

  async stop(): Promise<void> {
    for (const workspace of this.running.values()) {
      workspace.session.stop();
      this.store.updateWorkspaceStatus(workspace.record.id, "stopped");
    }
    this.running.clear();
  }

  private async handleCommand(commandLine: string, userId: string): Promise<string> {
    const [command, ...args] = commandLine.split(/\s+/);

    switch (command) {
      case "/workspace":
        return this.handleWorkspaceCommand(args);
      case "/memory":
        return this.handleMemoryCommand(args, userId);
      case "/cancel":
        return this.cancelActive();
      case "/help":
        return this.commandHelp();
      default:
        return `Unknown command: ${command}. Send /help for available commands.`;
    }
  }

  private async handleWorkspaceCommand(args: string[]): Promise<string> {
    const subcommand = args[0];
    switch (subcommand) {
      case "open":
        return this.openWorkspace(args);
      case "use":
        return this.useWorkspace(args[1]);
      case "list":
        return this.listWorkspaces();
      case "current":
        return this.currentWorkspace();
      case "stop":
        return this.stopWorkspace(args[1]);
      default:
        return "Usage: /workspace open <id> <copilot|opencode> <cwd> | use <id> | list | current | stop <id>";
    }
  }

  private async openWorkspace(args: string[]): Promise<string> {
    const id = args[1];
    const agent = args[2] as AgentKind | undefined;
    const cwdText = args.slice(3).join(" ");

    if (!id || !agent || !cwdText) {
      return "Usage: /workspace open <id> <copilot|opencode> <cwd>";
    }
    validateWorkspaceId(id);

    const preset = AGENT_PRESETS[agent];
    if (!preset) {
      return `Unsupported agent: ${agent}. Supported agents: ${Object.keys(AGENT_PRESETS).join(", ")}`;
    }

    const cwd = path.resolve(cwdText);
    validateDirectory(cwd);

    const existing = this.running.get(id);
    if (existing) {
      existing.session.stop();
      this.running.delete(id);
    }

    const session = new AcpSession({
      workspaceId: id,
      preset,
      cwd,
      log: this.log,
      onExit: () => {
        this.running.delete(id);
        this.store.updateWorkspaceStatus(id, "exited");
      },
    });

    try {
      await session.start();
    } catch (error) {
      this.store.upsertWorkspace({
        id,
        agent,
        cwd,
        status: "failed",
      });
      throw error;
    }

    const record = this.store.upsertWorkspace({
      id,
      agent,
      cwd,
      status: "running",
      pid: session.pid,
    });
    this.running.set(id, { record, preset, session });
    this.activeWorkspaceId = id;

    return `Workspace '${id}' is running with ${preset.label} at ${cwd}. It is now active.`;
  }

  private async useWorkspace(id: string | undefined): Promise<string> {
    if (!id) {
      return "Usage: /workspace use <id>";
    }

    let running = this.running.get(id);
    if (!running) {
      const record = this.store.getWorkspace(id);
      if (!record) {
        return `Workspace '${id}' does not exist. Use /workspace open <id> <agent> <cwd> first.`;
      }
      const preset = AGENT_PRESETS[record.agent as AgentKind];
      if (!preset) {
        return `Workspace '${id}' uses unsupported agent '${record.agent}'.`;
      }
      running = await this.startFromRecord(record, preset);
    }

    this.activeWorkspaceId = running.record.id;
    this.store.touchWorkspace(running.record.id);
    return `Active workspace switched to '${running.record.id}' (${running.preset.label}, ${running.record.cwd}).`;
  }

  private listWorkspaces(): string {
    const records = this.store.listWorkspaces();
    if (records.length === 0) {
      return "No workspaces. Use /workspace open <id> <copilot|opencode> <cwd>.";
    }

    return records
      .map((record) => {
        const active = record.id === this.activeWorkspaceId ? "*" : " ";
        const runtime = this.running.has(record.id) ? "running" : record.status;
        return `${active} ${record.id} [${record.agent}] ${runtime} ${record.cwd}`;
      })
      .join("\n");
  }

  private currentWorkspace(): string {
    if (!this.activeWorkspaceId) {
      return "No active workspace. Use /workspace open or /workspace use first.";
    }
    const record = this.store.getWorkspace(this.activeWorkspaceId);
    if (!record) {
      this.activeWorkspaceId = undefined;
      return "No active workspace. Use /workspace open or /workspace use first.";
    }
    const runtime = this.running.has(record.id) ? "running" : record.status;
    return `${record.id} [${record.agent}] ${runtime} ${record.cwd}`;
  }

  private async stopWorkspace(id: string | undefined): Promise<string> {
    if (!id) {
      return "Usage: /workspace stop <id>";
    }
    const running = this.running.get(id);
    if (running) {
      running.session.stop();
      this.running.delete(id);
    }
    this.store.updateWorkspaceStatus(id, "stopped");
    if (this.activeWorkspaceId === id) {
      this.activeWorkspaceId = undefined;
    }
    return `Workspace '${id}' stopped.`;
  }

  private async handleMemoryCommand(args: string[], userId: string): Promise<string> {
    const subcommand = args[0];
    switch (subcommand) {
      case "remember": {
        const content = args.slice(1).join(" ").trim();
        if (!content) return "Usage: /memory remember <text>";
        const memory = this.store.remember({
          scope: this.activeWorkspaceId ? "workspace" : "user",
          workspaceId: this.activeWorkspaceId,
          userId,
          content,
          tags: this.activeWorkspaceId ? ["workspace"] : ["user"],
        });
        return `Remembered (${memory.scope}): ${memory.content}`;
      }
      case "search": {
        const query = args.slice(1).join(" ").trim();
        if (!query) return "Usage: /memory search <query>";
        const results = this.store.searchMemories({
          query,
          userId,
          workspaceId: this.activeWorkspaceId,
          limit: 8,
        });
        if (results.length === 0) return "No matching memory.";
        return results.map((memory) => `- [${memory.scope}] ${memory.content}`).join("\n");
      }
      default:
        return "Usage: /memory remember <text> | search <query>";
    }
  }

  private async cancelActive(): Promise<string> {
    const active = this.getActiveRunningWorkspace();
    if (!active) {
      return "No active running workspace to cancel.";
    }
    const cancelled = await active.session.cancel();
    return cancelled ? "Cancel signal sent to active ACP session." : "No active ACP turn to cancel.";
  }

  private commandHelp(): string {
    return [
      "/workspace open <id> <copilot|opencode> <cwd>",
      "/workspace use <id>",
      "/workspace list",
      "/workspace current",
      "/workspace stop <id>",
      "/memory remember <text>",
      "/memory search <query>",
      "/cancel",
    ].join("\n");
  }

  private async handlePrompt(message: IncomingMessage, target: ReplyTarget): Promise<void> {
    const active = this.getActiveRunningWorkspace();
    if (!active) {
      await this.transport.sendReply(
        target,
        "No active workspace. Use /workspace open <id> <copilot|opencode> <cwd> first.",
      );
      return;
    }

    const userTurnId = this.store.addTurn({
      workspaceId: active.record.id,
      userId: message.userId,
      role: "user",
      content: message.text,
    });
    this.store.touchWorkspace(active.record.id);

    const context = this.store.getContext({
      workspaceId: active.record.id,
      userId: message.userId,
      query: message.text,
    });
    const recentTurns = this.store.getRecentTurns(active.record.id, message.userId, 8);
    const prompt = buildPrompt(message.text, context, recentTurns);

    await this.transport.sendTyping?.(target);
    const result = await active.session.prompt(prompt);
    const reply = result.reply.trim() || "The agent did not produce a reply.";

    this.store.addTurn({
      workspaceId: active.record.id,
      userId: message.userId,
      role: "assistant",
      content: reply,
    });
    this.refreshSessionSummary(active.record.id, message.userId);

    if (reply.includes("remember") || reply.includes("Remember")) {
      this.log(`[debug] prompt completed after user turn ${userTurnId}`);
    }
    await this.transport.sendReply(target, reply);
  }

  private getActiveRunningWorkspace(): RunningWorkspace | undefined {
    if (!this.activeWorkspaceId) return undefined;
    return this.running.get(this.activeWorkspaceId);
  }

  private async startFromRecord(record: WorkspaceRecord, preset: AgentPreset): Promise<RunningWorkspace> {
    validateDirectory(record.cwd);
    const session = new AcpSession({
      workspaceId: record.id,
      preset,
      cwd: record.cwd,
      log: this.log,
      onExit: () => {
        this.running.delete(record.id);
        this.store.updateWorkspaceStatus(record.id, "exited");
      },
    });
    await session.start();
    const updated = this.store.upsertWorkspace({
      id: record.id,
      agent: record.agent,
      cwd: record.cwd,
      status: "running",
      pid: session.pid,
    });
    const running = { record: updated, preset, session };
    this.running.set(record.id, running);
    return running;
  }

  private refreshSessionSummary(workspaceId: string, userId: string): void {
    const turns = this.store.getRecentTurns(workspaceId, userId, 12);
    const summary = turns
      .map((turn) => `${turn.role}: ${truncate(turn.content, 500)}`)
      .join("\n");
    this.store.setSessionSummary(workspaceId, summary);
  }
}

function buildPrompt(
  userMessage: string,
  context: ContextBundle,
  recentTurns: Array<{ role: string; content: string }>,
): string {
  const sections: string[] = [];

  if (context.workspace) {
    sections.push(
      [
        "[Workspace]",
        `id: ${context.workspace.id}`,
        `agent: ${context.workspace.agent}`,
        `cwd: ${context.workspace.cwd}`,
      ].join("\n"),
    );
  }

  if (context.sessionSummary?.trim()) {
    sections.push(`[Session Summary]\n${context.sessionSummary.trim()}`);
  }

  if (context.memories.length > 0) {
    sections.push(
      `[Relevant Memories]\n${context.memories.map((memory) => `- [${memory.scope}] ${memory.content}`).join("\n")}`,
    );
  }

  if (recentTurns.length > 0) {
    sections.push(
      `[Recent Transcript]\n${recentTurns
        .map((turn) => `${turn.role}: ${truncate(turn.content, 600)}`)
        .join("\n")}`,
    );
  }

  sections.push(`[User Message]\n${userMessage}`);
  return sections.join("\n\n");
}

function validateWorkspaceId(id: string): void {
  if (!WORKSPACE_ID_PATTERN.test(id)) {
    throw new Error("Workspace id must be 1-64 chars and contain only letters, digits, '.', '_' or '-'.");
  }
}

function validateDirectory(cwd: string): void {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Workspace cwd does not exist or is not a directory: ${cwd}`);
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.substring(0, maxLength)}...`;
}
