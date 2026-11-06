const integer = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
export function createStepProgress({ totalSteps, samples = 1 } = {}) {
  return {
    totalSteps: integer(totalSteps) && totalSteps > 0 ? totalSteps : null,
    samples: integer(samples) && samples > 0 ? samples : 1,
    observed: {},
  };
}
export function advanceStepProgress(state, frame = {}) {
  if (!frame || typeof frame !== 'object') return state;
  const sample = frame.sample ?? 0;
  if (!integer(frame.step) || !integer(sample) || sample >= state.samples) return state;
  return {
    ...state,
    observed: { ...state.observed, [sample]: Math.max(state.observed[sample] ?? 0, frame.step) },
  };
}
export function summarizeStepProgress(state) {
  const values = Object.values(state.observed);
  const known = values.length > 0;
  const reported = values.reduce((sum, value) => sum + value, 0);
  // step_ix is displayed exactly as returned, without guessing its index base.
  // A relay reporting beyond the submitted step count has no trustworthy ratio.
  const total =
    state.totalSteps && values.every((value) => value <= state.totalSteps)
      ? state.totalSteps * state.samples
      : null;
  const ratio = known && total ? reported / total : null;
  return {
    known,
    reported,
    total,
    ratio,
    percent: ratio != null && ratio < 1 ? Math.floor(ratio * 100) : null,
  };
}

export function mountProofProgress(foot) {
  const root = document.createElement('section');
  root.className = 'proof-progress';
  root.hidden = true;
  root.setAttribute('aria-label', '当前生成任务进度');
  root.innerHTML = `<div class="pp-caption"><span class="pp-label"><i class="pp-signal" aria-hidden="true"></i><span class="pp-title"></span><small class="pp-context"></small></span><span class="pp-reading"></span></div><div class="pp-track" role="progressbar" aria-label="已回传的采样步骤"><i class="pp-fill"></i><i class="pp-glint" aria-hidden="true"></i></div>`;
  foot.insertBefore(root, foot.querySelector('.proof-dock-tools'));
  const title = root.querySelector('.pp-title');
  const context = root.querySelector('.pp-context');
  const reading = root.querySelector('.pp-reading');
  const track = root.querySelector('.pp-track');
  const fill = root.querySelector('.pp-fill');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let state = createStepProgress();
  let active = false,
    done = false,
    viewing = true,
    stream = null,
    mode = 'generate',
    seenPreview = false;
  let timer = 0,
    motion = null;
  function stopMotion() {
    clearTimeout(timer);
    timer = 0;
    motion?.cancel();
    motion = null;
  }
  function paint() {
    const progress = summarizeStepProgress(state);
    root.dataset.phase = done ? 'complete' : progress.known ? 'sampling' : 'waiting';
    root.dataset.background = String(!viewing);
    root.dataset.measured = String(done || progress.ratio != null);
    title.textContent = done
      ? viewing
        ? '显影完成'
        : '后台任务已完成'
      : !viewing
        ? '后台生成'
        : mode === 'upscale'
          ? '超分处理中'
          : mode === 'augment'
            ? '图像处理中'
            : '正在显影';
    context.textContent = done
      ? '新作已就绪'
      : stream
        ? '流式回传' + (state.samples > 1 ? ' · ' + state.samples + ' 张' : '')
        : stream === false
          ? '标准输出'
          : '准备任务';
    const steps = state.samples > 1 ? '回传步骤 ' : '采样步骤 ';
    reading.textContent = done
      ? '100%'
      : progress.known
        ? steps +
          progress.reported +
          (progress.total ? ' / ' + progress.total : '') +
          (progress.percent != null
            ? ' · ' + progress.percent + '%'
            : progress.ratio === 1
              ? ' · 等待成图'
              : '')
        : stream
          ? seenPreview
            ? '已收到预览 · 步数未提供'
            : '等待首帧'
          : stream === false
            ? '等待完整图像'
            : '等待连接';
    const ratio = done ? 1 : progress.ratio;
    root.style.setProperty('--pp-ratio', ratio ?? 0);
    track.setAttribute('aria-valuetext', reading.textContent);
    if (ratio != null) {
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      // Only a final image is announced as a completed task.
      if (done || ratio < 1) track.setAttribute('aria-valuenow', String(done ? 100 : progress.percent));
      else track.removeAttribute('aria-valuenow');
    } else {
      track.removeAttribute('aria-valuenow');
      track.removeAttribute('aria-valuemin');
      track.removeAttribute('aria-valuemax');
    }
  }
  function show() {
    const wasHidden = root.hidden;
    root.hidden = false;
    if (wasHidden && !reduced.matches) {
      motion = root.animate(
        [
          { opacity: 0, translate: '0 4px' },
          { opacity: 1, translate: '0 0' },
        ],
        {
          duration: 300,
          easing: 'cubic-bezier(.2,.75,.25,1)',
        },
      );
    }
  }
  function clear() {
    stopMotion();
    active = done = false;
    state = createStepProgress();
    root.hidden = true;
    paint();
  }
  return {
    begin(options = {}) {
      stopMotion();
      active = true;
      done = false;
      viewing = true;
      stream = null;
      seenPreview = false;
      mode = options.mode || 'generate';
      state = createStepProgress();
      paint();
      show();
      // Commit the empty bar before even an immediately delivered first frame.
      getComputedStyle(fill).transform;
    },
    transport(options = {}) {
      if (!active) return;
      stream = options.stream === true;
      mode = options.mode || mode;
      state = createStepProgress(options);
      paint();
      getComputedStyle(fill).transform;
    },
    frame(frame) {
      if (!active || !stream) return;
      seenPreview = true;
      state = advanceStepProgress(state, frame);
      paint();
    },
    setViewing(value) {
      if (!active) return;
      viewing = Boolean(value);
      paint();
    },
    complete() {
      if (!active) return;
      stopMotion();
      active = false;
      done = true;
      paint();
      timer = setTimeout(() => {
        timer = 0;
        if (reduced.matches) {
          clear();
          return;
        }
        const animation = root.animate([{ opacity: 1 }, { opacity: 0, translate: '0 -3px' }], {
          duration: 320,
          easing: 'cubic-bezier(.3,0,.3,1)',
          fill: 'forwards',
        });
        motion = animation;
        animation.finished.then(
          () => {
            if (motion === animation) clear();
          },
          () => {},
        );
      }, 1150);
    },
    clear,
  };
}
