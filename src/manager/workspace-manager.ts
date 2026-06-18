import fs from "node:fs";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { buildAgentPreset, listPluginDirs, supportedAgents, type AgentPreset, type AppConfig } from "../config.js";
import { AcpSession, type AcpResumeInfo } from "../acp/session.js";
import type { Logger } from "../logger.js";
import type { MemoryStore, ContextBundle, WorkspaceRecord } from "../memory/store.js";
import type { AgentKind, IncomingMessage, MessageTransport, ReplyTarget } from "../types.js";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface RunningWorkspace {
  record: WorkspaceRecord;
  preset: AgentPreset;
  session: AcpSession;
}

interface PluginManifest {
  name: string;
  description?: string;
  skill?: string;
  transport?: "stdio";
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

interface PluginSkill {
  name: string;
  content: string;
}

interface NativeMcpConfig {
  mcpServers: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

interface PendingWorkspaceCreate {
  id: string;
  agent: AgentKind;
  cwd: string;
}

export class WorkspaceManager {
  private readonly running = new Map<string, RunningWorkspace>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pendingWorkspaceCreates = new Map<string, PendingWorkspaceCreate>();
  private activeWorkspaceId?: string;

  constructor(
    private readonly store: MemoryStore,
    private readonly transport: MessageTransport,
    private readonly log: Logger,
    private readonly config: AppConfig,
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
        return this.handleWorkspaceCommand(args, userId);
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

  private async handleWorkspaceCommand(args: string[], userId: string): Promise<string> {
    const subcommand = args[0];
    switch (subcommand) {
      case "open":
        return this.openWorkspace(args, userId);
      case "confirm-create":
        return this.confirmWorkspaceCreate(userId);
      case "cancel-create":
        this.pendingWorkspaceCreates.delete(userId);
        return "Cancelled pending workspace directory creation.";
      case "use":
        return this.useWorkspace(args[1], userId);
      case "list":
        return this.listWorkspaces();
      case "current":
        return this.currentWorkspace();
      case "stop":
        return this.stopWorkspace(args[1]);
      default:
        return "Usage: /workspace open <id> <copilot|opencode> <cwd> [--create] | confirm-create | cancel-create | use <id> | list | current | stop <id>";
    }
  }

  private async openWorkspace(args: string[], userId: string): Promise<string> {
    const id = args[1];
    const agent = args[2] as AgentKind | undefined;
    const create = args.includes("--create");
    const cwdText = args
      .slice(3)
      .filter((arg) => arg !== "--create")
      .join(" ");

    if (!id || !agent || !cwdText) {
      return "Usage: /workspace open <id> <copilot|opencode> <cwd> [--create]";
    }
    validateWorkspaceId(id);

    const preset = this.getAgentPreset(agent);
    if (!preset) {
      return `Unsupported agent: ${agent}. Supported agents: ${supportedAgents().join(", ")}`;
    }

    const cwd = path.resolve(cwdText);
    if (!fs.existsSync(cwd)) {
      if (!create) {
        this.pendingWorkspaceCreates.set(userId, { id, agent, cwd });
        return [
          `Directory does not exist: ${cwd}`,
          "Send `/workspace confirm-create` to create it and start the workspace.",
          "Or send `/workspace cancel-create` to cancel.",
          "To skip confirmation next time, use `/workspace open <id> <agent> <cwd> --create`.",
        ].join("\n");
      }
      fs.mkdirSync(cwd, { recursive: true });
    }
    validateDirectory(cwd);

    return this.startWorkspace({ id, agent, cwd, userId });
  }

  private async confirmWorkspaceCreate(userId: string): Promise<string> {
    const pending = this.pendingWorkspaceCreates.get(userId);
    if (!pending) {
      return "No pending workspace directory creation.";
    }
    this.pendingWorkspaceCreates.delete(userId);
    if (!fs.existsSync(pending.cwd)) {
      fs.mkdirSync(pending.cwd, { recursive: true });
    }
    validateDirectory(pending.cwd);
    return this.startWorkspace({ ...pending, userId });
  }

  private async startWorkspace(params: { id: string; agent: AgentKind; cwd: string; userId: string }): Promise<string> {
    const { id, agent, cwd, userId } = params;
    this.pendingWorkspaceCreates.delete(userId);
    const preset = this.getAgentPreset(agent);
    if (!preset) {
      return `Unsupported agent: ${agent}. Supported agents: ${supportedAgents().join(", ")}`;
    }

    const existing = this.running.get(id);
    if (existing) {
      existing.session.stop();
      this.running.delete(id);
    }

    const workspacePreset = this.preparePresetForWorkspace(preset, userId, id);
    const session = new AcpSession({
      workspaceId: id,
      preset: workspacePreset,
      cwd,
      mcpServers: this.createSessionMcpServers(userId, id),
      log: this.log,
      onResumeInfo: (info) => {
        this.store.updateWorkspaceResumeInfo(id, info);
        this.log(formatResumeInfo(id, info));
      },
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
    this.running.set(id, { record, preset: workspacePreset, session });
    this.activeWorkspaceId = id;

    return `Workspace '${id}' is running with ${workspacePreset.label} at ${cwd}. It is now active.`;
  }

  private async useWorkspace(id: string | undefined, userId: string): Promise<string> {
    if (!id) {
      return "Usage: /workspace use <id>";
    }

    let running = this.running.get(id);
    if (!running) {
      const record = this.store.getWorkspace(id);
      if (!record) {
        return `Workspace '${id}' does not exist. Use /workspace open <id> <agent> <cwd> first.`;
      }
      const preset = this.getAgentPreset(record.agent as AgentKind);
      if (!preset) {
        return `Workspace '${id}' uses unsupported agent '${record.agent}'.`;
      }
      running = await this.startFromRecord(record, preset, userId);
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
        const resume = record.resumeId ? ` resume=${record.resumeId}` : "";
        return `${active} ${record.id} [${record.agent}] ${runtime} ${record.cwd}${resume}`;
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
    const lines = [`${record.id} [${record.agent}] ${runtime} ${record.cwd}`];
    if (record.resumeId) {
      lines.push(`resume id: ${record.resumeId}`);
      lines.push(`resume command: ${record.resumeCommand ?? defaultResumeCommand(record)}`);
    }
    return lines.join("\n");
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
        const includeAllWorkspaces = args[1] === "--all";
        const query = args.slice(includeAllWorkspaces ? 2 : 1).join(" ").trim();
        if (!query) return "Usage: /memory search [--all] <query>";
        const results = this.store.searchMemories({
          query,
          userId,
          workspaceId: this.activeWorkspaceId,
          includeAllWorkspaces,
          limit: 8,
        });
        if (results.length === 0) return "No matching memory.";
        return results
          .map((memory) => `- ${memory.id} [${memory.scope}${memory.workspaceId ? `:${memory.workspaceId}` : ""}] ${memory.content}`)
          .join("\n");
      }
      case "topics": {
        const includeAllWorkspaces = args[1] === "--all";
        const topics = this.store.getMemoryTopics({
          userId,
          workspaceId: this.activeWorkspaceId,
          includeAllWorkspaces,
          limit: 10,
        });
        if (topics.length === 0) return "No memory topics yet.";
        return topics
          .map((topic) => `- ${topic.id} (${topic.count}) ${topic.description} examples: ${topic.sampleMemoryIds.join(", ")}`)
          .join("\n");
      }
      default:
        return "Usage: /memory remember <text> | search [--all] <query> | topics [--all]";
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
      "/memory search [--all] <query>",
      "/memory topics [--all]",
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
      includeAllWorkspaces: true,
    });
    const recentTurns = this.store.getRecentTurns(active.record.id, message.userId, 8);
    const prompt = buildPrompt(message.text, context, recentTurns, this.config);

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

  private async startFromRecord(record: WorkspaceRecord, preset: AgentPreset, userId: string): Promise<RunningWorkspace> {
    validateDirectory(record.cwd);
    const workspacePreset = this.preparePresetForWorkspace(preset, userId, record.id);
    const session = new AcpSession({
      workspaceId: record.id,
      preset: workspacePreset,
      cwd: record.cwd,
      mcpServers: this.createSessionMcpServers(userId, record.id),
      log: this.log,
      onResumeInfo: (info) => {
        this.store.updateWorkspaceResumeInfo(record.id, info);
        this.log(formatResumeInfo(record.id, info));
      },
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
    const running = { record: updated, preset: workspacePreset, session };
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

  private getAgentPreset(agent: AgentKind): AgentPreset | undefined {
    return buildAgentPreset(agent, this.config);
  }

  private preparePresetForWorkspace(preset: AgentPreset, userId: string, workspaceId: string): AgentPreset {
    if (preset.kind !== "copilot" || this.config.plugins.mode !== "copilot-native") {
      return preset;
    }
    const configPath = this.writeNativeMcpConfig(userId, workspaceId);
    return {
      ...preset,
      args: [...preset.args, "--additional-mcp-config", `@${configPath}`],
    };
  }

  private writeNativeMcpConfig(userId: string, workspaceId: string): string {
    const env = this.sessionPluginEnv(userId, workspaceId);
    const config: NativeMcpConfig = { mcpServers: {} };
    for (const pluginDir of listPluginDirs(this.config.plugins.marketDirs)) {
      const manifest = readPluginManifest(path.join(pluginDir, "plugin.json"));
      if (!manifest) continue;
      config.mcpServers[manifest.name] = {
        command: manifest.command,
        args: resolvePluginArgs(pluginDir, manifest.args ?? []),
        env: {
          ...env,
          ...Object.fromEntries(resolvePluginEnv(manifest.env ?? [], env).map((item) => [item.name, item.value])),
        },
      };
    }
    const dir = path.join(this.config.storageDir, "native-mcp");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, `${workspaceId}.json`);
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    return configPath;
  }

  private createSessionMcpServers(userId: string, workspaceId: string): acp.McpServer[] {
    if (this.config.plugins.mode === "copilot-native") {
      return [];
    }
    return loadPluginMcpServers(this.config.plugins.marketDirs, this.sessionPluginEnv(userId, workspaceId));
  }

  private sessionPluginEnv(userId: string, workspaceId: string): Record<string, string> {
    return {
      WECHAT_ACP_MEMORY_DB: this.store.databasePath,
      WECHAT_ACP_USER_ID: userId,
      WECHAT_ACP_WORKSPACE_ID: workspaceId,
      WECHAT_ACP_STORAGE_DIR: this.config.storageDir,
      SKILLOPT_PLUGIN_MARKET_DIRS: this.config.plugins.marketDirs.join(path.delimiter),
    };
  }
}

function buildPrompt(
  userMessage: string,
  context: ContextBundle,
  recentTurns: Array<{ role: string; content: string }>,
  config: AppConfig,
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

  const pluginSkills = config.plugins.mode === "managed" ? loadPluginSkills(config.plugins.marketDirs) : [];
  if (pluginSkills.length > 0) {
    sections.push(
      `[Plugin Skills]\n${pluginSkills
        .map((skill) => `## ${skill.name}\n${truncate(skill.content, 4_000)}`)
        .join("\n\n")}`,
    );
  }

  if (context.memoryTopics.length > 0) {
    sections.push(
      `[Memory Topic Index]\n${context.memoryTopics
        .map(
          (topic) =>
            `- ${topic.id} (${topic.count} memories): ${topic.description} sample ids: ${topic.sampleMemoryIds.join(", ")}`,
        )
        .join("\n")}`,
    );
  }

  if (context.memories.length > 0) {
    sections.push(
      `[Relevant Memories]\n${context.memories
        .map((memory) => `- ${memory.id} [${memory.scope}${memory.workspaceId ? `:${memory.workspaceId}` : ""}] ${memory.content}`)
        .join("\n")}`,
    );
  }

  sections.push(
    [
      "[Memory Access]",
      "Before answering, inspect the Memory Topic Index to decide which durable context may be relevant.",
      "Relevant memories above were auto-retrieved across user/global/current workspace and other workspaces.",
      "If a topic looks relevant but details are missing, use MCP tools memory_topics, memory_search, memory_get, and memory_remember.",
    ].join("\n"),
  );

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

function formatResumeInfo(workspaceId: string, info: AcpResumeInfo): string {
  return `[workspace:${workspaceId}] captured resume id: ${info.id}${info.command ? ` (${info.command})` : ""}`;
}

function defaultResumeCommand(record: WorkspaceRecord): string {
  return record.agent === "copilot" ? `copilot --resume ${record.resumeId}` : `${record.agent} --resume ${record.resumeId}`;
}

function loadPluginMcpServers(pluginRoots: string[], sessionEnv: Record<string, string>): acp.McpServer[] {
  const servers: acp.McpServer[] = [];
  for (const pluginDir of listPluginDirs(pluginRoots)) {
    const manifestPath = path.join(pluginDir, "plugin.json");
    const manifest = readPluginManifest(manifestPath);
    if (!manifest) continue;
    servers.push({
      name: manifest.name,
      command: manifest.command,
      args: resolvePluginArgs(pluginDir, manifest.args ?? []),
      env: resolvePluginEnv(manifest.env ?? [], sessionEnv),
    });
  }
  return servers;
}

function readPluginManifest(manifestPath: string): PluginManifest | undefined {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  if (!parsed || typeof parsed !== "object") return undefined;
  const manifest = parsed as Partial<PluginManifest>;
  if (manifest.transport && manifest.transport !== "stdio") return undefined;
  if (typeof manifest.name !== "string" || typeof manifest.command !== "string") return undefined;
  if (manifest.args && !Array.isArray(manifest.args)) return undefined;
  if (manifest.env && !Array.isArray(manifest.env)) return undefined;
  return {
    name: manifest.name,
    description: typeof manifest.description === "string" ? manifest.description : undefined,
    skill: typeof manifest.skill === "string" ? manifest.skill : undefined,
    transport: manifest.transport,
    command: manifest.command,
    args: manifest.args?.filter((arg): arg is string => typeof arg === "string"),
    env: manifest.env?.filter(
      (item): item is { name: string; value: string } =>
        !!item && typeof item === "object" && typeof item.name === "string" && typeof item.value === "string",
    ),
  };
}

function resolvePluginArgs(pluginDir: string, args: string[]): string[] {
  return args.map((arg) => {
    if (arg.startsWith("-") || path.isAbsolute(arg)) return arg;
    if (!arg.includes("/") && !arg.includes("\\")) return arg;
    const absolute = path.resolve(pluginDir, arg);
    return fs.existsSync(absolute) ? absolute : arg;
  });
}

function resolvePluginEnv(
  env: Array<{ name: string; value: string }>,
  sessionEnv: Record<string, string>,
): Array<{ name: string; value: string }> {
  return env.map((item) => ({
    name: item.name,
    value: item.value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => sessionEnv[key] ?? ""),
  }));
}

function loadPluginSkills(pluginRoots: string[]): PluginSkill[] {
  const skills: PluginSkill[] = [];
  for (const pluginDir of listPluginDirs(pluginRoots)) {
    const manifestPath = path.join(pluginDir, "plugin.json");
    const manifest = readPluginManifest(manifestPath);
    if (!manifest) continue;
    const skillPath = resolvePluginSkillPath(pluginDir, manifest.skill ?? "SKILL.md");
    if (!skillPath) continue;
    skills.push({
      name: manifest.name,
      content: fs.readFileSync(skillPath, "utf-8").trim(),
    });
  }
  return skills;
}

function resolvePluginSkillPath(pluginDir: string, skillPath: string): string | undefined {
  const pluginRoot = path.resolve(pluginDir);
  const absolute = path.resolve(pluginRoot, skillPath);
  if (absolute !== pluginRoot && !absolute.startsWith(`${pluginRoot}${path.sep}`)) {
    return undefined;
  }
  return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? absolute : undefined;
}
