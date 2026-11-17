import { z } from 'zod';

/** Derived from public conversation events, not from private reasoning. */
export const interactionSchema = z.object({
  turnActive: z.boolean(),
  lastVisibleAt: z.number(),
  silentSteps: z.number().int().nonnegative(),
  silentToolCalls: z.number().int().nonnegative(),
  pendingQuestions: z.array(z.string()),
  answerNeedsExplanation: z.boolean(),
}).strict();

export function initialInteraction() {
  return { turnActive: false, lastVisibleAt: 0, silentSteps: 0, silentToolCalls: 0,
    pendingQuestions: [], answerNeedsExplanation: false };
}

/** Fold visible messages, tools, and question returns. No semantic guesses or keyword routing. */
export function foldInteraction(state, event) {
  if (event.type === 'turn/start') return { ...initialInteraction(), turnActive: true, lastVisibleAt: event.time };
  if (event.type === 'turn/end') return { ...state, turnActive: false };
  if (!state.turnActive) return state;
  if (event.type === 'assistant/message') {
    const content = event.data?.message?.content ?? [];
    const hasVisibleText = content.some(block => block.type === 'text' && block.text?.trim());
    return hasVisibleText
      ? { ...state, lastVisibleAt: event.time, silentSteps: 0, silentToolCalls: 0, answerNeedsExplanation: false }
      : { ...state, silentSteps: state.silentSteps + 1 };
  }
  if (event.type === 'tool/call') {
    if (event.data.name === 'ask_user_question') {
      return { ...state, pendingQuestions: [...state.pendingQuestions, event.data.callId] };
    }
    return event.data.name === 'collaboration' ? state : { ...state, silentToolCalls: state.silentToolCalls + 1 };
  }
  if (event.type === 'tool/result') {
    const message = event.data?.message;
    const callId = message?.toolCallId;
    if (!state.pendingQuestions.includes(callId)) return state;
    return { ...state, pendingQuestions: state.pendingQuestions.filter(id => id !== callId),
      answerNeedsExplanation: state.answerNeedsExplanation || message.isError !== true };
  }
  return state;
}

export const interactionProjection = {
  key: 'dsh-collaborator-interaction', stateVersion: 1, stateSchema: interactionSchema,
  init: initialInteraction, apply: foldInteraction,
};

/** A soft next-generation reminder; never blocks tools, invents progress, or asks on a timer. */
export function communicationNeed(state, now = Date.now()) {
  if (!state.turnActive || state.pendingQuestions.length > 0) return null;
  if (state.answerNeedsExplanation) return 'question-returned';
  if (state.silentToolCalls > 0 && (state.silentSteps >= 3 || now - state.lastVisibleAt >= 45000)) return 'silent-work';
  return null;
}

export function renderInteraction(state, now = Date.now()) {
  const reason = communicationNeed(state, now);
  if (!reason) return '';
  const observation = reason === 'question-returned'
    ? '刚完成了一次向用户提问，尚未解释实际返回内容对项目理解和路线的意义。结合回答识别相关背景、仍需介绍的概念和参考资料；参数回答或“继续”不能证明已经理解，不要据此转入整套施工。取消或缺失的回答不能当成用户已确认。'
    : '已经连续执行工具工作，期间没有面向用户的文字说明。工具进度卡、任务列表和内部思考不能替代协作沟通。';
  return '持续协作提醒：' + observation
    + '下一次生成先用自然的短段落说明已得知什么、对当前选择的意义，以及接下来处理什么。'
    + '出现新的关键未知时，解释区别并提出会改变行动的问题；依赖答案的工作等答案后再做，独立工作可以继续。'
    + '不要只重复“我在处理”，不要为了聊天增加问题、审批或停工，也不要向用户展示内部计数和固定模板。';
}
