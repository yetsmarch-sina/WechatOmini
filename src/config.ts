import os from "node:os";
import path from "node:path";
import type { AgentKind } from "./types.js";

export interface AgentPreset {
  kind: AgentKind;
  label: string;
  command: string;
  args: string[];
}

export interface AppConfig {
  storageDir: string;
  databasePath: string;
  defaultUserId: string;
  verbose: boolean;
  wechat: {
    enabled: boolean;
    baseUrl: string;
    botType: string;
  };
}

export const AGENT_PRESETS: Record<AgentKind, AgentPreset> = {
  copilot: {
    kind: "copilot",
    label: "GitHub Copilot",
    command: "npx",
    args: ["@github/copilot", "--acp", "--yolo", "--enable-all-github-mcp-tools"],
  },
  opencode: {
    kind: "opencode",
    label: "OpenCode",
    command: "npx",
    args: ["opencode-ai", "acp"],
  },
};

export interface ParsedArgs {
  help: boolean;
  verbose: boolean;
  storageDir?: string;
  local: boolean;
  wechat: boolean;
  login: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    verbose: false,
    local: false,
    wechat: false,
    login: false,
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--verbose":
      case "-v":
        parsed.verbose = true;
        break;
      case "--storage-dir":
        parsed.storageDir = requireValue(args, ++i, "--storage-dir");
        break;
      case "--local":
        parsed.local = true;
        break;
      case "--wechat":
        parsed.wechat = true;
        break;
      case "--login":
        parsed.login = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.local && !parsed.wechat) {
    parsed.local = true;
  }

  return parsed;
}

export function buildConfig(args: ParsedArgs): AppConfig {
  const storageDir = path.resolve(args.storageDir ?? path.join(os.homedir(), ".wechat-acp-manager"));
  return {
    storageDir,
    databasePath: path.join(storageDir, "manager.db"),
    defaultUserId: "local-user",
    verbose: args.verbose,
    wechat: {
      enabled: args.wechat,
      baseUrl: process.env.WECHAT_ACP_BASE_URL ?? "https://ilinkai.weixin.qq.com",
      botType: process.env.WECHAT_ACP_BOT_TYPE ?? "3",
    },
  };
}

export function usage(): string {
  return `wechat-acp-manager

Usage:
  wechat-acp-manager [--local] [--storage-dir <dir>] [--verbose]
  wechat-acp-manager --wechat [--login] [--storage-dir <dir>] [--verbose]

MVP commands inside chat/local stdin:
  /workspace open <id> <copilot|opencode> <cwd>
  /workspace use <id>
  /workspace list
  /workspace current
  /workspace stop <id>
  /memory remember <text>
  /memory search [--all] <query>
  /memory topics [--all]
  /cancel
  /exit                            Exit local mode

Local mode is the default and is intended for validating manager/ACP behavior before wiring WeChat.
`;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}
