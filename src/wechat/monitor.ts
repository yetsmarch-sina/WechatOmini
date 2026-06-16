import fs from "node:fs";
import path from "node:path";
import { getUpdates } from "./api.js";
import { MessageItemType, MessageType, type WeChatMessage } from "./types.js";
import type { IncomingMessage } from "../types.js";
import type { Logger } from "../logger.js";

export async function startWeChatMonitor(params: {
  baseUrl: string;
  token: string;
  storageDir: string;
  signal: AbortSignal;
  log: Logger;
  onMessage: (message: IncomingMessage) => Promise<void>;
}): Promise<void> {
  let syncBuffer = loadSyncBuffer(params.storageDir);

  while (!params.signal.aborted) {
    try {
      const response = await getUpdates({
        baseUrl: params.baseUrl,
        token: params.token,
        syncBuffer,
      });

      if ((response.ret && response.ret !== 0) || (response.errcode && response.errcode !== 0)) {
        params.log(`WeChat getupdates error: ret=${response.ret} errcode=${response.errcode} ${response.errmsg ?? ""}`);
        await sleep(2_000, params.signal);
        continue;
      }

      if (response.get_updates_buf) {
        syncBuffer = response.get_updates_buf;
        saveSyncBuffer(params.storageDir, syncBuffer);
      }

      for (const raw of response.msgs ?? []) {
        const message = convertIncoming(raw);
        if (message) {
          await params.onMessage(message);
        }
      }
    } catch (error) {
      if (params.signal.aborted) return;
      params.log(`WeChat monitor error: ${String(error)}`);
      await sleep(2_000, params.signal);
    }
  }
}

function convertIncoming(message: WeChatMessage): IncomingMessage | undefined {
  if (message.message_type !== MessageType.USER) return undefined;
  if (message.group_id) return undefined;
  if (!message.from_user_id) return undefined;

  const parts = (message.item_list ?? [])
    .filter((item) => item.type === MessageItemType.TEXT)
    .map((item) => item.text_item?.text?.trim())
    .filter((text): text is string => !!text);

  if (parts.length === 0) return undefined;

  return {
    userId: message.from_user_id,
    contextToken: message.context_token,
    text: parts.join("\n"),
    source: "wechat",
  };
}

function loadSyncBuffer(storageDir: string): string {
  const file = path.join(storageDir, "sync-buffer.json");
  if (!fs.existsSync(file)) return "";
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { syncBuffer?: string };
  return parsed.syncBuffer ?? "";
}

function saveSyncBuffer(storageDir: string, syncBuffer: string): void {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "sync-buffer.json"), JSON.stringify({ syncBuffer }), "utf-8");
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
