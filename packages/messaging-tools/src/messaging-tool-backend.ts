import type {
  MessagingOutboundRequest,
  MessagingOutboundResult,
  MessagingPlatform,
  OutboundContent,
} from '@moke/messaging-core';

export type ResolvedMessagingTarget = {
  bindingId: string;
  platform: MessagingPlatform;
  connectionId: string;
  conversationId: string;
  conversationType: 'direct' | 'group' | 'channel';
};

export type MessagingTargetResolution =
  | { status: 'resolved'; target: ResolvedMessagingTarget }
  | { status: 'not_found' }
  | { status: 'ambiguous'; count: number };

export type MessagingOutboundAccess = {
  workspaceRoot: string;
  approvedRoots?: string[];
};

export type MessagingToolBackend = {
  getTarget(bindingId: string): ResolvedMessagingTarget | undefined;
  resolveTarget(input: { platform: MessagingPlatform; sessionId: string }): MessagingTargetResolution;
  validateMediaPaths(contents: OutboundContent[], access: MessagingOutboundAccess): Promise<void>;
  send(input: MessagingOutboundRequest, access: MessagingOutboundAccess): Promise<MessagingOutboundResult>;
};
