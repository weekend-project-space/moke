import type { InboundAck, MessagingInboundEvent } from '@moke/messaging-core';
import type { ResolvedImageAttachment } from '@moke/protocol';
import { downloadWeixinImage } from '@moke/messaging-weixin';
import { SessionApplicationService } from '../session-application-service.js';
import { JsonMessagingStore } from '../../storage/messaging-store.js';
import { AttachmentStore, toStoredAttachment } from '../../storage/attachment-store.js';

export class MessagingGateway {
  private readonly draining = new Set<string>();
  private onRunStarted: ((input: { connectionId: string; bindingId: string; runId: string }) => void) | undefined;

  constructor(
    private readonly store: JsonMessagingStore,
    private readonly sessions: SessionApplicationService,
    private readonly attachments: AttachmentStore,
  ) {}

  setRunStartedListener(listener: (input: { connectionId: string; bindingId: string; runId: string }) => void) {
    this.onRunStarted = listener;
  }

  async accept(event: MessagingInboundEvent): Promise<InboundAck> {
    if (event.platform !== 'weixin' && event.platform !== 'dingtalk' && event.platform !== 'feishu') return { status: 'ignored' };
    if (this.store.claimInbound(event.account_id, event.message.id, event.platform) === 'duplicate') return { status: 'duplicate' };

    try {
      if (event.context_token) {
        this.store.saveContextToken({
          connectionId: event.account_id,
          peerUserId: event.conversation.id,
          token: event.context_token,
          messageId: event.message.id,
        });
      }
      let binding = this.store.findBinding(event.account_id, event.conversation.id, event.platform);
      if (!binding) {
        const session = this.sessions.createSession({
          title: event.platform === 'dingtalk'
            ? 'DingTalk conversation'
            : event.platform === 'feishu' ? 'Feishu conversation' : 'WeChat contact',
          metadata: { messaging: { platform: event.platform, connection_id: event.account_id } },
        });
        binding = this.store.createBinding({
          connectionId: event.account_id,
          conversationId: event.conversation.id,
          sessionId: session.id,
          platform: event.platform,
        });
      }
      const text = event.message.segments
        .map((segment) => segment.type === 'text' ? segment.text : '')
        .filter(Boolean)
        .join('\n')
        .trim();
      const attachments = event.platform === 'weixin' || event.platform === 'feishu' ? await this.resolveImages(event) : [];
      if (!text && attachments.length === 0) {
        this.store.completeInbound(event.account_id, event.message.id, event.platform);
        return { status: 'ignored' };
      }
      this.store.enqueueInbound(binding.id, {
        message_id: event.message.id,
        content: text,
        ...(attachments.length ? { attachments: attachments.map(toStoredAttachment) } : {}),
      });
      this.store.markBindingInbound(binding.id, event.message.id, event.sender.id);
      this.store.recordInbound(event.account_id, event.platform);
      this.store.completeInbound(event.account_id, event.message.id, event.platform);
      await this.drain(binding.id);
      return { status: 'accepted' };
    } catch (error) {
      throw error;
    }
  }

  async resumeQueued() {
    for (const bindingId of this.store.recoverQueuedBindings()) {
      await this.drain(bindingId);
    }
  }

  async completeRun(input: { bindingId: string; runId: string }) {
    if (!this.store.completeQueuedRun(input.bindingId, input.runId)) return;
    await this.drain(input.bindingId);
  }

  private async drain(bindingId: string) {
    if (this.draining.has(bindingId)) return;
    this.draining.add(bindingId);
    let continueDraining = false;
    try {
      const item = this.store.claimNextQueued(bindingId);
      if (!item) return;
      const binding = this.store.getBinding(bindingId);
      if (!binding) throw new Error(`Messaging binding is missing: ${bindingId}`);
      const session = this.sessions.getSession(binding.session_id);
      if (!session) throw new Error(`Bound session is missing: ${binding.session_id}`);
      let attachments: ResolvedImageAttachment[];
      try {
        attachments = item.attachments?.map((attachment) => this.attachments.resolve(attachment)) || [];
      } catch (error) {
        this.store.discardQueuedMessage(bindingId, item.message_id);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[messaging] discarded invalid queued attachments binding=${bindingId} message=${item.message_id}: ${message}`);
        continueDraining = true;
        return;
      }
      const result = this.sessions.acceptUserMessage({
        session,
        content: item.content,
        attachments,
        source: {
          kind: 'messaging',
          platform: binding.platform,
          connection_id: binding.account_id,
          message_id: item.message_id,
        },
        options: {
          origin: {
            kind: 'messaging',
            platform: binding.platform,
            connection_id: binding.account_id,
            binding_id: binding.id,
            inbound_message_id: item.message_id,
          },
          beforeStart: (run) => {
            if (!this.store.setQueuedRun(bindingId, item.message_id, run.id)) {
              throw new Error(`Messaging queue item was lost before run start: ${bindingId}/${item.message_id}`);
            }
            this.onRunStarted?.({ connectionId: binding.account_id, bindingId: binding.id, runId: run.id });
          },
        },
      });
      console.info(`[messaging] run started binding=${bindingId} message=${item.message_id} run=${result.runId}`);
    } finally {
      this.draining.delete(bindingId);
      if (continueDraining) queueMicrotask(() => void this.drain(bindingId));
    }
  }

  private async resolveImages(event: MessagingInboundEvent): Promise<ResolvedImageAttachment[]> {
    const imageSegments = event.message.segments.filter((segment) => segment.type === 'image').slice(0, 4);
    let totalBytes = 0;
    const images = await Promise.all(imageSegments.map(async (segment, index) => {
      try {
        const data = segment.data
          ? Buffer.from(segment.data)
          : await downloadWeixinImage({
              downloadUrl: segment.download_url,
              encryptedQueryParam: segment.encrypted_query_param,
              aesKey: segment.aes_key,
              aeskey: segment.aeskey,
            });
        totalBytes += data.length;
        if (totalBytes > 5 * 1024 * 1024) throw new Error('Messaging image attachments are too large');
        return this.attachments.saveInboundImage(data, segment.name || `${event.platform}-${event.message.id}-${index + 1}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[messaging] image download failed message=${event.message.id}: ${message}`);
        return null;
      }
    }));
    return images.filter((image): image is ResolvedImageAttachment => image !== null);
  }
}
