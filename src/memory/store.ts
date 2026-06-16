import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { newId, nowIso } from "../util/ids.js";

export type MemoryScope = "global" | "user" | "workspace" | "session";

export interface WorkspaceRecord {
  id: string;
  agent: string;
  cwd: string;
  status: string;
  pid?: number;
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

  constructor(databasePath: string) {
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
        JSON.stringify(input.tags ?? []),
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
    limit?: number;
  }): MemoryRecord[] {
    const query = params.query.trim();
    if (!query) return [];

    const like = `%${query}%`;
    const where = [
      "(content LIKE ? OR tags LIKE ?)",
      "(scope = 'global' OR (scope = 'user' AND user_id = ?) OR (scope = 'workspace' AND workspace_id = ?) OR (scope = 'session' AND workspace_id = ?))",
    ];
    const values: Array<string | number | null> = [
      like,
      like,
      params.userId ?? null,
      params.workspaceId ?? null,
      params.workspaceId ?? null,
    ];

    if (params.scope) {
      where.push("scope = ?");
      values.push(params.scope);
    }

    values.push(params.limit ?? 8);

    const rows = this.db
      .prepare(
        `SELECT *
         FROM memories
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...values);

    return rows.map(mapMemory);
  }

  getContext(params: { workspaceId: string; userId: string; query: string; limit?: number }): ContextBundle {
    const workspace = this.getWorkspace(params.workspaceId);
    return {
      workspace,
      sessionSummary: this.getSessionSummary(params.workspaceId),
      memories: this.searchMemories({
        query: params.query,
        workspaceId: params.workspaceId,
        userId: params.userId,
        limit: params.limit ?? 8,
      }),
    };
  }

  private getMemory(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? mapMemory(row) : undefined;
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
  }
}

type SqlRow = Record<string, SQLOutputValue>;

function mapWorkspace(row: SqlRow): WorkspaceRecord {
  return {
    id: readString(row, "id"),
    agent: readString(row, "agent"),
    cwd: readString(row, "cwd"),
    status: readString(row, "status"),
    pid: readOptionalNumber(row, "pid"),
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
