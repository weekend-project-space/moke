export type MessagingPlatform = 'weixin' | 'dingtalk' | 'feishu';

export type MessagingConnectionState =
  | 'stopped'
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'reauth_required'
  | 'error';

export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'quote'; message_id: string; text?: string }
  | {
      type: 'image';
      download_url?: string;
      encrypted_query_param?: string;
      aes_key?: string;
      aeskey?: string;
      data?: Uint8Array;
      name?: string;
    };

export type MessagingInboundEvent = {
  id: string;
  platform: MessagingPlatform;
  account_id: string;
  conversation: {
    id: string;
    type: 'direct' | 'group' | 'channel';
  };
  sender: {
    id: string;
    display_name?: string;
  };
  message: {
    id: string;
    segments: MessageSegment[];
    reply_to_id?: string;
  };
  occurred_at: string;
  context_token?: string;
};

export type InboundAck = {
  status: 'accepted' | 'duplicate' | 'ignored';
};

export type InteractionAck = {
  status: 'accepted' | 'already_resolved' | 'rejected' | 'invalid';
  message: string;
};

export type MessagingInteractionAction = {
  account_id: string;
  conversation_id?: string;
  sender_id?: string;
  interaction_id: string;
  option_id: string;
};

export type MessagingAdapterEvent =
  | { type: 'message'; message: MessagingInboundEvent }
  | { type: 'interaction'; action: MessagingInteractionAction };

export type MessagingAdapterAck = InboundAck | InteractionAck;

export type MessagingTarget = {
  account_id: string;
  conversation_id: string;
  context_token?: string;
};

export type MessagingDeliveryTarget = {
  account_id: string;
  binding_id: string;
  conversation: {
    id: string;
    type: 'direct' | 'group' | 'channel';
  };
  sender_id?: string;
};

export type OutboundMessage = {
  text: string;
  reply_to_id?: string;
};

export type OutboundContent =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; caption?: string }
  | { type: 'file'; path: string; name?: string; caption?: string };

/** Content passed to an adapter after the server has validated and read media. */
export type MessagingDeliveryContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: Uint8Array; name: string; mime_type: string; caption?: string }
  | { type: 'file'; data: Uint8Array; name: string; mime_type: string; caption?: string };

/** Platform-neutral outbound intent. Adapter packages render this intent for their platform. */
export type MessagingOutboundOperation =
  | { kind: 'message'; contents: MessagingDeliveryContent[]; reply_to_id?: string }
  | { kind: 'activity'; active: boolean }
  | {
      kind: 'status';
      phase: 'working' | 'waiting_input' | 'waiting_approval';
      title: string;
      detail?: string;
    }
  | {
      kind: 'interaction';
      interaction_id: string;
      interaction_kind?: 'ask' | 'approval';
      title: string;
      detail: string;
      options: Array<{ id: string; label: string }>;
      resolved?: { label: string };
    }
  | {
      kind: 'result';
      outcome: 'completed' | 'failed' | 'cancelled';
      text: string;
      message_already_delivered: boolean;
    };

export type MessagingDeliveryResult = {
  receipts: MessagingDeliveryReceipt[];
  /** Adapter-owned, JSON-persistable reference used to update a presentation. */
  reference?: Record<string, string>;
};

export type MessagingOutboundRequest = {
  binding_id: string;
  contents: OutboundContent[];
  idempotency_key: string;
  run_id?: string;
};

export type MessagingDeliveryReceipt = {
  type: OutboundContent['type'];
  platform_message_id?: string;
  delivered_at: string;
};

export type MessagingOutboundResult = {
  receipts: MessagingDeliveryReceipt[];
};

export type DeliveryReceipt = {
  platform_message_id?: string;
  delivered_at: string;
};

export type MessagingCapability =
  | 'receive.text'
  | 'receive.image'
  | 'receive.file'
  | 'send.text'
  | 'send.image'
  | 'send.file'
  | 'activity'
  | 'status'
  | 'interaction';

export type MessagingAccount = {
  id: string;
  platform: MessagingPlatform;
  name: string;
  enabled: boolean;
};

export type AdapterStatus = {
  state: MessagingConnectionState;
  changed_at: string;
  error?: {
    code: string;
    message: string;
  };
};

export type AdapterContext = {
  account: MessagingAccount;
  signal: AbortSignal;
  emit(event: MessagingAdapterEvent): Promise<MessagingAdapterAck>;
  updateStatus(status: AdapterStatus): Promise<void> | void;
  state: {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T): void;
    delete(key: string): void;
  };
};

export type MessagingAdapter = {
  readonly platform: MessagingPlatform;
  readonly capabilities: ReadonlySet<MessagingCapability>;
  start(context: AdapterContext): Promise<void>;
  stop(reason: 'user' | 'shutdown' | 'reauth' | 'error'): Promise<void>;
  getStatus(): AdapterStatus;
  deliver(
    target: MessagingDeliveryTarget,
    operation: MessagingOutboundOperation,
    previousReference?: Record<string, string>,
  ): Promise<MessagingDeliveryResult>;
};

export class MessagingDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'MessagingDeliveryError';
  }
}

export function splitMessagingText(value: string, limit: number) {
  const characters = Array.from(value);
  if (!Number.isFinite(limit) || limit < 1 || characters.length <= limit) return [value];
  const parts: string[] = [];
  for (let index = 0; index < characters.length; index += limit) parts.push(characters.slice(index, index + limit).join(''));
  return parts;
}
