import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import Sessions, { Session, appendPluginRecord } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Tools from '@deepseek-ai/dsh-tools';
import Commands from '@deepseek-ai/dsh-commands';
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import * as collaborator from '../src/index.js';
import { RECORD, initialState } from '../src/state.js';

async function harness(t, { commands = false } = {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const service of [SystemPrompt, Sessions, Projections, Tools, NativeExecutor]) await ctx.plugin(service);
  if (commands) await ctx.plugin(Commands);
  const fiber = ctx.plugin(collaborator);
  await fiber;
  let callSeq = 0;
  const makeAgent = (id, session = ctx.sessions.create(id)) => ({
    id, session, status: 'idle', messages: [],
    steer(message) { this.messages.push(message); },
  });
  const agent = makeAgent('test-session');
  async function call(args, target = agent, signal = new AbortController().signal) {
    const batch = await ctx.tools.execute({
      calls: [{ id: `call-${++callSeq}`, name: 'collaboration', arguments: JSON.stringify(args) }],
      agent: target, signal,
    });
    return batch.results[0].result;
  }
  async function ok(args, target = agent) {
    const result = await call(args, target);
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.value;
  }
  const assemble = target => ctx.systemPrompt.assemble({ agent: target ?? agent });
  return { ctx, fiber, agent, makeAgent, call, ok, assemble };
}

test('真实 DSH 加载插件，通过原生工具管线返回任务；读和无变化更新不增加记录', async t => {
  const h = await harness(t);
  const first = await h.ok({ action: 'start', goal: '直接完成这份报告' });
  assert.equal(first.goal, '直接完成这份报告');
  const seq = h.agent.session.seq;
  assert.equal((await h.ok({ action: 'read' })).goal, first.goal);
  await h.ok({ action: 'remember', goal: first.goal });
  assert.equal(h.agent.session.seq, seq);
  const assembly = await h.assemble();
  assert(assembly.tools.some(tool => tool.name === 'collaboration'));
  assert(assembly.contexts.some(context => context.text.includes(first.goal)));
});

test('无效参数、无依据的字段形状及危险 URL 不会破坏上一份记录', async t => {
  const h = await harness(t);
  await h.ok({ action: 'start', goal: '保留已有成果' });
  const seq = h.agent.session.seq;
  for (const args of [
    { action: 'start', goal: '   ' },
    { action: 'remember', unknown: 'should fail' },
    { action: 'remember', knowledge: [{ topic: '光学', understanding: 'can-apply' }] },
    { action: 'remember', sources: [{ title: '错误地址', url: 'javascript:alert(1)', relevance: '无效' }] },
    { action: 'read', goal: '意外修改' },
  ]) {
    assert.equal((await h.call(args)).isError, true);
    assert.equal(h.agent.session.seq, seq);
  }
  assert.equal((await h.ok({ action: 'read' })).goal, '保留已有成果');
});

test('会话互不串用记录，开始新任务会清除旧任务内容', async t => {
  const h = await harness(t);
  const other = h.makeAgent('other-session');
  await h.ok({ action: 'start', goal: '任务甲', decisions: ['甲的决定'], constraints: ['甲的约束'] });
  await h.ok({ action: 'remember', progress: '甲已完成一部分' });
  assert.equal((await h.ok({ action: 'read' }, other)).goal, '');
  await h.ok({ action: 'start', goal: '任务乙' }, other);
  assert.equal((await h.ok({ action: 'read' })).goal, '任务甲');
  const fresh = await h.ok({ action: 'start', goal: '任务丙' });
  assert.deepEqual(fresh.decisions, []);
  assert.deepEqual(fresh.constraints, []);
  assert.equal(fresh.progress, '');
});

test('暂停后移除协作指导和任务上下文，恢复时保留进展', async t => {
  const h = await harness(t);
  await h.ok({ action: 'start', goal: '保留这项任务', progress: '已完成主体' });
  const normal = await h.assemble();
  assert(renderPrompt(normal).includes(collaborator.policy));
  assert(renderPrompt(normal).includes(collaborator.turnPolicy));
  await h.ok({ action: 'pause' });
  const paused = await h.assemble();
  assert(!renderPrompt(paused).includes(collaborator.policy));
  assert(!renderPrompt(paused).includes(collaborator.turnPolicy));
  assert(!paused.contexts.some(context => context.text.includes('已完成主体')));
  await h.ok({ action: 'resume' });
  const resumed = await h.assemble();
  assert(renderPrompt(resumed).includes(collaborator.policy));
  assert(renderPrompt(resumed).includes(collaborator.turnPolicy));
  assert(resumed.contexts.some(context => context.text.includes('已完成主体')));
});

test('真实会话日志经 JSON 往返后恢复任务；损坏和未知版本记录不会覆盖有效状态', async t => {
  const h = await harness(t);
  await h.ok({ action: 'start', goal: '断点续接', nextAction: '交付最终文件' });
  await h.ok({ action: 'remember', knowledge: [{ topic: '材料', understanding: 'needs-explanation', evidence: '用户说不了解材料采集' }] });
  appendPluginRecord(h.agent.session, RECORD, { schemaVersion: 99, goal: '不应采用' });
  appendPluginRecord(h.agent.session, RECORD, { ...initialState(), knowledge: '损坏内容' });
  const saved = JSON.parse(JSON.stringify(h.agent.session.snapshotEvents()));
  const restored = h.makeAgent('restored-session', Session.create('restored-session', saved));
  const current = await h.ok({ action: 'read' }, restored);
  assert.equal(current.goal, '断点续接');
  assert.equal(current.nextAction, '交付最终文件');
  assert.equal(current.knowledge[0].evidence, '用户说不了解材料采集');
});

test('取消的调用不会产生任务变更，完成标记不会要求进入新阶段', async t => {
  const h = await harness(t);
  await h.ok({ action: 'start', goal: '交付成果', nextAction: '继续操作' });
  const seq = h.agent.session.seq;
  const controller = new AbortController();
  controller.abort();
  assert.equal((await h.call({ action: 'remember', goal: '不应执行' }, h.agent, controller.signal)).isError, true);
  assert.equal(h.agent.session.seq, seq);
  const done = await h.ok({ action: 'finish' });
  assert.equal(done.completed, true);
  assert.equal(done.nextAction, '');
  assert.equal(done.goal, '交付成果');
});

test('真实命令服务可启动任务、暂停和恢复；忙碌时不重置正在执行的任务', async t => {
  const h = await harness(t, { commands: true });
  const signal = new AbortController().signal;
  const status = await h.ctx.commands.execute(h.agent, '/collaborate status', [], signal);
  assert(JSON.stringify(status).includes(collaborator.pluginVersion));
  assert(JSON.stringify(status).includes('共同理解引导：已启用'));
  await h.ctx.commands.execute(h.agent, '/collaborate 给我整理资料', [], signal);
  assert.equal((await h.ok({ action: 'read' })).goal, '给我整理资料');
  assert.equal(h.agent.messages[0].content[0].text, '给我整理资料');
  await h.ctx.commands.execute(h.agent, '/collaborate off', [], signal);
  assert.equal((await h.ok({ action: 'read' })).enabled, false);
  await h.ctx.commands.execute(h.agent, '/collaborate on', [], signal);
  assert.equal((await h.ok({ action: 'read' })).enabled, true);
  h.agent.status = 'running';
  await h.ctx.commands.execute(h.agent, '/collaborate 不应替换的任务', [], signal);
  assert.equal((await h.ok({ action: 'read' })).goal, '给我整理资料');
});

test('卸载会移除工具和指导，重新加载后任务记录仍然有效', async t => {
  const h = await harness(t);
  await h.ok({ action: 'start', goal: '重载后继续' });
  await h.fiber.dispose();
  assert.equal(h.ctx.tools.get('collaboration'), undefined);
  assert(!renderPrompt(await h.assemble()).includes(collaborator.policy));
  assert(!renderPrompt(await h.assemble()).includes(collaborator.turnPolicy));
  await h.ctx.plugin(collaborator);
  assert.equal((await h.ok({ action: 'read' })).goal, '重载后继续');
});

test('协作指导与宿主末尾说明共同保留，任务数据不进入新增的系统指导', async t => {
  const h = await harness(t);
  h.ctx.systemPrompt.section({ name: 'test:host-tail', order: 10200, text: '保留宿主自身的要求' });
  await h.ok({ action: 'start', goal: '含有 {{literal}} 的用户任务' });
  const assembly = await h.assemble();
  const names = assembly.sections.map(section => section.name);
  assert(names.indexOf('dsh-collaborator:turn-policy') > names.indexOf('test:host-tail'));
  assert(renderPrompt(assembly).includes('保留宿主自身的要求'));
  assert(!renderPrompt(assembly).includes('含有 {{literal}} 的用户任务'));
  assert(assembly.contexts.some(context => context.text.includes('{{literal}}')));
});

test('真实会话提问返回后，已存在的模型上下文会获得持续协作提醒；说明或暂停后移除', async t => {
  const h = await harness(t);
  const before = await h.assemble();
  const session = h.agent.session;
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [
    { type: 'text', text: '请先说明你准备怎么使用。' },
    { type: 'tool-call', id: 'question-one', name: 'ask_user_question', arguments: '{}' },
  ] }) }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step: 1, callId: 'question-one', name: 'ask_user_question', arguments: '{}' });
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
    callId: 'question-one', isError: false, content: [{ type: 'text', text: '只在本地使用。' }],
  }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  const refreshed = h.ctx.systemPrompt.refreshContext(before, { agent: h.agent });
  assert(refreshed.contexts.find(context => context.name === 'dsh-collaborator:interaction').text.length > 0);
  assert(!(await h.assemble(h.makeAgent('independent'))).contexts.find(context => context.name === 'dsh-collaborator:interaction').text);
  await h.ok({ action: 'pause' });
  assert(!(await h.assemble()).contexts.find(context => context.name === 'dsh-collaborator:interaction').text);
  await h.ok({ action: 'resume' });
  session.append('step/start', { turn: 1, step: 2 });
  session.append('assistant/message', { turn: 1, step: 2, message: createAssistantMessage({
    content: [{ type: 'text', text: '本地使用可以直接连接设备，无需先搭云服务。接下来核对触发条件。' }],
  }) }, { surfaceOp: 'append' });
  assert(!(await h.assemble()).contexts.find(context => context.name === 'dsh-collaborator:interaction').text);
  await h.fiber.dispose();
  assert(!(await h.assemble()).contexts.some(context => context.name === 'dsh-collaborator:interaction'));
});

test('相关背景、项目理解及分类资料经原生工具保存和日志恢复，新任务与其他会话不继承', async t => {
  const h = await harness(t);
  const shared = {
    background: '用户说会 Python，没做过网站。',
    projectUnderstanding: '用户认为网页本身会生成模型，尚不清楚模型服务与网站的关系。',
    landscape: '已解释网页交互、生成服务与资产处理三者的关系。',
    knowledge: [{ topic: '网站与模型服务', understanding: 'needs-explanation', evidence: '用户问网页是否能直接生成模型' }],
    sources: [{ title: '示例开源项目', url: 'https://example.org/project', kind: 'open-source', relevance: '用于讨论现成生成服务的接入位置。' }],
  };
  const saved = await h.ok({ action: 'start', goal: '了解怎样做三维生成网站', ...shared });
  assert.equal(saved.schemaVersion, 2);
  await h.ok({ action: 'remember', progress: '正在结合用户经验解释可复用的部分' });
  const events = JSON.parse(JSON.stringify(h.agent.session.snapshotEvents()));
  const restored = h.makeAgent('shared-restored', Session.create('shared-restored', events));
  const current = await h.ok({ action: 'read' }, restored);
  for (const [key, value] of Object.entries(shared)) assert.deepEqual(current[key], value);
  const other = await h.ok({ action: 'read' }, h.makeAgent('shared-other'));
  assert.equal(other.background, '');
  assert.equal(other.projectUnderstanding, '');
  assert.deepEqual(other.sources, []);
  const fresh = await h.ok({ action: 'start', goal: '计算一份明确的表格' });
  assert.equal(fresh.background, '');
  assert.equal(fresh.projectUnderstanding, '');
  assert.equal(fresh.landscape, '');
  assert.deepEqual(fresh.knowledge, []);
  assert.deepEqual(fresh.sources, []);
});

test('旧版任务和没有类型的参考资料可直接恢复，不捏造用户背景或丢失原进度', async t => {
  const h = await harness(t);
  const legacy = {
    schemaVersion: 1, enabled: false, completed: false,
    goal: '续接旧版任务', constraints: ['保留用户已选的设备'], knowledge: [], decisions: ['使用局域网'],
    sources: [{ title: '原有参考', url: 'https://example.org/original', relevance: '原来记录的用途' }],
    progress: '已经解释连接方式', nextAction: '了解触发条件',
  };
  appendPluginRecord(h.agent.session, RECORD, legacy);
  const events = JSON.parse(JSON.stringify(h.agent.session.snapshotEvents()));
  const restored = h.makeAgent('legacy-restored', Session.create('legacy-restored', events));
  const current = await h.ok({ action: 'read' }, restored);
  assert.equal(current.schemaVersion, 2);
  assert.equal(current.goal, legacy.goal);
  assert.equal(current.progress, legacy.progress);
  assert.equal(current.nextAction, legacy.nextAction);
  assert.equal(current.enabled, false);
  assert.deepEqual(current.decisions, legacy.decisions);
  assert.equal(current.sources[0].kind, 'other');
  assert.equal(current.sources[0].url, legacy.sources[0].url);
  assert.equal(current.background, '');
  assert.equal(current.projectUnderstanding, '');
  assert.equal(current.landscape, '');
  await h.ok({ action: 'remember', background: '用户补充说只写过 Python' }, restored);
  assert.equal((await h.ok({ action: 'read' }, restored)).progress, legacy.progress);
});

test('共同理解提示随现有模型上下文更新，可暂停；记录空缺不会阻止完成明确任务', async t => {
  const h = await harness(t);
  const orientationOf = assembly => assembly.contexts.find(context => context.name === 'dsh-collaborator:orientation')?.text ?? '';
  assert.equal(orientationOf(await h.assemble()), '');
  await h.ok({ action: 'start', goal: '了解一个陌生项目' });
  const before = await h.assemble();
  assert(orientationOf(before).length > 0);
  await h.ok({ action: 'pause' });
  assert.equal(orientationOf(h.ctx.systemPrompt.refreshContext(before, { agent: h.agent })), '');
  await h.ok({ action: 'resume' });
  await h.ok({ action: 'remember',
    background: '用户说做过相关开发。', projectUnderstanding: '用户已了解组成部分，想比较接入办法。',
    landscape: '已介绍可复用服务与自行部署的区别。',
    sources: [{ title: '示例文档', url: 'https://example.org/docs', relevance: '示例说明' }],
  });
  assert.equal(orientationOf(h.ctx.systemPrompt.refreshContext(before, { agent: h.agent })), '');
  await h.ok({ action: 'start', goal: '直接完成已提供的计算' });
  const done = await h.ok({ action: 'finish' });
  assert.equal(done.completed, true);
  assert.equal(done.background, '');
  assert.equal(orientationOf(await h.assemble()), '');
});

test('已介绍全貌和资料后仍保留具体困惑，会话恢复后继续提示', async t => {
  const h = await harness(t);
  const gap = { topic: '生成服务与网站的关系', understanding: 'needs-explanation', evidence: '用户问模型是否由网页直接生成' };
  await h.ok({ action: 'start', goal: '了解三维生成网站',
    background: '用户做过网页，未接入过生成服务。',
    projectUnderstanding: '用户熟悉网页交互，但不清楚生成服务的位置。',
    landscape: '已介绍网页、生成服务和模型后处理。',
    sources: [{ title: '测试资料', url: 'https://example.org/generation', relevance: '讨论生成接口如何接入。' }],
    knowledge: [gap],
  });
  await h.ok({ action: 'remember', landscape: '补充介绍了接口接入和自行部署两种路线。',
    sources: [{ title: '另一份测试资料', url: 'https://example.org/api', relevance: '用于解释接口路线。' }],
  });
  const orientationOf = assembly => assembly.contexts.find(context => context.name === 'dsh-collaborator:orientation')?.text ?? '';
  assert(orientationOf(await h.assemble()).length > 0);
  const events = JSON.parse(JSON.stringify(h.agent.session.snapshotEvents()));
  const restored = h.makeAgent('gaps-restored', Session.create('gaps-restored', events));
  assert.deepEqual((await h.ok({ action: 'read' }, restored)).knowledge, [gap]);
  assert(orientationOf(await h.assemble(restored)).length > 0);
  await h.ok({ action: 'pause' }, restored);
  assert.equal(orientationOf(await h.assemble(restored)), '');
  await h.ok({ action: 'resume' }, restored);
  assert(orientationOf(await h.assemble(restored)).length > 0);
  await h.ok({ action: 'finish' }, restored);
  assert.equal(orientationOf(await h.assemble(restored)), '');
});

test('理解观察按主题随用户反馈修正，未知不自动算掌握，已有模型上下文同步更新', async t => {
  const h = await harness(t);
  const known = { topic: '网页交互', understanding: 'can-apply', evidence: '用户提供了自己实现的网页。' };
  const uncertain = { topic: '模型后处理', understanding: 'unknown', evidence: '尚未谈及相关经验。' };
  await h.ok({ action: 'start', goal: '比较已有生成能力的接入方式',
    background: '用户有网页开发经验。', projectUnderstanding: '用户清楚网页与生成服务分工。',
    landscape: '已介绍主要组成和可复用能力。',
    sources: [{ title: '测试文档', url: 'https://example.org/docs', relevance: '用于比较接入方式。' }],
    knowledge: [known, uncertain],
  });
  const orientationOf = assembly => assembly.contexts.find(context => context.name === 'dsh-collaborator:orientation')?.text ?? '';
  const original = await h.assemble();
  const refresh = () => h.ctx.systemPrompt.refreshContext(original, { agent: h.agent });
  assert(orientationOf(original).length > 0);
  assert.equal((await h.ok({ action: 'read' })).knowledge[1].understanding, 'unknown');
  const applied = { ...uncertain, understanding: 'can-apply', evidence: '用户提供了自行完成的网格清理结果并解释用途。' };
  await h.ok({ action: 'remember', knowledge: [known, applied] });
  assert.equal(orientationOf(refresh()), '');
  const corrected = { ...applied, understanding: 'needs-explanation', evidence: '用户补充不清楚清理失败的原因。' };
  await h.ok({ action: 'remember', knowledge: [known, corrected] });
  assert(orientationOf(refresh()).length > 0);
  assert.deepEqual((await h.ok({ action: 'read' })).knowledge, [known, corrected]);
});
