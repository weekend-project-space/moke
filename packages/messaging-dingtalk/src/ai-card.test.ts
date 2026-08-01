import assert from 'node:assert/strict';
import test from 'node:test';
import { DingTalkAiCardService } from './ai-card.js';

test('includes the built-in template render fields when creating and finishing a card', async () => {
  const requests: Array<{ path: string; body: Record<string, any> }> = [];
  const service = new DingTalkAiCardService('robot_1', async () => 'token', async (url, init) => {
    requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: 200 });
  });

  const card = await service.create({ type: 'user', userId: 'user_1' }, 'Working');
  await service.update(card, 'Final answer', true);

  const createParams = requests[0]?.body.cardData.cardParamMap;
  assert.equal(createParams.msgContent, 'Working');
  assert.equal(createParams.staticMsgContent, '');
  assert.equal(createParams.flowStatus, '2');
  assert.deepEqual(JSON.parse(createParams.sys_full_json_obj), { order: ['msgContent'] });

  assert.deepEqual(requests.map((request) => request.path), [
    '/v1.0/card/instances',
    '/v1.0/card/instances/deliver',
    '/v1.0/card/instances',
    '/v1.0/card/streaming',
    '/v1.0/card/instances',
  ]);
  const finishParams = requests[4]?.body.cardData.cardParamMap;
  assert.equal(finishParams.msgContent, 'Final answer');
  assert.equal(finishParams.flowStatus, '3');
  assert.deepEqual(JSON.parse(finishParams.sys_full_json_obj), { order: ['msgContent'] });
});

test('does not impose built-in template fields on a custom interaction template', async () => {
  let createBody: Record<string, any> | undefined;
  const service = new DingTalkAiCardService('robot_1', async () => 'token', async (url, init) => {
    if (new URL(String(url)).pathname === '/v1.0/card/instances') createBody = JSON.parse(String(init?.body));
    return new Response('{}', { status: 200 });
  });

  await service.create({ type: 'user', userId: 'user_1' }, 'Question', {
    templateId: 'custom.schema',
    params: { title: 'Input required' },
  });

  assert.equal(createBody?.cardTemplateId, 'custom.schema');
  assert.deepEqual(createBody?.cardData.cardParamMap, {
    config: JSON.stringify({ autoLayout: true }),
    msgContent: 'Question',
    title: 'Input required',
  });
});

test('updates custom interaction data by key', async () => {
  const requests: Array<{ path: string; body: Record<string, any> }> = [];
  const service = new DingTalkAiCardService('robot_1', async () => 'token', async (url, init) => {
    requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: 200 });
  });

  await service.updateData({ id: 'card_1', started: false }, {
    title: 'Response received',
    msgContent: 'Selected: Continue',
    actions: '[]',
  });

  assert.equal(requests[0]?.path, '/v1.0/card/instances');
  assert.equal(requests[0]?.body.outTrackId, 'card_1');
  assert.equal(requests[0]?.body.cardData.cardParamMap.title, 'Response received');
  assert.equal(requests[0]?.body.cardData.cardParamMap.actions, '[]');
  assert.deepEqual(requests[0]?.body.cardUpdateOptions, { updateCardDataByKey: true });
});
