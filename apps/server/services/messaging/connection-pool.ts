import { MessagingDeliveryError } from '@moke/messaging-core';
import type {
  AdapterContext,
  AdapterStatus,
  MessagingAdapter,
  MessagingAdapterAck,
  MessagingAdapterEvent,
  MessagingDeliveryResult,
  MessagingDeliveryTarget,
  MessagingOutboundOperation,
} from '@moke/messaging-core';

import {
  type MessagingConnectionRecord,
  type MessagingBinding,
  type MessagingStore,
  type PublicMessagingConnection,
} from '../../storage/messaging-store.js';

export type MessagingAdapterFactory = (
  connection: MessagingConnectionRecord,
  secret: string,
) => MessagingAdapter;

type ActiveAdapter = {
  adapter: MessagingAdapter;
  controller: AbortController;
};

/** Owns live adapters only. Queueing, delivery retries and Run lifecycle belong to MessagingRuntime. */
export class MessagingConnectionPool {
  private readonly adapters = new Map<string, ActiveAdapter>();
  private readonly factories = new Map<MessagingConnectionRecord['platform'], MessagingAdapterFactory>();
  private onEvent: ((event: MessagingAdapterEvent) => Promise<MessagingAdapterAck>) | undefined;

  constructor(private readonly store: MessagingStore) {}

  register(platform: MessagingConnectionRecord['platform'], factory: MessagingAdapterFactory) {
    if (this.factories.has(platform)) throw new Error(`Messaging adapter factory already registered: ${platform}`);
    this.factories.set(platform, factory);
    return this;
  }

  setEventHandler(handler: (event: MessagingAdapterEvent) => Promise<MessagingAdapterAck>) {
    this.onEvent = handler;
  }

  async startEnabled() {
    for (const connection of this.store.listConnections()) {
      if (connection.enabled) await this.startSafely(connection.id, () => this.start(connection.id));
    }
  }

  async start(connectionId: string): Promise<PublicMessagingConnection | null> {
    const connection = this.store.getConnection(connectionId);
    if (!connection) return null;
    if (this.adapters.has(connectionId)) return this.store.getPublicConnection(connectionId);
    const factory = this.factories.get(connection.platform);
    if (!factory) {
      this.store.updateConnectionState(connectionId, {
        state: 'error',
        error: { code: 'MESSAGING_ADAPTER_NOT_REGISTERED', message: `No adapter factory is registered for ${connection.platform}` },
      });
      throw new Error(`No adapter factory is registered for ${connection.platform}`);
    }
    const secret = this.store.getConnectionSecret(connection);
    if (!secret) {
      this.store.updateConnectionState(connectionId, {
        state: 'reauth_required',
        error: { code: 'MESSAGING_AUTH_MISSING', message: `Credentials are missing for ${connection.platform}` },
      });
      throw new Error(`Credentials are missing for ${connection.platform}`);
    }
    const adapter = factory(connection, secret);
    const controller = new AbortController();
    this.adapters.set(connectionId, { adapter, controller });
    try {
      const context: AdapterContext = {
        account: { id: connection.id, platform: connection.platform, name: connection.name, enabled: connection.enabled },
        signal: controller.signal,
        emit: async (event) => this.onEvent ? this.onEvent(event) : { status: 'ignored' as const },
        updateStatus: (status) => this.updateStatus(connectionId, status),
        state: {
          get: <T>(key: string) => this.store.getAdapterState<T>(connectionId, key),
          set: <T>(key: string, value: T) => this.store.setAdapterState(connectionId, key, value),
          delete: (key: string) => this.store.deleteAdapterState(connectionId, key),
        },
      };
      await adapter.start(context);
    } catch (error) {
      controller.abort();
      this.adapters.delete(connectionId);
      throw error;
    }
    return this.store.getPublicConnection(connectionId);
  }

  async stop(connectionId: string, reason: 'user' | 'shutdown' | 'reauth' = 'user') {
    const active = this.adapters.get(connectionId);
    if (active) {
      active.controller.abort();
      await active.adapter.stop(reason);
      this.adapters.delete(connectionId);
    }
    const connection = this.store.getConnection(connectionId);
    if (connection && connection.state !== 'reauth_required' && connection.state !== 'error') {
      this.store.updateConnectionState(connectionId, { state: 'stopped' });
    }
  }

  async remove(connectionId: string) {
    try {
      await this.stop(connectionId);
    } catch (error) {
      console.warn(`[messaging] connection stop failed during removal id=${connectionId}: ${errorMessage(error)}`);
    }
    this.adapters.delete(connectionId);
    this.store.deleteConnection(connectionId);
  }

  async deliver(
    binding: MessagingBinding,
    operation: MessagingOutboundOperation,
    previousReference?: Record<string, string>,
  ): Promise<MessagingDeliveryResult> {
    const active = this.adapters.get(binding.account_id);
    if (!active || active.adapter.platform !== binding.platform) {
      throw new MessagingDeliveryError('CONNECTION_NOT_ACTIVE', `${binding.platform} connection is not active`, true);
    }
    const target: MessagingDeliveryTarget = {
      account_id: binding.account_id,
      binding_id: binding.id,
      conversation: { id: binding.conversation_id, type: binding.conversation_type },
      ...(binding.last_sender_id ? { sender_id: binding.last_sender_id } : {}),
    };
    const result = await active.adapter.deliver(target, operation, previousReference);
    this.store.recordOutbound(binding.account_id, binding.platform);
    return result;
  }

  async close() {
    await Promise.all([...this.adapters.keys()].map((connectionId) => this.stop(connectionId, 'shutdown')));
  }

  private updateStatus(connectionId: string, status: AdapterStatus) {
    this.store.updateConnectionState(connectionId, { state: status.state, error: status.error });
    if (status.state === 'reauth_required' || status.state === 'error') {
      const active = this.adapters.get(connectionId);
      active?.controller.abort();
      this.adapters.delete(connectionId);
    }
  }

  private async startSafely(connectionId: string, start: () => Promise<unknown>) {
    try {
      await start();
    } catch (error) {
      console.warn(`[messaging] connection start failed id=${connectionId}: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
