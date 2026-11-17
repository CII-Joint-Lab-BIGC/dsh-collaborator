import { readFileSync } from 'node:fs';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools';
import { RECORD, inputSchema, projectionDefinition, renderTaskContext, renderOrientationContext, transition } from './state.js';
import { interactionProjection, renderInteraction } from './interaction.js';

export const name = 'dsh-collaborator';
export const inject = ['systemPrompt', 'tools', 'sessionProjections'];
export const policy = readFileSync(new URL('../prompts/collaborator.md', import.meta.url), 'utf8');
export const pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const turnPolicy = `[DSH 协作导航 ${pluginVersion}] 对陌生或复杂的探索性项目，先让用户有足够认识参与判断。首次实质回复从整体说明这个领域解决什么、项目各部分怎样关联及主要路线，结合少量已核验的代表性成果解释能借用什么、还需解决什么；自然了解相关经历、用户目前怎样理解项目及哪里最困惑。主动查找论文、开源项目、公司或产品、高校与科研团队、论坛或社区，按相关性给链接和借鉴点，不凑类别或穷尽全网。问题要让未掌握术语的人也能回答；先给必要背景，再问会影响理解和选择的问题。介绍过、给过链接或回答过设备参数，不等于用户已经理解；依用户表达和实际反馈按主题修正判断。随回答继续解释、推荐和推进可做的工作，不把开场交流当成一次性需求采集，不在目标尚探索时直接铺开整套开发。简单小事或明确的直接执行委托照常完成，不强制上课、测评或访谈；用户当前要求和宿主权限优先。`;

const knowledgeParameter = {
  type: 'object', additionalProperties: false,
  properties: {
    topic: { type: 'string', required: true },
    understanding: { type: 'string', enum: ['unknown', 'needs-explanation', 'can-apply'], required: true, description: '按具体主题观察；仅介绍过概念、发过资料或用户未追问，不足以判定 can-apply。' },
    evidence: { type: 'string', required: true, description: '用户原话、已有成果或实际反馈；不要凭语气、术语或助手自己的讲解推断掌握程度。' },
  },
};
const sourceParameter = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
    relevance: { type: 'string', required: true, description: '对当前任务的具体作用。' },
    kind: { type: 'string', enum: ['paper', 'open-source', 'company', 'research-group', 'community', 'documentation', 'other'], description: '资料类型；只有实际核验的相关来源才记录。' },
  },
};
const taskParameters = {
  goal: { type: 'string', description: '用户要达成的实际结果。' },
  constraints: { type: 'array', items: { type: 'string' } },
  knowledge: { type: 'array', items: knowledgeParameter },
  decisions: { type: 'array', items: { type: 'string' } },
  sources: { type: 'array', items: sourceParameter },
  progress: { type: 'string' },
  nextAction: { type: 'string' },
  background: { type: 'string', description: '用户在本项目相关领域的经验、做过的相近工作及依据；未知留空，不凭技术名词猜水平。' },
  projectUnderstanding: { type: 'string', description: '用户目前如何理解项目、已清楚和仍困惑的部分，附用户表述或反馈依据。' },
  landscape: { type: 'string', description: '已向用户介绍的项目全貌、关键概念、主要路线与已有成果；只表示介绍过，不表示用户已掌握；不是施工计划或未完成的检索承诺。' },
};

/** Add cooperative guidance, one checkpoint tool, and an optional slash command. */
export async function apply(ctx) {
  const projection = await ctx.sessionProjections.register(projectionDefinition);
  const interaction = await ctx.sessionProjections.register(interactionProjection);
  const stateOf = session => projection.stateOf(session);
  function save(session, input) {
    const current = stateOf(session);
    let next;
    try { next = transition(current, input); }
    catch (error) { throw new ToolArgsError([error.message]); }
    if (JSON.stringify(current) !== JSON.stringify(next)) appendPluginRecord(session, RECORD, next);
    return next;
  }

  ctx.systemPrompt.section({
    name: 'dsh-collaborator:policy', order: 650, interpolate: false,
    text: context => context.agent && !stateOf(context.agent.session).enabled ? '' : policy,
  });
  ctx.systemPrompt.context({
    name: 'dsh-collaborator:task', order: 350, interpolate: false,
    text: context => context.agent ? renderTaskContext(stateOf(context.agent.session)) : '',
  });
  ctx.systemPrompt.context({
    name: 'dsh-collaborator:interaction', order: 360, interpolate: false,
    text: context => context.agent && stateOf(context.agent.session).enabled
      ? renderInteraction(interaction.stateOf(context.agent.session)) : '',
  });
  ctx.systemPrompt.context({
    name: 'dsh-collaborator:orientation', order: 370, interpolate: false,
    text: context => context.agent ? renderOrientationContext(stateOf(context.agent.session)) : '',
  });
  // Reiterate the immediate collaboration decision after the host's tool guidance.
  // This is model guidance, not an output filter or an extra model request.
  ctx.systemPrompt.section({
    name: 'dsh-collaborator:turn-policy', order: 10300, interpolate: false,
    text: context => context.agent && !stateOf(context.agent.session).enabled ? '' : turnPolicy,
  });

  ctx.tools.register(defineTool({
    name: 'collaboration',
    description: 'Read or checkpoint this session’s task and shared understanding: user background, how they understand the project, observed topic knowledge, domain landscape already explained, and verified resources. Unknown background stays unknown; technical parameters, delivered explanations, and shared links are not evidence of user understanding. Update topic observations from user feedback. Save only meaningful changes or a handoff, not every message. start replaces the previous task; remember updates supplied fields and replaces supplied arrays. pause/resume changes guidance for this session; finish records completion. This is bookkeeping, not an interview or approval gate.',
    parameters: {
      action: { type: 'string', enum: ['read', 'start', 'remember', 'pause', 'resume', 'finish'], required: true },
      ...taskParameters,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          schemaVersion: { type: 'number', required: true },
          enabled: { type: 'boolean', required: true },
          completed: { type: 'boolean', required: true },
          ...Object.fromEntries(Object.entries(taskParameters).map(([key, value]) => [key, { ...value, required: true }])),
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: args => args.action === 'read',
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (!exec.agent?.session) throw new Error('collaboration 需要一个会话。');
      const checked = inputSchema.safeParse(args);
      if (!checked.success) throw new ToolArgsError(checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`));
      return save(exec.agent.session, checked.data);
    },
    presentCall: args => ({ card: 'generic', title: args.action === 'read' ? '读取协作记录' : '更新协作记录' }),
  }));

  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      definitionId: 'dsh-collaborator:collaborate',
      name: 'collaborate',
      description: '协作导航：带上任务开始；off 暂停，on 恢复，status 查看记录。',
      input: { hint: '[任务 | on | off | status]', attachments: true },
      handler: ({ agent, rawInput, attachments = [] }) => {
        const input = rawInput.trim();
        if (['on', 'off', 'status', ''].includes(input) && attachments.length > 0) {
          return { kind: 'error', text: '请在附件旁补充任务描述。' };
        }
        if (input === 'off') {
          save(agent.session, { action: 'pause' });
          return { kind: 'success', text: '已暂停本会话的协作导航。' };
        }
        if (input === 'on') {
          save(agent.session, { action: 'resume' });
          return { kind: 'success', text: '已恢复本会话的协作导航。' };
        }
        if (input === 'status') {
          const state = stateOf(agent.session);
          const guidanceStatus = state.enabled ? '已启用' : '已暂停';
          return { kind: 'success', text: `DSH 协作导航 ${pluginVersion}\n持续协作监测：${guidanceStatus}\n共同理解引导：${guidanceStatus}\n` + (renderTaskContext({ ...state, enabled: true }) || '还没有任务记录；直接描述想完成的事情即可。') };
        }
        if (!input) return { kind: 'success', text: '直接描述想完成的事情，或使用 /collaborate 任务描述。' };
        if (agent.status !== 'idle') {
          return { kind: 'error', text: '当前任务仍在运行。请在对话中补充要求，或停止后再切换任务。' };
        }
        save(agent.session, { action: 'start', goal: input });
        agent.steer(createUserMessage({
          content: [...attachments, { type: 'text', text: input }],
          source: { kind: 'user' },
        }));
        return { kind: 'success', text: '已接入协作导航。' };
      },
    });
  });
}
