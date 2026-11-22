import { Agent, defaultPrompt } from '../agent/agent.ts';
import type { ChatEvent, Conversation } from '../agent/agent.ts';
import type { ModelSettings } from '../agent/settings.ts';
import { Runtime } from '../game/runtime.ts';
import type { Outcome, Snapshot } from '../game/world.ts';
import type { LevelDefinition } from '../level/definition.ts';
import { captureScene, drawScene } from '../render/scene.ts';
import { element } from './elements.ts';

type RunOptions = {
  level: LevelDefinition;
  model: ModelSettings | null;
  conversation: Conversation;
  completedAt?: string;
  onComplete?: () => void;
  openSettings: () => void;
  editor?: {
    draw: (canvas: HTMLCanvasElement, snapshot: Snapshot) => void;
  };
};

export function mountRun(root: HTMLElement, options: RunOptions) {
  const { editor, conversation } = options;
  root.innerHTML = `
    <div class="run-layout">
      <aside class="panel run-sidebar">
        <div class="sidebar-header"><h2>与 Agent 对话</h2><button class="text-button" type="button" data-clear-chat disabled>清空历史</button></div>
        <div class="messages" role="log" aria-label="对话与工具事件" data-messages></div>
        <form class="composer" data-composer>
          <textarea aria-label="发给 Agent 的消息" placeholder="告诉 Agent 下一步怎么做…" rows="3" required></textarea>
          <div class="composer-footer"><span class="subtle" data-run-status></span><button class="text-button" type="button" data-connect>配置模型</button><button class="primary" type="submit" disabled>发送</button></div>
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
        <div class="stage"><canvas width="960" height="540" aria-label="游戏画面" tabindex="-1"></canvas></div>
        <div class="stage-footer">
          <span data-stage-status role="status"></span>
          <div class="run-actions">
            ${editor ? '<label class="manual-control"><input type="checkbox" role="switch" data-manual>手动控制</label>' : ''}
            <button type="button" data-reset>重置关卡</button>
          </div>
        </div>
      </section>
    </div>`;

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
  const input = element<HTMLTextAreaElement>(composer, 'textarea');
  const send = element<HTMLButtonElement>(composer, 'button[type="submit"]');
  const connect = element<HTMLButtonElement>(composer, '[data-connect]');
  const clearChat = element<HTMLButtonElement>(root, '[data-clear-chat]');
  const status = element(root, '[data-run-status]');
  const stageStatus = element(root, '[data-stage-status]');
  const doneBadge = element(root, '[data-completed]');
  const resetButton = element<HTMLButtonElement>(root, '[data-reset]');

  let level = options.level;
  let model = options.model;
  let manual = false;
  let agent: Agent | undefined;
  let lastRecord = 0;
  title.textContent = level.name;
  doneBadge.hidden = !options.completedAt;
  if (options.completedAt) doneBadge.title = new Date(options.completedAt).toLocaleString();

  function refreshStatus() {
    const busy = agent?.busy ?? false;
    const ended = runtime.world.outcome !== 'active';
    send.disabled = !agent || busy || ended || manual || !input.value.trim();
    connect.hidden = Boolean(model) || manual;
    input.disabled = ended || manual;
    clearChat.disabled = conversation.events.length === 0;
    status.textContent = manual ? '手动控制中' : busy ? 'Agent 行动中' : ended ? '关卡已结束' : agent ? '等待指令' : '';
  }

  function refreshRecording() {
    const recorder = runtime.recorder;
    if (!recorded || !recordedStatus || !recordingPanel || !copy) return;
    recordingPanel.hidden = !manual && !recorder?.started;
    const actions = recorder?.actions() ?? [];
    const formatted = JSON.stringify({ actions }, null, 2);
    if (recorded.value !== formatted) recorded.value = formatted;
    copy.disabled = actions.length === 0;
    recordedStatus.textContent = !recorder?.started ? '等待首次操作'
      : recorder.tooLong ? '超过单次工具调用限额' : `${actions.length} 个动作`;
  }

  function draw(snapshot: Snapshot) {
    if (editor) editor.draw(canvas, snapshot);
    else drawScene(canvas, snapshot);
  }

  function refreshStage() {
    const outcome = runtime.world.outcome;
    stageStatus.classList.toggle('success', outcome === 'won');
    stageStatus.classList.toggle('invalid', outcome === 'lost');
    resetButton.textContent = outcome === 'active' ? '重置关卡' : '重开关卡';
    if (outcome === 'lost') stageStatus.textContent = '角色掉出地图，已死亡';
    else if (outcome === 'won') stageStatus.textContent = '通关成功，红色按钮已踩下';
    else stageStatus.innerHTML = manual
      ? '<kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd> 移动 <span class="divider">·</span> <kbd>W</kbd> <kbd>↑</kbd> <kbd>空格</kbd> 跳跃'
      : '<i class="target-dot"></i>踩下红色按钮';
  }

  function ended(outcome: Outcome) {
    refreshStage();
    if (outcome === 'won' && options.onComplete) {
      doneBadge.hidden = false;
      try {
        options.onComplete();
      } catch {
        stageStatus.textContent += ' · 浏览器无法保存进度';
      }
    }
    refreshRecording();
    refreshStatus();
  }

  function showEmptyChat() {
    messages.innerHTML = `
      <div class="chat-empty">
        <span class="agent-mark" aria-hidden="true">··</span>
        <strong>告诉 Agent 下一步</strong>
        <p>${editor ? '描述你希望 Agent 怎样探索这张地图。' : '试着说「先看看画面，再向右走到红色按钮。」'}</p>
      </div>`;
  }

  function replaceAgent() {
    agent?.dispose();
    runtime.cancelSequence();
    agent = model ? new Agent(model, defaultPrompt, {
      whenActive: (requestSignal) => runtime.whenActive(requestSignal),
      readScreen: () => captureScene(runtime.world.snapshot()),
      execute: (steps) => runtime.execute(steps),
      outcome: () => runtime.world.outcome,
    }, (event) => {
      appendEvent(messages, event);
      refreshStatus();
    }, conversation) : undefined;
  }

  function reset() {
    replaceAgent();
    runtime.reset(level, manual);
    draw(runtime.world.snapshot());
    refreshStage();
    refreshStatus();
    refreshRecording();
  }

  const runtime = new Runtime(level, false, (snapshot) => {
    draw(snapshot);
    const now = performance.now();
    if (manual && snapshot.outcome === 'active' && now - lastRecord >= 100) {
      refreshRecording();
      lastRecord = now;
    }
  }, ended);
  if (conversation.events.length === 0) showEmptyChat();
  else for (const event of conversation.events) appendEvent(messages, event);
  replaceAgent();
  refreshStage();
  refreshStatus();

  resetButton.addEventListener('click', () => {
    reset();
    if (manual) canvas.focus();
  }, { signal });
  manualSwitch?.addEventListener('change', () => {
    manual = manualSwitch.checked;
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
  clearChat.addEventListener('click', () => {
    replaceAgent();
    conversation.events.length = conversation.history.length = 0;
    conversation.protocol = undefined;
    input.value = '';
    showEmptyChat();
    refreshStatus();
  }, { signal });

  connect.addEventListener('click', options.openSettings, { signal });
  input.addEventListener('input', refreshStatus, { signal });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) composer.requestSubmit();
    }
  }, { signal });
  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (send.disabled || !agent || !text) return;
    const current = agent;
    input.value = '';
    await current.send(text, level.systemPrompt ?? defaultPrompt);
    if (!signal.aborted && current === agent) refreshStatus();
  }, { signal });

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
    updateLevel(next: LevelDefinition) {
      const changed = next.tiles !== level.tiles || next.spawn.x !== level.spawn.x || next.spawn.y !== level.spawn.y ||
        next.gravity !== level.gravity || next.inertia !== level.inertia;
      level = next;
      title.textContent = level.name;
      if (changed) reset();
    },
    redraw() { draw(runtime.world.snapshot()); },
    onModelChange(next: ModelSettings | null) {
      model = next;
      replaceAgent();
      refreshStatus();
    },
    setPaused(paused: boolean) {
      runtime.setPaused(paused);
      if (paused) refreshRecording();
      else if (manual) canvas.focus();
    },
    dispose() {
      events.abort();
      agent?.dispose();
      runtime.dispose();
    },
  };
}

function appendEvent(log: HTMLElement, event: ChatEvent) {
  log.querySelector('.chat-empty')?.remove();
  if (event.kind === 'tool') {
    const entry = document.createElement('details');
    entry.className = 'tool-event';
    const title = document.createElement('summary');
    title.textContent = event.text;
    entry.append(title);
    if (event.image) {
      const image = document.createElement('img');
      image.src = event.image;
      image.alt = 'Agent 看到的关卡截图';
      entry.append(image);
    } else if (event.detail) {
      const content = document.createElement('pre');
      content.textContent = event.detail;
      entry.append(content);
    }
    log.append(entry);
  } else {
    const entry = document.createElement('div');
    entry.className = `message ${event.kind}`;
    const name = document.createElement('span');
    name.textContent = event.kind === 'assistant' ? 'Agent' : event.kind === 'player' ? '你' : '连接提示';
    const content = document.createElement('p');
    content.textContent = event.text;
    entry.append(name, content);
    log.append(entry);
  }
  log.scrollTop = log.scrollHeight;
}
