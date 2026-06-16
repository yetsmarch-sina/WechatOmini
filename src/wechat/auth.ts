import fs from "node:fs";
import path from "node:path";
import { getBotQrCode, getQrCodeStatus } from "./api.js";
import type { TokenData } from "./types.js";
import type { Logger } from "../logger.js";

export function loadToken(storageDir: string): TokenData | undefined {
  const tokenPath = path.join(storageDir, "token.json");
  if (!fs.existsSync(tokenPath)) return undefined;
  return JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as TokenData;
}

export function saveToken(storageDir: string, token: TokenData): void {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "token.json"), JSON.stringify(token, null, 2), "utf-8");
}

export async function login(params: {
  baseUrl: string;
  botType: string;
  storageDir: string;
  log: Logger;
  renderQrUrl: (url: string) => void;
}): Promise<TokenData> {
  params.log("Starting WeChat QR login...");
  let qr = await getBotQrCode({ baseUrl: params.baseUrl, botType: params.botType });
  params.renderQrUrl(qr.qrcode_img_content);

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const status = await getQrCodeStatus({ baseUrl: params.baseUrl, qrcode: qr.qrcode });
    if (status.status === "expired") {
      params.log("QR expired, refreshing...");
      qr = await getBotQrCode({ baseUrl: params.baseUrl, botType: params.botType });
      params.renderQrUrl(qr.qrcode_img_content);
    } else if (status.status === "scaned") {
      params.log("QR scanned, confirm login in WeChat...");
    } else if (status.status === "confirmed") {
      if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
        throw new Error("Login confirmed but token response was incomplete");
      }
      const token: TokenData = {
        token: status.bot_token,
        baseUrl: status.baseurl ?? params.baseUrl,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        savedAt: new Date().toISOString(),
      };
      saveToken(params.storageDir, token);
      params.log(`WeChat login successful. Bot ID: ${token.accountId}`);
      return token;
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error("WeChat QR login timed out");
}
