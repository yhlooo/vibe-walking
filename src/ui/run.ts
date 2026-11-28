import { Agent, emptyRequestStats } from '../agent/agent.ts';
import type { ChatEvent, Conversation } from '../agent/agent.ts';
import { defaultPrompt, respawnInfo, victoryPrompt } from '../agent/prompts.ts';
import { findModel } from '../agent/settings.ts';
import type { ModelCatalog, ModelSettings } from '../agent/settings.ts';
import { Runtime } from '../game/runtime.ts';
import type { Outcome, Snapshot } from '../game/world.ts';
import type { LevelDefinition } from '../level/definition.ts';
import { captureScene, drawScene } from '../render/scene.ts';
import type { CompletionUpdate } from '../storage/game.ts';
import { element, formatDuration } from './elements.ts';
import { modelPicker } from './model-picker.ts';

// 在通关答复后延迟显示结算弹窗。
const resultDelayMS = 5000;

// 描述正式游玩和编辑器试玩共用的场景依赖。
type RunOptions = {
  level: LevelDefinition;
  catalog: ModelCatalog;
  username: string;
  conversation: Conversation;
  debug?: boolean;
  completedAt?: string;
  onEnter?: () => Promise<void>;
  onCompletion?: (completion: Omit<CompletionUpdate, 'revision'>) => Promise<unknown>;
  nextLevel?: string;
  openSettings: () => void;
  editor?: {
    draw: (canvas: HTMLCanvasElement, snapshot: Snapshot) => void;
  };
};

/** 挂载游玩画面、聊天和结算。 */
export function mountRun(root: HTMLElement, options: RunOptions) {
  const { editor, conversation } = options;
  root.innerHTML = `
    <div class="run-layout">
      ${editor ? '' : `
        <nav class="play-navigation" aria-label="关卡导航">
          <a class="scene-action" href="#/">← 返回主界面</a>
          <a class="scene-action primary" data-play-next hidden>下一关 →</a>
        </nav>`}
      <aside class="panel run-sidebar">
        <div class="sidebar-header"><h2>与 Vibe 对话</h2><span class="subtle" data-run-status></span><button class="text-button" type="button" data-clear-chat disabled>清空历史</button></div>
        <div class="messages" id="vibe-chat-history" role="log" aria-label="对话与工具事件" data-messages></div>
        <div class="chat-divider" role="separator" tabindex="0" aria-orientation="horizontal"
          aria-label="调整对话历史和输入栏高度" aria-controls="vibe-chat-history" data-chat-divider></div>
        <form class="composer" data-composer>
          <textarea aria-label="发给 Vibe 的消息" placeholder="告诉 Vibe 下一步怎么做…" rows="3"></textarea>
          <div class="composer-footer">
            <div class="composer-model-controls" data-model-controls hidden>
              <button class="model-control model-trigger" type="button" data-model-picker></button>
              <button class="model-control model-parameters-trigger" type="button" data-model-parameters></button>
            </div>
            <button class="text-button" type="button" data-connect>配置模型</button>
            <button class="primary" type="submit" disabled>发送</button>
          </div>
        </form>
        ${editor ? `
          <div class="recording-panel" data-recording hidden>
            <div class="sidebar-header"><h2>动作记录</h2><button class="text-button" type="button" data-copy disabled>复制 JSON</button></div>
            <textarea class="recording" data-record aria-label="动作记录 JSON" wrap="off" readonly></textarea>
            <p class="subtle record-status" data-record-status role="status"></p>
          </div>` : ''}
      </aside>
      <section class="panel stage-panel" aria-label="关卡画面">
        <div class="workspace-title run-title"><h1 data-level-title></h1><span class="completion" data-completed hidden>已通关</span></div>
        <div class="stage">
          <canvas width="960" height="540" aria-label="游戏画面"${editor ? ' tabindex="-1"' : ''}></canvas>
          <div class="game-over" role="group" aria-labelledby="game-over-title" data-game-over hidden>
            <h2 id="game-over-title">Game Over</h2>
            <button type="button" class="primary" data-retry-run>再来一次</button>
          </div>
        </div>
        <div class="stage-footer">
          <span data-stage-status role="status"></span>
          <div class="run-actions">
            ${editor ? '<label class="manual-control"><input type="checkbox" role="switch" data-manual>手动控制</label>' : ''}
            <button type="button" data-reset>重置关卡</button>
          </div>
        </div>
      </section>
      ${options.debug && !editor ? '<div class="run-debug" role="region" aria-label="模型调用统计" tabindex="0" data-run-debug></div>' : ''}
    </div>
    ${options.onCompletion ? `
      <dialog class="level-result" aria-labelledby="result-title" data-level-result>
        <h2 id="result-title">通关成功</h2>
        <p class="muted" data-result-duration></p>
        <p class="invalid" data-result-error role="status" hidden></p>
        <nav class="dialog-actions" aria-label="通关后操作">
          <a class="scene-action" href="#/">返回首页</a>
          <button type="button" data-stay>再待一会</button>
          <a class="scene-action primary" data-next-level hidden>下一关</a>
        </nav>
      </dialog>` : ''}`;

  const events = new AbortController();
  const { signal } = events;
  const canvas = element<HTMLCanvasElement>(root, 'canvas');
  const title = element(root, '[data-level-title]');
  const recordingPanel = root.querySelector<HTMLElement>('[data-recording]');
  const recorded = root.querySelector<HTMLTextAreaElement>('[data-record]');
  const recordedStatus = root.querySelector<HTMLElement>('[data-record-status]');
  const copy = root.querySelector<HTMLButtonElement>('[data-copy]');
  const manualSwitch = root.querySelector<HTMLInputElement>('[data-manual]');
  const composer = element<HTMLFormElement>(root, '[data-composer]');
  const messages = element(root, '[data-messages]');
  const divider = element(root, '[data-chat-divider]');
  const input = element<HTMLTextAreaElement>(composer, 'textarea');
  const send = element<HTMLButtonElement>(composer, 'button[type="submit"]');
  const connect = element<HTMLButtonElement>(composer, '[data-connect]');
  const modelControls = element(composer, '[data-model-controls]');
  const modelTrigger = element<HTMLButtonElement>(modelControls, '[data-model-picker]');
  const optionsTrigger = element<HTMLButtonElement>(modelControls, '[data-model-parameters]');
  const clearChat = element<HTMLButtonElement>(root, '[data-clear-chat]');
  const status = element(root, '[data-run-status]');
  const stageStatus = element(root, '[data-stage-status]');
  const debug = root.querySelector<HTMLElement>('[data-run-debug]');
  const requestTracker = debug ? { stats: emptyRequestStats(), onChange: refreshDebug } : undefined;
  const doneBadge = element(root, '[data-completed]');
  const resetButton = element<HTMLButtonElement>(root, '[data-reset]');
  const gameOver = element(root, '[data-game-over]');
  const retryRun = element<HTMLButtonElement>(gameOver, '[data-retry-run]');
  const result = root.querySelector<HTMLDialogElement>('[data-level-result]');
  const playNext = root.querySelector<HTMLAnchorElement>('[data-play-next]');
  if (options.nextLevel) {
    if (playNext) {
      playNext.href = options.nextLevel;
      playNext.hidden = !options.completedAt;
    }
    if (result) {
      const next = element<HTMLAnchorElement>(result, '[data-next-level]');
      next.href = options.nextLevel;
      next.hidden = false;
    }
  }

  let level = options.level;
  let catalog = options.catalog;
  let model = findModel(catalog, catalog.defaultModel);
  let selection: ModelSettings | undefined;

  // 更新页面内的模型选择。正在生成时，由当前回合继续使用原 Agent。
  const picker = modelPicker(root, modelTrigger, optionsTrigger, signal, (picked) => {
    selection = model = picked;
    refreshIdleAgent();
    picker.showModel(model);
    refreshStatus();
  });
  picker.showModel(model);
  let username = options.username;
  const entries = new WeakMap<ChatEvent, HTMLElement>();
  let manual = false;
  let paused = false;
  let resultPending = false;
  let resultReadyAt: number | undefined;
  let resultTimer: number | undefined;
  let agent: Agent | undefined;
  let lastRecord = 0;

  // 本局计时和最近一次有效动作的模型随场景创建及重置。
  let firstPromptAt: number | undefined;
  let actionModel: string | undefined;
  let saveError = '';
  let saveNumber = 0;
  title.textContent = level.name;
  doneBadge.hidden = !options.completedAt;
  if (options.completedAt) doneBadge.title = new Date(options.completedAt).toLocaleString();

  // 判断当前关卡状态是否允许发起对话。
  function canChat() {
    const outcome = runtime.world.outcome;
    return outcome === 'active' || (outcome === 'won' && result !== null && !resultPending);
  }

  // 根据关卡、模型和当前回合同步聊天控件。
  function refreshStatus() {
    const busy = agent?.busy ?? false;
    const chat = canChat() && !manual;
    const won = runtime.world.outcome === 'won';

    // 同一按钮在生成期间用于中断，结算等待期间则禁用输入。
    send.disabled = resultPending || (!busy && (!agent || !chat || !input.value.trim()));
    send.textContent = busy ? '中断' : '发送';
    connect.textContent = username ? '配置模型' : '设置用户名';
    connect.hidden = Boolean(model && username) || manual;
    modelControls.hidden = !model || !username || manual;
    modelTrigger.disabled = optionsTrigger.disabled = !chat && !resultPending;
    if (modelControls.hidden || modelTrigger.disabled) picker.close();
    input.disabled = !chat;
    input.placeholder = won && chat ? '和 Vibe 聊聊…' : '告诉 Vibe 下一步怎么做…';
    clearChat.hidden = won && result !== null;
    clearChat.disabled = conversation.events.length === 0;
    status.textContent = manual ? '手动控制中' : busy ? (won ? 'Vibe 回复中' : 'Vibe 行动中')
      : !chat ? '关卡已结束' : agent ? (won ? '等待消息' : '等待指令') : '';
  }

  // 刷新手动操作录像及复制按钮状态。
  function refreshRecording() {
    const recorder = runtime.recorder;
    if (!recorded || !recordedStatus || !recordingPanel || !copy) return;
    recordingPanel.hidden = !manual && !recorder?.started;
    const actions = recorder?.actions() ?? [];
    const formatted = JSON.stringify({ actions }, null, 2);

    // 仅在录像内容变化时写入文本框，避免刷新相同内容打断选中。
    if (recorded.value !== formatted) recorded.value = formatted;
    copy.disabled = actions.length === 0;
    recordedStatus.textContent = !recorder?.started ? '等待首次操作'
      : recorder.tooLong ? '超过单次工具调用限额' : `${actions.length} 个动作`;
  }

  // 委托编辑器绘制覆盖层，或直接绘制游玩场景。
  function draw(snapshot: Snapshot) {
    if (editor) editor.draw(canvas, snapshot);
    else drawScene(canvas, snapshot);
  }

  // 更新场景的通关、坠落和保存提示。
  function refreshStage() {
    const outcome = runtime.world.outcome;
    stageStatus.classList.toggle('success', outcome === 'won');
    stageStatus.classList.toggle('invalid', outcome === 'lost');
    resetButton.hidden = outcome === 'lost' || (outcome === 'won' && result !== null);
    resetButton.textContent = outcome === 'active' ? '重置关卡' : '重开关卡';
    gameOver.hidden = outcome !== 'lost';
    if (outcome === 'lost') stageStatus.textContent = '角色掉出地图，已死亡';
    else if (outcome === 'won') stageStatus.textContent = '通关成功，红色按钮已踩下';
    else stageStatus.innerHTML = manual
      ? '<kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd> 移动 <span class="divider">·</span> <kbd>W</kbd> <kbd>↑</kbd> <kbd>空格</kbd> 跳跃'
      : '<i class="target-dot"></i>通关目标：踩下红色按钮';
    if (saveError) stageStatus.textContent += ` · ${saveError}`;
  }

  // 计算从首次发言起的本局耗时。
  function elapsedTime() {
    return firstPromptAt === undefined ? undefined : Math.round(performance.now() - firstPromptAt);
  }

  // 在场景和结算弹窗中展示最新一次保存的结果。
  function watchSave(pending: Promise<unknown>, failure: string) {
    const number = ++saveNumber;

    function showError(message: string) {
      if (signal.aborted || number !== saveNumber || saveError === message) return;
      saveError = message;
      refreshStage();
      if (result) {
        const error = element(result, '[data-result-error]');
        error.hidden = !message;
        error.textContent = message;
      }
    }

    void pending.then(() => showError(''), () => showError(failure));
  }

  // 处理坠落反馈和通关结算。
  function ended(outcome: Outcome) {
    const durationMS = outcome === 'won' ? elapsedTime() : undefined;
    refreshStage();
    if (outcome === 'lost') {
      stopAgent();
      retryRun.focus({ preventScroll: true });
    } else if (outcome === 'won' && result) {
      resultPending = true;
      doneBadge.hidden = false;
      if (playNext?.hasAttribute('href')) playNext.hidden = false;
      const time = element(result, '[data-result-duration]');
      time.hidden = durationMS === undefined;
      if (durationMS !== undefined) time.textContent = `通关耗时 · ${formatDuration(durationMS)}`;

      // 为本次通关生成独立的尝试 ID，允许服务端识别重复提交。
      const attemptID = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0')).join('');
      if (options.onCompletion) {
        watchSave(options.onCompletion({ attemptID, model: actionModel, durationMS }), '无法保存通关记录');
      }
      void requestVictoryReply();
    }
    refreshRecording();
    refreshStatus();
  }

  // 在共享对话中向模型发送隐藏的通关事件。
  async function requestVictoryReply() {
    // Disposing the previous agent aborts its turn and retains its output in the shared conversation.
    replaceAgent();
    delete conversation.interrupted;
    delete conversation.pendingSystemInfo;
    const current = agent;
    const replyModel = model;
    const replyUsername = username;
    if (current) await current.send(victoryPrompt, level.systemPrompt ?? defaultPrompt, { hidden: true });

    // 场景重置、卸载或 Agent 切换期间收到的旧通关答复不会触发结算。
    if (signal.aborted || !resultPending || current !== agent) return;
    resultReadyAt = performance.now() + resultDelayMS;
    if (model !== replyModel || username !== replyUsername) replaceAgent();
    showResultWhenReady();
    refreshStatus();
  }

  // 等模型答复、展示延迟和暂停状态允许后打开结算弹窗。
  function showResultWhenReady() {
    if (!result || !resultPending || resultReadyAt === undefined) return;
    const remaining = resultReadyAt - performance.now();
    if (remaining > 0) {
      resultTimer ??= window.setTimeout(() => {
        resultTimer = undefined;
        showResultWhenReady();
      }, Math.ceil(remaining));
      return;
    }

    // 暂停时保留就绪结算，恢复场景后再检查是否可显示。
    if (paused) return;
    result.showModal();
    resultPending = false;
    refreshStatus();
  }

  // 在没有对话时展示对应模式的初始提示。
  function showEmptyChat() {
    messages.innerHTML = `
      <div class="chat-empty">
        <img class="vibe-mark" src="/favicon.svg" alt="" width="32" height="32">
        <strong>告诉 Vibe 该做什么</strong>
        <p>${editor ? '描述你希望 Vibe 怎样探索这张地图。' : '试着说「走到右边的红色按钮上」'}</p>
      </div>`;
  }

  // 关闭当前 Agent 并取消排队的游戏动作。
  function stopAgent() {
    agent?.dispose();
    agent = undefined;
    runtime.cancelSequence();
  }

  // 显示模型请求数、Token 用量、缓存和生成速率。
  function refreshDebug() {
    if (!debug || !requestTracker) return;
    const { stats } = requestTracker;
    const totalCacheRatio = stats.inputTokensWithCacheData ? stats.cachedTokens / stats.inputTokensWithCacheData : undefined;
    const lastOutputRate = stats.lastOutputRate;
    debug.textContent = [
      `Turn: ${stats.turns}`,
      `Input Tokens: ${formatTokens(stats.inputTokens)} (Cached total: ${formatRatio(totalCacheRatio)} / last: ${formatRatio(stats.lastCacheRatio)})`,
      `Output Tokens: ${formatTokens(stats.outputTokens)} (${lastOutputRate === undefined ? '—' : `${Math.round(lastOutputRate)} tok/s`})`,
    ].join('    ');
  }

  // 使用当前模型及运行时回调创建 Agent，并接续现有对话。
  function replaceAgent() {
    stopAgent();
    const outcome = runtime.world.outcome;
    if (!model || !username || (outcome !== 'active' && !(outcome === 'won' && result))) return;
    const agentModel = model;
    agent = new Agent(agentModel, defaultPrompt, {
      whenActive: (requestSignal) => runtime.whenActive(requestSignal),
      isReadScreenDisabled: () => level.disableReadScreen ?? false,
      readScreen: (disabled) => captureScene(runtime.world.snapshot(), disabled),
      execute: (steps, requestSignal) => runtime.execute(steps, requestSignal, () => {
        actionModel = agentModel.model;
      }),
      outcome: () => runtime.world.outcome,
    }, (event) => {
      appendEvent(messages, event, entries, username);
      refreshStatus();
    }, conversation, username, requestTracker);
  }

  // 生成和通关答复结束前保留当前 Agent 及其模型快照。
  function refreshIdleAgent() {
    if (!agent?.busy && (!resultPending || resultReadyAt !== undefined)) replaceAgent();
  }

  // 重开物理世界，清理本局计时及结算状态。
  function reset() {
    if (runtime.world.outcome === 'lost') conversation.pendingSystemInfo = respawnInfo;
    resultPending = false;
    resultReadyAt = undefined;
    window.clearTimeout(resultTimer);
    resultTimer = undefined;
    firstPromptAt = undefined;
    actionModel = undefined;
    runtime.reset(level, manual);
    replaceAgent();
    draw(runtime.world.snapshot());
    refreshStage();
    refreshStatus();
    refreshRecording();
  }

  // 驱动场景绘制，并对录像面板更新限频。
  const runtime = new Runtime(level, false, (snapshot) => {
    draw(snapshot);
    const now = performance.now();
    if (manual && snapshot.outcome === 'active' && now - lastRecord >= 100) {
      refreshRecording();
      lastRecord = now;
    }
  }, ended);
  for (const event of conversation.events) appendEvent(messages, event, entries, username);
  if (!messages.childElementCount) showEmptyChat();
  replaceAgent();
  refreshStage();
  refreshStatus();
  refreshDebug();

  if (options.onEnter) watchSave(options.onEnter(), '无法记录最近游玩的关卡');

  // 根据侧栏空间计算编辑区可用高度。
  function chatHeightRange() {
    const min = parseFloat(getComputedStyle(messages).minHeight);
    const total = messages.offsetHeight + composer.offsetHeight;
    const max = Math.max(min, total - parseFloat(getComputedStyle(composer).minHeight));
    return { min, max, total };
  }

  // 将聊天输入区高度限制在可用范围内。
  function resizeChat(height: number) {
    const { min, max, total } = chatHeightRange();
    composer.style.height = `${total - Math.min(max, Math.max(min, height))}px`;
  }

  const chatResize = new ResizeObserver(() => {
    const { min, max } = chatHeightRange();
    divider.setAttribute('aria-valuemin', String(min));
    divider.setAttribute('aria-valuemax', String(max));
    divider.setAttribute('aria-valuenow', String(messages.offsetHeight));
  });
  chatResize.observe(messages);
  chatResize.observe(composer);

  let drag: { pointer: number; y: number; historyHeight: number } | undefined;
  divider.addEventListener('pointerdown', (event) => {
    if (drag || event.button !== 0) return;
    divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, y: event.clientY, historyHeight: messages.offsetHeight };
    event.preventDefault();
  }, { signal });
  window.addEventListener('pointermove', (event) => {
    if (drag?.pointer === event.pointerId) resizeChat(drag.historyHeight + event.clientY - drag.y);
  }, { signal });

  // 结束聊天分隔条的指针调整。
  function finishDrag(event: PointerEvent) {
    if (drag?.pointer === event.pointerId) drag = undefined;
  }
  window.addEventListener('pointerup', finishDrag, { signal });
  window.addEventListener('pointercancel', finishDrag, { signal });
  divider.addEventListener('lostpointercapture', finishDrag, { signal });
  divider.addEventListener('keydown', (event) => {
    const height = messages.offsetHeight;
    switch (event.key) {
      case 'ArrowUp': resizeChat(height - 16); break;
      case 'ArrowDown': resizeChat(height + 16); break;
      case 'Home': resizeChat(chatHeightRange().min); break;
      case 'End': resizeChat(chatHeightRange().max); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, { signal });

  // 关闭结算弹窗并通过统一入口重开本局。
  function restart() {
    reset();
    if (manual) canvas.focus();
    else if (agent) input.focus();
    else connect.focus();
  }

  resetButton.addEventListener('click', restart, { signal });
  retryRun.addEventListener('click', restart, { signal });
  if (result) {
    element(result, '[data-stay]').addEventListener('click', () => result.close(), { signal });
    result.addEventListener('close', () => {
      if (!paused && runtime.world.outcome === 'won') input.focus({ preventScroll: true });
    }, { signal });
  }

  // 在模型输入和键盘记录模式之间切换。
  manualSwitch?.addEventListener('change', () => {
    manual = manualSwitch.checked;

    // 进入手动模式从新局开始录制，离开时可保留当前场景和录像。
    if (manual) {
      reset();
      canvas.focus();
    } else {
      runtime.releaseManualControl();
      draw(runtime.world.snapshot());
      refreshStage();
      refreshStatus();
      refreshRecording();
    }
  }, { signal });

  // 清空共享对话并重建当前 Agent。
  clearChat.addEventListener('click', () => {
    if (resultPending) return;

    // 先结束旧回合，让其中断回调写完共享历史，再清空对话。
    replaceAgent();
    conversation.events.length = conversation.history.length = 0;
    delete conversation.protocol;
    delete conversation.modelSource;
    delete conversation.usage;
    if (requestTracker) requestTracker.stats = emptyRequestStats();
    delete conversation.summary;
    delete conversation.interrupted;
    input.value = '';
    showEmptyChat();
    refreshStatus();
    refreshDebug();
  }, { signal });

  connect.addEventListener('click', options.openSettings, { signal });
  modelTrigger.addEventListener('click', () => { if (model) picker.prepare(catalog, model); }, { signal });
  input.addEventListener('input', refreshStatus, { signal });
  input.addEventListener('keydown', (event) => {
    // 普通回车用于发送，Shift 回车或输入法组合期间保留文字输入行为。
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!agent?.busy && !send.disabled) composer.requestSubmit();
    }
  }, { signal });

  // 发送玩家指示，或中断正在进行的对话。
  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (resultPending) return;
    if (agent?.busy) {
      agent.interrupt();
      return;
    }

    const text = input.value.trim();
    if (send.disabled || !agent || !text) return;
    const current = agent;
    const turnModel = model;
    const turnUsername = username;
    input.value = '';

    // 收到首条有效玩家指令时开始计时。
    firstPromptAt ??= performance.now();

    await current.send(text, level.systemPrompt ?? defaultPrompt);

    // 确认仍是当前场景的活跃回合，再同步模型和界面。
    if (!signal.aborted && current === agent) {
      if (model !== turnModel || username !== turnUsername) replaceAgent();
      refreshStatus();
    }
  }, { signal });

  // 复制动作 JSON，并兼容剪贴板接口不可用的情况。
  copy?.addEventListener('click', async () => {
    if (!recorded || !recordedStatus) return;
    refreshRecording();
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(recorded.value);
    } catch {
      recorded.select();
      if (!document.execCommand('copy')) {
        recordedStatus.textContent = '已选中 JSON，可按复制快捷键';
        return;
      }
    }
    recordedStatus.textContent = '已复制';
    lastRecord = performance.now() + 1500;
  }, { signal });

  return {
    canvas,
    reset,
    // 应用编辑结果，物理参数改变时重置试玩。
    updateLevel(next: LevelDefinition) {
      // 只有影响世界状态的编辑会重开试玩，文字和工具选项立即使用新值。
      const changed = next.tiles !== level.tiles || next.spawn.x !== level.spawn.x || next.spawn.y !== level.spawn.y ||
        next.gravity !== level.gravity || next.inertia !== level.inertia;
      level = next;
      title.textContent = level.name;
      if (changed) reset();
    },
    redraw() { draw(runtime.world.snapshot()); },
    // 根据最新目录刷新所选模型并尽量保留临时参数。
    onSettingsChange(next: ModelCatalog, nextUsername: string) {
      catalog = next;

      // 本局选择仍存在时保留参数覆盖值，模型被删时回退到最新默认项。
      const selected = selection && findModel(next, selection.model);
      if (selected && selection) {
        model = { ...selected, maxInputToken: selection.maxInputToken, reasoningEffort: selection.reasoningEffort };
      } else {
        selection = undefined;
        model = findModel(next, next.defaultModel);
      }
      picker.showModel(model);
      username = nextUsername;
      refreshIdleAgent();
      refreshStatus();
    },
    // 协调物理暂停、界面状态和待显示的结算。
    setPaused(nextPaused: boolean) {
      paused = nextPaused;
      runtime.setPaused(paused);
      if (paused) {
        picker.close();
        refreshRecording();
      } else {
        if (manual) canvas.focus();
        showResultWhenReady();
        refreshStatus();
      }
    },
    // 卸载场景时清理监听、计时和运行时。
    dispose() {
      window.clearTimeout(resultTimer);
      result?.close();
      picker.close();
      chatResize.disconnect();

      events.abort();
      agent?.dispose();
      runtime.dispose();
    },
  };
}

// 把 Token 数缩写为调试面板用的可读数值。
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(2)}K`;
  return String(count);
}

// 将缓存命中率格式化为百分比。
function formatRatio(ratio: number | undefined): string {
  return ratio === undefined ? '—' : `${Math.round(ratio * 100)}%`;
}

// 按事件类型创建或复用聊天节点以显示流式内容。
function appendEvent(log: HTMLElement, event: ChatEvent, entries: WeakMap<ChatEvent, HTMLElement>, username: string) {
  if (event.kind === 'player' && event.hidden) return;
  const follow = log.scrollHeight - log.clientHeight - log.scrollTop < 30;
  const existing = entries.get(event);
  if (existing) {
    existing.textContent = event.text;
    if (follow) log.scrollTop = log.scrollHeight;
    return;
  }
  log.querySelector('.chat-empty')?.remove();
  if (event.kind === 'tool') {
    const entry = document.createElement('details');
    entry.className = 'tool-event';
    const title = document.createElement('summary');
    title.textContent = event.text;
    entries.set(event, title);
    entry.append(title);
    if (event.image) {
      const image = document.createElement('img');
      image.src = event.image;
      image.alt = 'Vibe 看到的关卡截图';
      entry.append(image);
    } else if (event.detail !== undefined) {
      const content = document.createElement('pre');
      content.textContent = event.detail;
      entry.append(content);
    }
    log.append(entry);
  } else if (event.kind === 'thinking') {
    const entry = document.createElement('details');
    entry.className = 'message thinking';
    const title = document.createElement('summary');
    title.textContent = '思考';
    const content = document.createElement('p');
    content.textContent = event.text;
    entries.set(event, content);
    entry.append(title, content);
    log.append(entry);
  } else {
    const entry = document.createElement('div');
    entry.className = `message ${event.kind}`;
    const name = document.createElement('span');
    name.textContent = event.kind === 'assistant' ? 'Vibe' : event.kind === 'player' ? username : '连接提示';
    const content = document.createElement('p');
    content.textContent = event.text;
    entries.set(event, content);
    entry.append(name, content);
    log.append(entry);
  }
  if (follow || event.kind === 'player') log.scrollTop = log.scrollHeight;
}
