export function isDeepSeekConnection(profile) {
  try {
    const url = new URL(profile?.baseUrl || (profile?.preset === 'deepseek' ? 'https://api.deepseek.com' : ''));
    return url.origin === 'https://api.deepseek.com' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

// Resolve in memory at request time, so editing or deleting a saved connection takes effect immediately.
export function webSearchProviderFor(config, settings = config.plugins?.webSearch) {
  if (settings?.enabled === false) return;
  const eligible = config.profiles.filter((profile) => isDeepSeekConnection(profile) && profile.apiKey?.trim());
  const selected = settings?.profileId
    ? eligible.find((p) => p.id === settings.profileId)
    : eligible.find((p) => p.id === config.activeId) || eligible[0];
  if (selected) return { preset: selected.preset, baseUrl: selected.baseUrl, apiKey: selected.apiKey };
}
