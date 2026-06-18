import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AgentKind } from "./types.js";

export interface AgentPreset {
  kind: AgentKind;
  label: string;
  command: string;
  args: string[];
}

export interface AppConfig {
  storageDir: string;
  configPath: string;
  databasePath: string;
  defaultUserId: string;
  verbose: boolean;
  plugins: {
    mode: "managed" | "copilot-native";
    marketDirs: string[];
  };
  copilot: {
    extraArgs: string[];
  };
  wechat: {
    enabled: boolean;
    baseUrl: string;
    botType: string;
  };
}

const BASE_AGENT_PRESETS: Record<AgentKind, AgentPreset> = {
  copilot: {
    kind: "copilot",
    label: "GitHub Copilot",
    command: "copilot",
    args: ["--acp", "--yolo"],
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
  configPath?: string;
}

interface FileConfig {
  pluginMode?: "managed" | "copilot-native";
  pluginMarketDirs?: string[];
  copilot?: {
    extraArgs?: string[];
  };
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
      case "--config":
        parsed.configPath = requireValue(args, ++i, "--config");
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
  const configPath = path.resolve(args.configPath ?? path.join(storageDir, "config.json"));
  const fileConfig = loadOrCreateFileConfig(configPath, defaultFileConfig());
  const pluginMarketDirs = resolvePluginMarketDirs(fileConfig.pluginMarketDirs);
  return {
    storageDir,
    configPath,
    databasePath: path.join(storageDir, "manager.db"),
    defaultUserId: "local-user",
    verbose: args.verbose,
    plugins: {
      mode: fileConfig.pluginMode ?? "managed",
      marketDirs: pluginMarketDirs,
    },
    copilot: {
      extraArgs: normalizeStringArray(fileConfig.copilot?.extraArgs, ["--enable-all-github-mcp-tools"]),
    },
    wechat: {
      enabled: args.wechat,
      baseUrl: process.env.WECHAT_ACP_BASE_URL ?? "https://ilinkai.weixin.qq.com",
      botType: process.env.WECHAT_ACP_BOT_TYPE ?? "3",
    },
  };
}

export function buildAgentPreset(kind: AgentKind, config: AppConfig): AgentPreset | undefined {
  const base = BASE_AGENT_PRESETS[kind];
  if (!base) return undefined;
  if (kind !== "copilot") {
    return { ...base, args: [...base.args] };
  }

  const args = [...base.args, ...config.copilot.extraArgs];
  if (config.plugins.mode === "copilot-native") {
    for (const pluginDir of listPluginDirs(config.plugins.marketDirs)) {
      args.push("--plugin-dir", pluginDir);
    }
  }
  return { ...base, args };
}

export function supportedAgents(): AgentKind[] {
  return Object.keys(BASE_AGENT_PRESETS) as AgentKind[];
}

export function usage(): string {
  return `wechat-acp-manager

Usage:
  wechat-acp-manager [--local] [--storage-dir <dir>] [--config <file>] [--verbose]
  wechat-acp-manager --wechat [--login] [--storage-dir <dir>] [--config <file>] [--verbose]

MVP commands inside chat/local stdin:
  /workspace open <id> <copilot|opencode> <cwd> [--create]
  /workspace confirm-create
  /workspace cancel-create
  /workspace use <id>
  /workspace list
  /workspace current
  /workspace stop <id>
  # /workspace current shows the captured Copilot resume id/command when available.
  /memory remember <text>
  /memory search [--all] <query>
  /memory topics [--all]
  /cancel
  /exit                            Exit local mode

Local mode is the default and is intended for validating manager/ACP behavior before wiring WeChat.
`;
}

export function listPluginDirs(marketDirs: string[]): string[] {
  const dirs: string[] = [];
  for (const marketDir of marketDirs) {
    if (!fs.existsSync(marketDir) || !fs.statSync(marketDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(marketDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(marketDir, entry.name);
      const manifestPath = path.join(pluginDir, "plugin.json");
      if (fs.existsSync(manifestPath)) {
        dirs.push(pluginDir);
      }
    }
  }
  return dirs;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function defaultFileConfig(): FileConfig {
  return {
    pluginMode: "managed",
    pluginMarketDirs: [path.resolve(process.cwd(), "..", "pluginmarket")],
    copilot: {
      extraArgs: ["--enable-all-github-mcp-tools"],
    },
  };
}

function loadOrCreateFileConfig(configPath: string, fallback: FileConfig): FileConfig {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(fallback, null, 2)}\n`, "utf-8");
    return fallback;
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Config file must contain a JSON object: ${configPath}`);
  }
  const value = parsed as FileConfig;
  if (value.pluginMode && value.pluginMode !== "managed" && value.pluginMode !== "copilot-native") {
    throw new Error(`Invalid pluginMode in ${configPath}: ${value.pluginMode}`);
  }
  if (value.pluginMarketDirs && !Array.isArray(value.pluginMarketDirs)) {
    throw new Error(`pluginMarketDirs must be an array in ${configPath}`);
  }
  if (value.copilot?.extraArgs && !Array.isArray(value.copilot.extraArgs)) {
    throw new Error(`copilot.extraArgs must be an array in ${configPath}`);
  }
  return value;
}

function resolvePluginMarketDirs(dirs: string[] | undefined): string[] {
  return normalizeStringArray(dirs, [path.resolve(process.cwd(), "..", "pluginmarket")])
    .map((dir) => path.resolve(dir));
}

function normalizeStringArray(value: string[] | undefined, fallback: string[]): string[] {
  const source = value && value.length > 0 ? value : fallback;
  return source.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}
