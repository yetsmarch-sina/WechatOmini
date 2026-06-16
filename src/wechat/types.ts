export const MessageType = {
  USER: 1,
  BOT: 2,
} as const;

export const MessageState = {
  FINISH: 2,
} as const;

export const MessageItemType = {
  TEXT: 1,
} as const;

export interface WeChatMessageItem {
  type?: number;
  text_item?: {
    text?: string;
  };
}

export interface WeChatMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeChatMessageItem[];
  context_token?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeChatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface TokenData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
  savedAt: string;
}
