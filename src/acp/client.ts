import fs from "node:fs/promises";
import type * as acp from "@agentclientprotocol/sdk";
import type { Logger } from "../logger.js";

export class AcpClient implements acp.Client {
  private readonly chunks: string[] = [];
  private readonly thoughts: string[] = [];
  private producedText = false;

  constructor(
    private readonly log: Logger,
    private readonly onTyping?: () => Promise<void>,
  ) {}

  get hasProducedText(): boolean {
    return this.producedText;
  }

  startTurn(): void {
    this.chunks.length = 0;
    this.thoughts.length = 0;
    this.producedText = false;
  }

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const allowOption = params.options.find(
      (option) => option.kind === "allow_once" || option.kind === "allow_always",
    );
    const optionId = allowOption?.optionId ?? params.options[0]?.optionId ?? "allow";
    this.log(`[permission] auto-allowed ${params.toolCall?.title ?? "tool"} with ${optionId}`);
    return {
      outcome: {
        outcome: "selected",
        optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.chunks.push(update.content.text);
          if (update.content.text.trim()) {
            this.producedText = true;
          }
        }
        await this.onTyping?.();
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.thoughts.push(update.content.text);
        }
        await this.onTyping?.();
        break;
      case "tool_call":
        this.log(`[tool] ${update.title} (${update.status})`);
        await this.onTyping?.();
        break;
      case "tool_call_update":
        if (update.status) {
          this.log(`[tool] ${update.toolCallId} -> ${update.status}`);
        }
        await this.onTyping?.();
        break;
      case "plan":
        if (update.entries?.length) {
          const items = update.entries.map((entry, index) => `${index + 1}. [${entry.status}] ${entry.content}`);
          this.log(`[plan]\n${items.join("\n")}`);
        }
        await this.onTyping?.();
        break;
      case "config_option_update":
        this.log(`[config] ${update.configOptions.length} config option(s) updated`);
        break;
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.readFile(params.path, "utf-8");
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.writeFile(params.path, params.content, "utf-8");
    return {};
  }

  flush(): string {
    const text = this.chunks.join("");
    this.chunks.length = 0;
    this.thoughts.length = 0;
    return text;
  }
}
