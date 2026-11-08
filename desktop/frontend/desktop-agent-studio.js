import { capabilities } from './controls-model.js';
import { listChunks, reference, resolvePromptReferences } from './chunks.js';
import { mountDesktopAgent } from './desktop-agent.js';
import { createAgentRunner } from './desktop-agent-run.js';
import { createImageSettings } from './desktop-agent-image-settings.js';
import { createAgentPromptBudget, agentImageSettings } from './agent-prompt-budget.js';

export function mount(host, { controls, generate, search, openWork, onImageSettingsChange }) {
  const imageSettings = createImageSettings(() => controls.getSettings(), onImageSettingsChange);
  const run = createAgentRunner({
    getSettings: imageSettings.current,
    getMaxCharacters: (settings) => capabilities({ ...settings, mode: 'generate' }).chars,
    createPromptBudget: createAgentPromptBudget,
    getLibrary: listChunks,
    resolve: (name, library) => resolvePromptReferences(reference(name), library),
    search,
    render: ({ plan, settings, locks, identities, signal }) => {
      const positiveLocks = locks.filter((lock) => lock.lane !== 'negative');
      const positiveChunks = positiveLocks.flatMap((lock) => lock.chunks);
      const negativeChunks = locks.filter((lock) => lock.lane === 'negative').flatMap((lock) => lock.chunks);
      for (const role of plan.roles) {
        const oc = identities.get(role.referenceId)?.block;
        if (oc) positiveChunks.push(oc);
      }
      return generate({
        agent: { positiveChunks, negativeChunks, lockNegative: plan.negativeLocked },
        signal,
        prompt: plan.prompt,
        negative: plan.negative,
        settings: agentImageSettings(settings, plan),
      });
    },
  });
  function getNegativeSnapshot() {
    const text = document.getElementById('negative').value;
    if (!text.trim()) return null;
    const fixed = resolvePromptReferences(text, listChunks());
    return {
      id: 'folio-current-negative',
      name: '工作台负面提示词',
      lane: 'negative',
      text,
      resolvedText: fixed.text,
      resolvedChunks: fixed.chunks.map(({ id, name, text }) => ({ id, name, text })),
    };
  }
  const agent = mountDesktopAgent(host, {
    run,
    imageSettings,
    openWork,
    getNegativeSnapshot,
    openConnection: () => controls.openAccount(),
  });
  return { ...agent, getImageSettings: imageSettings.current, useSeed: imageSettings.useSeed };
}
