import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { newId, nowIso } from "../util/ids.js";

export type MemoryScope = "global" | "user" | "workspace" | "session";
export type MemoryTopicId =
  | "user-preferences"
  | "project-conventions"
  | "architecture"
  | "workflows"
  | "commands"
  | "decisions"
  | "issues"
  | "dependencies"
  | "external-research"
  | "sessions"
  | "general";

export interface MemoryTopic {
  id: MemoryTopicId;
  label: string;
  description: string;
  count: number;
  sampleMemoryIds: string[];
}

export interface WorkspaceRecord {
  id: string;
  agent: string;
  cwd: string;
  status: string;
  pid?: number;
  resumeId?: string;
  resumeCommand?: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  workspaceId?: string;
  userId?: string;
  content: string;
  tags: string[];
  sourceTurnId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextBundle {
  workspace?: WorkspaceRecord;
  sessionSummary?: string;
  memoryTopics: MemoryTopic[];
  memories: MemoryRecord[];
}

interface TurnInsert {
  workspaceId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
}

interface RememberInput {
  scope: MemoryScope;
  content: string;
  workspaceId?: string;
  userId?: string;
  tags?: string[];
  sourceTurnId?: string;
}

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(readonly databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  upsertWorkspace(record: {
    id: string;
    agent: string;
    cwd: string;
    status: string;
    pid?: number;
  }): WorkspaceRecord {
    const existing = this.getWorkspace(record.id);
    const createdAt = existing?.createdAt ?? nowIso();
    const lastActiveAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, agent, cwd, status, pid, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent = excluded.agent,
           cwd = excluded.cwd,
           status = excluded.status,
           pid = excluded.pid,
           last_active_at = excluded.last_active_at`,
      )
      .run(record.id, record.agent, record.cwd, record.status, record.pid ?? null, createdAt, lastActiveAt);
    return this.getWorkspace(record.id)!;
  }

  updateWorkspaceResumeInfo(id: string, resume: { id: string; command?: string }): void {
    this.db
      .prepare("UPDATE workspaces SET resume_id = ?, resume_command = ?, last_active_at = ? WHERE id = ?")
      .run(resume.id, resume.command ?? null, nowIso(), id);
  }

  updateWorkspaceStatus(id: string, status: string, pid?: number): void {
    this.db
      .prepare("UPDATE workspaces SET status = ?, pid = ?, last_active_at = ? WHERE id = ?")
      .run(status, pid ?? null, nowIso(), id);
  }

  touchWorkspace(id: string): void {
    this.db.prepare("UPDATE workspaces SET last_active_at = ? WHERE id = ?").run(nowIso(), id);
  }

  getWorkspace(id: string): WorkspaceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? mapWorkspace(row) : undefined;
  }

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces ORDER BY last_active_at DESC, id ASC")
      .all();
    return rows.map(mapWorkspace);
  }

  addTurn(input: TurnInsert): string {
    const id = newId("turn");
    this.db
      .prepare(
        `INSERT INTO turns (id, workspace_id, user_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.workspaceId, input.userId, input.role, input.content, nowIso());
    return id;
  }

  getRecentTurns(workspaceId: string, userId: string, limit: number): Array<TurnInsert & { id: string; createdAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, user_id, role, content, created_at
         FROM turns
         WHERE workspace_id = ? AND user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(workspaceId, userId, limit);
    return rows.reverse().map((row) => ({
      id: readString(row, "id"),
      workspaceId: readString(row, "workspace_id"),
      userId: readString(row, "user_id"),
      role: readRole(row, "role"),
      content: readString(row, "content"),
      createdAt: readString(row, "created_at"),
    }));
  }

  setSessionSummary(workspaceId: string, summary: string): void {
    this.db
      .prepare(
        `INSERT INTO session_summaries (workspace_id, summary, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .run(workspaceId, summary, nowIso());
  }

  getSessionSummary(workspaceId: string): string | undefined {
    const row = this.db
      .prepare("SELECT summary FROM session_summaries WHERE workspace_id = ?")
      .get(workspaceId);
    return row ? readString(row, "summary") : undefined;
  }

  remember(input: RememberInput): MemoryRecord {
    const id = newId("mem");
    const timestamp = nowIso();
    const topics = inferMemoryTopics({ content: input.content, tags: input.tags ?? [], scope: input.scope });
    const tags = normalizeTags([...(input.tags ?? []), ...topics.map((topic) => `topic:${topic}`)]);
    this.db
      .prepare(
        `INSERT INTO memories
         (id, scope, workspace_id, user_id, content, tags, source_turn_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.workspaceId ?? null,
        input.userId ?? null,
        input.content,
        JSON.stringify(tags),
        input.sourceTurnId ?? null,
        timestamp,
        timestamp,
      );
    return this.getMemory(id)!;
  }

  searchMemories(params: {
    query: string;
    userId?: string;
    workspaceId?: string;
    scope?: MemoryScope;
    includeAllWorkspaces?: boolean;
    limit?: number;
  }): MemoryRecord[] {
    const query = params.query.trim();
    if (!query) return [];

    const terms = tokenize(query);
    const textClauses = terms.length > 0
      ? terms.map(() => "(content LIKE ? OR tags LIKE ?)").join(" OR ")
      : "(content LIKE ? OR tags LIKE ?)";
    const where = [
      textClauses,
      params.includeAllWorkspaces
        ? "(scope = 'global' OR (scope = 'user' AND user_id = ?) OR scope = 'workspace' OR scope = 'session')"
        : "(scope = 'global' OR (scope = 'user' AND user_id = ?) OR (scope = 'workspace' AND workspace_id = ?) OR (scope = 'session' AND workspace_id = ?))",
    ];
    const values: Array<string | number | null> = [];
    for (const term of terms.length > 0 ? terms : [query]) {
      const like = `%${term}%`;
      values.push(like, like);
    }
    values.push(params.userId ?? null);
    if (!params.includeAllWorkspaces) {
      values.push(params.workspaceId ?? null, params.workspaceId ?? null);
    }

    if (params.scope) {
      where.push("scope = ?");
      values.push(params.scope);
    }

    const fetchLimit = Math.max((params.limit ?? 8) * 4, 24);
    values.push(fetchLimit);

    const rows = this.db
      .prepare(
        `SELECT *
         FROM memories
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...values);

    return rows
      .map(mapMemory)
      .sort((left, right) => scoreMemory(right, query, terms, params.workspaceId) - scoreMemory(left, query, terms, params.workspaceId))
      .slice(0, params.limit ?? 8);
  }

  getContext(params: {
    workspaceId: string;
    userId: string;
    query: string;
    includeAllWorkspaces?: boolean;
    limit?: number;
  }): ContextBundle {
    const workspace = this.getWorkspace(params.workspaceId);
    return {
      workspace,
      sessionSummary: this.getSessionSummary(params.workspaceId),
      memoryTopics: this.getMemoryTopics({
        workspaceId: params.workspaceId,
        userId: params.userId,
        includeAllWorkspaces: params.includeAllWorkspaces,
        limit: 8,
      }),
      memories: this.searchMemories({
        query: params.query,
        workspaceId: params.workspaceId,
        userId: params.userId,
        includeAllWorkspaces: params.includeAllWorkspaces,
        limit: params.limit ?? 8,
      }),
    };
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? mapMemory(row) : undefined;
  }

  getMemoryTopics(params: {
    userId?: string;
    workspaceId?: string;
    includeAllWorkspaces?: boolean;
    limit?: number;
  }): MemoryTopic[] {
    const where = params.includeAllWorkspaces
      ? "(scope = 'global' OR (scope = 'user' AND user_id = ?) OR scope = 'workspace' OR scope = 'session')"
      : "(scope = 'global' OR (scope = 'user' AND user_id = ?) OR (scope = 'workspace' AND workspace_id = ?) OR (scope = 'session' AND workspace_id = ?))";
    const values: Array<string | number | null> = [params.userId ?? null];
    if (!params.includeAllWorkspaces) {
      values.push(params.workspaceId ?? null, params.workspaceId ?? null);
    }

    const rows = this.db
      .prepare(
        `SELECT *
         FROM memories
         WHERE ${where}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...values, 500)
      .map(mapMemory);

    const byTopic = new Map<MemoryTopicId, { count: number; sampleMemoryIds: string[] }>();
    for (const memory of rows) {
      for (const topic of inferMemoryTopics(memory)) {
        const current = byTopic.get(topic) ?? { count: 0, sampleMemoryIds: [] };
        current.count += 1;
        if (current.sampleMemoryIds.length < 3) {
          current.sampleMemoryIds.push(memory.id);
        }
        byTopic.set(topic, current);
      }
    }

    return MEMORY_TOPIC_DEFINITIONS
      .map((definition) => {
        const aggregate = byTopic.get(definition.id);
        return aggregate
          ? {
              ...definition,
              count: aggregate.count,
              sampleMemoryIds: aggregate.sampleMemoryIds,
            }
          : undefined;
      })
      .filter((topic): topic is MemoryTopic => !!topic)
      .sort((left, right) => right.count - left.count)
      .slice(0, params.limit ?? 8);
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        resume_id TEXT,
        resume_command TEXT,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_summaries (
        workspace_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        workspace_id TEXT,
        user_id TEXT,
        content TEXT NOT NULL,
        tags TEXT,
        source_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turns_workspace_user_created
        ON turns(workspace_id, user_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_memories_scope_workspace_user
        ON memories(scope, workspace_id, user_id, updated_at);
    `);
    this.ensureColumn("workspaces", "resume_id", "TEXT");
    this.ensureColumn("workspaces", "resume_command", "TEXT");
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (rows.some((row) => readString(row, "name") === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

type SqlRow = Record<string, SQLOutputValue>;

const MEMORY_TOPIC_DEFINITIONS: Array<Omit<MemoryTopic, "count" | "sampleMemoryIds">> = [
  {
    id: "user-preferences",
    label: "User preferences",
    description: "Durable user preferences, personal workflow habits, and communication style.",
  },
  {
    id: "project-conventions",
    label: "Project conventions",
    description: "Repository-specific coding standards, test practices, naming, and review rules.",
  },
  {
    id: "architecture",
    label: "Architecture",
    description: "System structure, component responsibilities, protocols, and data flow.",
  },
  {
    id: "workflows",
    label: "Workflows",
    description: "Operational steps for development, release, setup, deployment, and routine tasks.",
  },
  {
    id: "commands",
    label: "Commands",
    description: "Verified commands, CLIs, scripts, flags, and local setup invocations.",
  },
  {
    id: "decisions",
    label: "Decisions",
    description: "Past design decisions, tradeoffs, constraints, and rationale.",
  },
  {
    id: "issues",
    label: "Issues",
    description: "Known bugs, risks, failures, blockers, and debugging findings.",
  },
  {
    id: "dependencies",
    label: "Dependencies",
    description: "Packages, tools, runtime versions, SDKs, and external services.",
  },
  {
    id: "external-research",
    label: "External research",
    description: "Distilled findings from web, social, OpenCLI, or other external source research.",
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Session summaries, previous conversations, and historical task context.",
  },
  {
    id: "general",
    label: "General",
    description: "Memory that does not fit a more specific topic.",
  },
];

function mapWorkspace(row: SqlRow): WorkspaceRecord {
  return {
    id: readString(row, "id"),
    agent: readString(row, "agent"),
    cwd: readString(row, "cwd"),
    status: readString(row, "status"),
    pid: readOptionalNumber(row, "pid"),
    resumeId: readOptionalString(row, "resume_id"),
    resumeCommand: readOptionalString(row, "resume_command"),
    createdAt: readString(row, "created_at"),
    lastActiveAt: readString(row, "last_active_at"),
  };
}

function mapMemory(row: SqlRow): MemoryRecord {
  return {
    id: readString(row, "id"),
    scope: readScope(row, "scope"),
    workspaceId: readOptionalString(row, "workspace_id"),
    userId: readOptionalString(row, "user_id"),
    content: readString(row, "content"),
    tags: parseTags(readOptionalString(row, "tags")),
    sourceTurnId: readOptionalString(row, "source_turn_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function parseTags(tags: string | undefined): string[] {
  if (!tags) return [];
  const parsed: unknown = JSON.parse(tags);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function readString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`SQLite row field '${key}' is not a string`);
  }
  return value;
}

function readOptionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`SQLite row field '${key}' is not a string`);
  }
  return value;
}

function readOptionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Error(`SQLite row field '${key}' is not a number`);
  }
  return value;
}

function readRole(row: SqlRow, key: string): "user" | "assistant" | "system" {
  const value = readString(row, key);
  if (value === "user" || value === "assistant" || value === "system") return value;
  throw new Error(`Unexpected turn role: ${value}`);
}

function readScope(row: SqlRow, key: string): MemoryScope {
  const value = readString(row, key);
  if (value === "global" || value === "user" || value === "workspace" || value === "session") {
    return value;
  }
  throw new Error(`Unexpected memory scope: ${value}`);
}

function tokenize(query: string): string[] {
  const matches = query
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(matches)].slice(0, 12);
}

function scoreMemory(memory: MemoryRecord, query: string, terms: string[], workspaceId: string | undefined): number {
  const haystack = `${memory.content}\n${memory.tags.join(" ")}`.toLocaleLowerCase();
  let score = haystack.includes(query.toLocaleLowerCase()) ? 10 : 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length > 1 ? 3 : 1;
    }
  }
  if (workspaceId && memory.workspaceId === workspaceId) {
    score += 2;
  }
  if (memory.scope === "user" || memory.scope === "global") {
    score += 1;
  }
  return score;
}

function inferMemoryTopics(memory: Pick<MemoryRecord, "content" | "tags" | "scope">): MemoryTopicId[] {
  const text = `${memory.content}\n${memory.tags.join(" ")}`.toLocaleLowerCase();
  const topics = new Set<MemoryTopicId>();

  for (const tag of memory.tags) {
    if (tag.startsWith("topic:")) {
      const topic = tag.slice("topic:".length);
      if (isMemoryTopicId(topic)) topics.add(topic);
    }
  }

  if (memory.scope === "user" || matchesAny(text, ["preference", "prefer", "habit", "style", "偏好", "习惯", "风格"])) {
    topics.add("user-preferences");
  }
  if (matchesAny(text, ["convention", "standard", "lint", "test", "review", "naming", "约定", "规范", "测试", "命名"])) {
    topics.add("project-conventions");
  }
  if (matchesAny(text, ["architecture", "component", "protocol", "data flow", "mcp", "acp", "架构", "组件", "协议", "数据流"])) {
    topics.add("architecture");
  }
  if (matchesAny(text, ["workflow", "release", "publish", "deploy", "setup", "login", "流程", "发布", "部署", "登录"])) {
    topics.add("workflows");
  }
  if (matchesAny(text, ["command", "npm ", "npx ", "git ", "wsl ", "python ", "node ", "命令", "脚本"])) {
    topics.add("commands");
  }
  if (matchesAny(text, ["decision", "tradeoff", "rationale", "decided", "选择", "决定", "权衡", "原因"])) {
    topics.add("decisions");
  }
  if (matchesAny(text, ["bug", "issue", "risk", "error", "failed", "blocker", "问题", "风险", "失败", "报错"])) {
    topics.add("issues");
  }
  if (matchesAny(text, ["dependency", "package", "sdk", "version", "runtime", "依赖", "包", "版本"])) {
    topics.add("dependencies");
  }
  if (matchesAny(text, ["external-research", "opencli", "xiaohongshu", "twitter", "reddit", "web research", "调研", "小红书"])) {
    topics.add("external-research");
  }
  if (memory.scope === "session" || matchesAny(text, ["session", "transcript", "summary", "history", "会话", "历史", "摘要"])) {
    topics.add("sessions");
  }

  if (topics.size === 0) topics.add("general");
  return [...topics];
}

function isMemoryTopicId(value: string): value is MemoryTopicId {
  return MEMORY_TOPIC_DEFINITIONS.some((topic) => topic.id === value);
}

function matchesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 24);
}
