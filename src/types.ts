export interface IncomingMessage {
  userId: string;
  contextToken?: string;
  text: string;
  source: "local" | "wechat";
}

export interface ReplyTarget {
  userId: string;
  contextToken?: string;
}

export interface MessageTransport {
  sendReply(target: ReplyTarget, text: string): Promise<void>;
  sendTyping?(target: ReplyTarget): Promise<void>;
}

export type AgentKind = "copilot" | "opencode";

export type WorkspaceStatus = "running" | "stopped" | "exited" | "failed";
