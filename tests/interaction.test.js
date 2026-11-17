import test from 'node:test';
import assert from 'node:assert/strict';
import { initialInteraction, foldInteraction, communicationNeed, renderInteraction } from '../src/interaction.js';

const event = (type, data, time = 1000) => ({ type, data, time });
const textMessage = text => event('assistant/message', { message: { content: [{ type: 'text', text }] } });
const silentMessage = () => event('assistant/message', { message: { content: [{ type: 'reasoning', text: 'not user-visible' }] } });
const work = () => event('tool/call', { name: 'web_search', callId: 'work' });
const fold = events => events.reduce(foldInteraction, initialInteraction());

test('提问返回后立即提醒解释，已有可见介绍后解除提醒', () => {
  const answered = fold([
    event('turn/start', {}), textMessage('先确认用途。'),
    event('tool/call', { name: 'ask_user_question', callId: 'question' }),
    event('tool/result', { message: { toolCallId: 'question', isError: false } }),
  ]);
  assert.equal(communicationNeed(answered, 1001), 'question-returned');
  assert.equal(communicationNeed(foldInteraction(answered, textMessage('这意味着可以采用局域网连接，远程访问还需另定。')), 1001), null);
});

test('连续无可见文字的工具工作触发提醒，内部推理不算对用户介绍', () => {
  const state = fold([event('turn/start', {}), textMessage('我先检查资料。'),
    silentMessage(), work(), silentMessage(), work(), silentMessage(), work()]);
  assert.equal(communicationNeed(state, 2000), 'silent-work');
  const explained = foldInteraction(state, textMessage('资料已确认这个接口支持所需功能，接下来核对设备支持情况。'));
  assert.equal(communicationNeed(explained, 2000), null);
});

test('等待用户、短工具操作和单纯记账不会触发机械沟通', () => {
  const waiting = fold([event('turn/start', {}), event('tool/call', { name: 'ask_user_question', callId: 'pending' })]);
  assert.equal(communicationNeed(waiting, 999999), null);
  const quick = fold([event('turn/start', {}), work(), silentMessage()]);
  assert.equal(communicationNeed(quick, 2000), null);
  const bookkeeping = fold([event('turn/start', {}), silentMessage(), silentMessage(), silentMessage(),
    event('tool/call', { name: 'collaboration', callId: 'remember' })]);
  assert.equal(communicationNeed(bookkeeping, 999999), null);
});

test('持续耗时工作在下一次生成时得到提醒，结束后清除活动提醒', () => {
  const running = fold([event('turn/start', {}, 1000), work()]);
  assert.equal(communicationNeed(running, 46000), 'silent-work');
  assert.equal(renderInteraction(foldInteraction(running, event('turn/end', {})), 46000), '');
});

test('失败或取消的提问不被标记为用户回答', () => {
  const state = fold([event('turn/start', {}), event('tool/call', { name: 'ask_user_question', callId: 'failed' }),
    event('tool/result', { message: { toolCallId: 'failed', isError: true } })]);
  assert.equal(state.answerNeedsExplanation, false);
  assert.equal(communicationNeed(state, 1001), null);
});
