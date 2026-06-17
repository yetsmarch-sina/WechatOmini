import crypto from "node:crypto";
import { MessageState, MessageType, type GetUpdatesResponse, type WeChatMessage } from "./types.js";

const CHANNEL_VERSION = "1.0.2";

export class WeChatApiTimeoutError extends Error {
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`WeChat API ${path} timed out after ${timeoutMs}ms`);
    this.name = "WeChatApiTimeoutError";
  }
}

function headers(token?: string): Record<string, string> {
  const result: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64"),
  };
  if (token) {
    result.Authorization = `Bearer ${token}`;
  }
  return result;
}

async function getJson<T>(baseUrl: string, path: string, token?: string): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/${path}`, { headers: headers(token) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`WeChat API HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function postJson<T>(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ ...body, base_info: { channel_version: CHANNEL_VERSION } }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`WeChat API HTTP ${response.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  } catch (error) {
    if (isAbortError(error)) {
      throw new WeChatApiTimeoutError(path, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export async function getBotQrCode(params: {
  baseUrl: string;
  botType: string;
}): Promise<{ qrcode: string; qrcode_img_content: string }> {
  return getJson(params.baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${params.botType}`);
}

export async function getQrCodeStatus(params: {
  baseUrl: string;
  qrcode: string;
}): Promise<{
  status: string;
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}> {
  return getJson(params.baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`);
}

export async function getUpdates(params: {
  baseUrl: string;
  token: string;
  syncBuffer: string;
  timeoutMs?: number;
}): Promise<GetUpdatesResponse> {
  return postJson<GetUpdatesResponse>(
    params.baseUrl,
    "ilink/bot/getupdates",
    { get_updates_buf: params.syncBuffer },
    params.token,
    params.timeoutMs ?? 35_000,
  );
}

export async function sendTextMessage(params: {
  baseUrl: string;
  token: string;
  toUserId: string;
  contextToken: string;
  text: string;
  clientId?: string;
}): Promise<string> {
  const clientId = params.clientId ?? `wechat-acp-manager-${crypto.randomUUID()}`;
  const msg: WeChatMessage = {
    from_user_id: "",
    to_user_id: params.toUserId,
    client_id: clientId,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: params.contextToken,
    item_list: [{ type: 1, text_item: { text: params.text } }],
  };

  await postJson(
    params.baseUrl,
    "ilink/bot/sendmessage",
    { msg },
    params.token,
  );
  return clientId;
}
