export type MessagingPlatform = 'weixin';

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
    };

export type MessagingInboundEvent = {
  id: string;
  platform: MessagingPlatform;
  account_id: string;
  conversation: {
    id: string;
    type: 'direct';
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

export type MessagingTarget = {
  account_id: string;
  conversation_id: string;
  context_token?: string;
};

export type OutboundMessage = {
  text: string;
  reply_to_id?: string;
};

export type OutboundContent =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; caption?: string }
  | { type: 'file'; path: string; name?: string; caption?: string };

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

export type MessagingCapabilities = {
  direct: boolean;
  group: boolean;
  proactive: 'none' | 'recent-contact-only' | 'all';
  edit_message: boolean;
  streaming_update: boolean;
  buttons: boolean;
  markdown: boolean;
  image: boolean;
  file: boolean;
  audio_receive: boolean;
  video_receive: boolean;
  typing: boolean;
  quote: boolean;
  max_text_length: number;
};

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
  emit(event: MessagingInboundEvent): Promise<InboundAck>;
  updateStatus(status: AdapterStatus): Promise<void> | void;
};

export type MessagingAdapter = {
  readonly platform: MessagingPlatform;
  readonly capabilities: MessagingCapabilities;
  start(context: AdapterContext): Promise<void>;
  stop(reason: 'user' | 'shutdown' | 'reauth' | 'error'): Promise<void>;
  getStatus(): AdapterStatus;
  send(target: MessagingTarget, message: OutboundMessage): Promise<DeliveryReceipt>;
};
