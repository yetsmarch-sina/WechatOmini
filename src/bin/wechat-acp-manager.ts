#!/usr/bin/env node

import qrcodeTerminal from "qrcode-terminal";
import { buildConfig, parseArgs, usage } from "../config.js";
import { createLogger } from "../logger.js";
import { LocalTransport, startLocalInput } from "../adapters/local.js";
import { login, loadToken } from "../wechat/auth.js";
import { startWeChatMonitor } from "../wechat/monitor.js";
import { WeChatTransport } from "../wechat/transport.js";
import type { WorkspaceManager as WorkspaceManagerInstance } from "../manager/workspace-manager.js";

process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  console.warn(warning);
});

async function main(): Promise<void> {
  const [{ MemoryStore }, { WorkspaceManager }] = await Promise.all([
    import("../memory/store.js"),
    import("../manager/workspace-manager.js"),
  ]);

  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const config = buildConfig(args);
  const log = createLogger(config.verbose);
  const store = new MemoryStore(config.databasePath);
  let manager: WorkspaceManagerInstance | undefined;
  const abort = new AbortController();

  const shutdown = async () => {
    abort.abort();
    await manager?.stop();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (args.wechat) {
    const token =
      args.login || !loadToken(config.storageDir)
        ? await login({
            baseUrl: config.wechat.baseUrl,
            botType: config.wechat.botType,
            storageDir: config.storageDir,
            log,
            renderQrUrl: (url) => {
              qrcodeTerminal.generate(url, { small: true }, (qr) => console.log(qr));
            },
          })
        : loadToken(config.storageDir)!;

    const transport = new WeChatTransport(token);
    manager = new WorkspaceManager(store, transport, log, config);
    log("WeChat mode started. Send /help to the bot for commands.");
    await startWeChatMonitor({
      baseUrl: token.baseUrl,
      token: token.token,
      storageDir: config.storageDir,
      signal: abort.signal,
      log,
      onMessage: (message) => manager!.handleIncoming(message),
    });
    return;
  }

  const transport = new LocalTransport();
  manager = new WorkspaceManager(store, transport, log, config);
  await startLocalInput(manager, config.defaultUserId);
}

main().catch((error) => {
  console.error(`Fatal: ${String(error)}`);
  process.exit(1);
});
