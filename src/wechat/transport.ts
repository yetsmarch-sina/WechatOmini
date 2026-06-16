import { sendTextMessage } from "./api.js";
import type { TokenData } from "./types.js";
import type { MessageTransport, ReplyTarget } from "../types.js";

const MAX_WECHAT_TEXT_LENGTH = 3500;
const SEGMENT_DELAY_MS = 150;

export class WeChatTransport implements MessageTransport {
  constructor(private readonly token: TokenData) {}

  async sendReply(target: ReplyTarget, text: string): Promise<void> {
    if (!target.contextToken) {
      throw new Error("Cannot send WeChat reply without context token");
    }

    const segments = splitText(text, MAX_WECHAT_TEXT_LENGTH);
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, SEGMENT_DELAY_MS));
      }
      await sendTextMessage({
        baseUrl: this.token.baseUrl,
        token: this.token.token,
        toUserId: target.userId,
        contextToken: target.contextToken,
        text: segments[i]!,
      });
    }
  }
}

function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const segments: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      segments.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf("\n", maxLength);
    if (breakAt <= 0) breakAt = maxLength;
    segments.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).replace(/^\n/, "");
  }
  return segments;
}
