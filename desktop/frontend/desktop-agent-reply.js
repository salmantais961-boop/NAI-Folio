import { button, element, icon } from './desktop-agent-elements.js';

export const signature = 'Created just for you';
const integer = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const speed = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

function copyText(turn) {
  const parts = [turn.answer];
  const plan = turn.plan;
  if (plan) {
    if (plan.prompt) parts.push('正向提示词\n' + plan.prompt);
    if (plan.negative) parts.push('负面提示词\n' + plan.negative);
    for (const [i, character] of (plan.characters || []).entries()) {
      if (character.prompt) parts.push('角色 ' + (i + 1) + '\n' + character.prompt);
      if (character.negative) parts.push('角色 ' + (i + 1) + ' · 负面提示词\n' + character.negative);
    }
  }
  return parts.filter(Boolean).join('\n\n');
}

function usageLine(usage) {
  const meter = element('span', 'da-reply-meter');
  const known = (value) => Number.isFinite(value) && value >= 0;
  const total = known(usage?.totalTokens) ? integer.format(usage.totalTokens) : '—';
  const rate = known(usage?.tps) ? (usage.approximateTps ? '≈' : '') + speed.format(usage.tps) : '—';
  const counts = element('span', '', total + ' tokens');
  counts.title = '本次回复所有模型请求的输入与输出总计';
  if (known(usage?.inputTokens) && known(usage?.outputTokens))
    counts.title += '（输入 ' + integer.format(usage.inputTokens) + '，输出 ' + integer.format(usage.outputTokens) + '）';
  if (!known(usage?.totalTokens)) counts.title = '此回复没有完整的 token 用量记录';
  const throughput = element('span', '', rate + ' TPS');
  throughput.title = !known(usage?.tps)
    ? '此回复没有生成速度记录'
    : usage.approximateTps
      ? '每秒输出 token 数，按模型请求耗时估算'
      : '每秒输出 token 数，按模型报告的生成耗时计算';
  meter.setAttribute('aria-label', counts.textContent + '，' + throughput.textContent);
  meter.append(counts, throughput);
  return meter;
}

export function replyFooter(turn, { regenerate, busy, earlier, notice }) {
  const footer = element('footer', 'da-reply-footer');
  const actions = element('div', 'da-reply-actions');
  const retry = button('重新生成回复', 'regenerate', regenerate, 'da-icon-button da-retry');
  retry.disabled = busy;
  const updateHint = () => {
    retry.title = earlier() ? '从这里重新生成，后续消息保存在原对话' : '重新生成这条回复';
    if (turn.workIds?.length) retry.title += ' · 将按当前生图设置重新出图';
  };
  updateHint();
  retry.addEventListener('pointerenter', updateHint);
  retry.addEventListener('focus', updateHint);
  const copy = button('复制回复', 'copy', async () => {
    try {
      await navigator.clipboard.writeText(copyText(turn));
      copy.replaceChildren(icon('check'));
      copy.setAttribute('aria-label', '已复制回复');
      copy.title = '已复制';
      setTimeout(() => {
        if (!copy.isConnected) return;
        copy.replaceChildren(icon('copy'));
        copy.setAttribute('aria-label', '复制回复');
        copy.title = '复制回复';
      }, 1500);
    } catch {
      notice('无法写入剪贴板，可以选中回复文字复制。');
    }
  }, 'da-icon-button da-copy-reply');
  copy.disabled = !turn.answer && !turn.plan;
  actions.append(retry, copy);
  const imprint = element('span', 'da-reply-imprint');
  imprint.setAttribute('aria-hidden', 'true');
  imprint.append(element('i', '', signature), element('span', 'da-flower'));
  footer.append(actions, usageLine(turn.usage), imprint);
  return footer;
}
