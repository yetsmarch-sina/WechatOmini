import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { WorkspaceManager } from "../manager/workspace-manager.js";
import type { MessageTransport, ReplyTarget } from "../types.js";

export class LocalTransport implements MessageTransport {
  async sendReply(_target: ReplyTarget, text: string): Promise<void> {
    console.log(`\nagent> ${text}\n`);
  }

  async sendTyping(): Promise<void> {
    console.log("agent> ...");
  }
}

export async function startLocalInput(manager: WorkspaceManager, userId: string): Promise<void> {
  const rl = readline.createInterface({ input, output });
  console.log("Local mode started. Send /help for commands. Ctrl+C to exit.");

  try {
    while (true) {
      const line = await rl.question("you> ");
      if (line.trim() === "/exit") break;
      if (!line.trim()) continue;
      await manager.handleIncoming({
        userId,
        text: line,
        source: "local",
      });
    }
  } finally {
    rl.close();
  }
}
