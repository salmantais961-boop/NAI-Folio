export function workScore(work) {
  return Number.isInteger(work?.score) && work.score >= 0 && work.score <= 5 ? work.score : null;
}

/** A scored zero still belongs above an unrated work; ties keep input order. */
export function rankArchiveWorks(items, enabled = true) {
  if (!enabled) return [...items];
  return items
    .map((work, index) => ({ work, index, score: workScore(work) }))
    .sort((a, b) => {
      if (a.score === null) return b.score === null ? a.index - b.index : 1;
      if (b.score === null) return -1;
      return b.score - a.score || a.index - b.index;
    })
    .map(({ work }) => work);
}

export function mountArchiveScoring(host, { onChange = () => {}, notify = () => {} } = {}) {
  let enabled = true;
  try {
    enabled = localStorage.getItem('folio.archive.score-first') !== '0';
  } catch {}
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'archive-score-toggle';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', '高分作品优先');
  button.title = '已评分作品按分数从高到低排列；未评分作品在后，同分保持原顺序。';
  const mark = document.createElement('span'),
    label = document.createElement('span'),
    track = document.createElement('i');
  mark.className = 'archive-score-mark';
  mark.textContent = '★';
  mark.setAttribute('aria-hidden', 'true');
  label.textContent = '高分优先';
  track.setAttribute('aria-hidden', 'true');
  button.append(mark, label, track);
  function paint() {
    button.setAttribute('aria-checked', String(enabled));
  }
  button.onclick = () => {
    enabled = !enabled;
    try {
      localStorage.setItem('folio.archive.score-first', enabled ? '1' : '0');
    } catch {
      notify('排序已切换，但此设备暂时无法记住偏好。');
    }
    paint();
    onChange(enabled);
  };
  paint();
  host?.append(button);
  return {
    get enabled() {
      return enabled;
    },
    sort: (items) => rankArchiveWorks(items, enabled),
    decorate(card, work) {
      const score = workScore(work);
      let badge = card.querySelector('.archive-score-badge');
      if (score === null) {
        badge?.remove();
        delete card.dataset.score;
        return;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'archive-score-badge';
        card.querySelector('.archive-open').append(badge);
      }
      card.dataset.score = String(score);
      badge.textContent = '★ ' + score;
      badge.setAttribute('aria-label', '评分 ' + score + ' / 5');
      badge.title = '我的评分 · ' + score + ' / 5';
    },
    destroy() {
      button.remove();
    },
  };
}
