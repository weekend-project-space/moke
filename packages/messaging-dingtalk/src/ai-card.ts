const DINGTALK_API = 'https://api.dingtalk.com';
const AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema';

export type DingTalkCardTarget =
  | { type: 'user'; userId: string }
  | { type: 'group'; conversationId: string };

export type DingTalkCardInstance = {
  id: string;
  started: boolean;
};

export class DingTalkAiCardService {
  constructor(
    private readonly robotCode: string,
    private readonly getToken: () => Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async create(target: DingTalkCardTarget, content: string, options: { templateId?: string; params?: Record<string, unknown>; callbackRouteKey?: string } = {}): Promise<DingTalkCardInstance> {
    const token = await this.getToken();
    const id = `moke_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const cardParamMap = options.templateId
      ? { config: cardConfig(), msgContent: content, ...options.params }
      : defaultCardParams(content, '2');
    await this.request('POST', '/v1.0/card/instances', token, {
      cardTemplateId: options.templateId || AI_CARD_TEMPLATE_ID,
      outTrackId: id,
      cardData: { cardParamMap },
      callbackType: 'STREAM',
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
      ...(options.callbackRouteKey ? { callbackRouteKey: options.callbackRouteKey } : {}),
    });
    await this.request('POST', '/v1.0/card/instances/deliver', token, deliverBody(id, target, this.robotCode));
    return { id, started: false };
  }

  async update(card: DingTalkCardInstance, content: string, finished = false) {
    const token = await this.getToken();
    if (!card.started) {
      await this.request('PUT', '/v1.0/card/instances', token, {
        outTrackId: card.id,
        cardData: { cardParamMap: defaultCardParams(content, '2') },
      });
      card.started = true;
    }
    await this.request('PUT', '/v1.0/card/streaming', token, {
      outTrackId: card.id,
      guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      key: 'msgContent',
      content,
      isFull: true,
      isFinalize: finished,
      isError: false,
    });
    if (finished) {
      await this.request('PUT', '/v1.0/card/instances', token, {
        outTrackId: card.id,
        cardData: { cardParamMap: defaultCardParams(content, '3') },
        cardUpdateOptions: { updateCardDataByKey: true },
      });
    }
  }

  async updateData(card: DingTalkCardInstance, params: Record<string, unknown>) {
    const token = await this.getToken();
    await this.request('PUT', '/v1.0/card/instances', token, {
      outTrackId: card.id,
      cardData: { cardParamMap: { config: cardConfig(), ...params } },
      cardUpdateOptions: { updateCardDataByKey: true },
    });
  }

  private async request(method: 'POST' | 'PUT', path: string, token: string, body: Record<string, unknown>) {
    const response = await this.fetcher(`${DINGTALK_API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`DingTalk card request failed: ${method} ${path} HTTP ${response.status} ${await response.text().catch(() => '')}`);
  }
}

function defaultCardParams(content: string, flowStatus: '2' | '3') {
  return {
    flowStatus,
    msgContent: content,
    staticMsgContent: '',
    sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
    config: cardConfig(),
  };
}

function cardConfig() {
  return JSON.stringify({ autoLayout: true });
}

function deliverBody(id: string, target: DingTalkCardTarget, robotCode: string) {
  return target.type === 'group'
    ? { outTrackId: id, userIdType: 1, openSpaceId: `dtv1.card//IM_GROUP.${target.conversationId}`, imGroupOpenDeliverModel: { robotCode } }
    : { outTrackId: id, userIdType: 1, openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`, imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode } };
}
