import { Agent, defaultPrompt } from '../agent/agent.ts';
import type { ChatEvent } from '../agent/agent.ts';
import type { ModelSettings } from '../agent/settings.ts';
import { Runtime } from '../game/runtime.ts';
import type { Outcome, Snapshot } from '../game/world.ts';
import type { LevelDefinition } from '../level/definition.ts';
import { captureScene, drawScene } from '../render/scene.ts';
import { element } from './elements.ts';

export type RunMode = 'play' | 'agent' | 'manual';
type RunOptions = {
  mode: RunMode;
  level: LevelDefinition;
  model: ModelSettings | null;
  completedAt?: string;
  onComplete: () => void;
  reset: () => void;
  back: () => void;
  openSettings: () => void;
};

export function mountRun(root: HTMLElement, options: RunOptions) {
  const manual = options.mode === 'manual';
  const preview = options.mode !== 'play';
  root.innerHTML = `
    <div class="workspace-bar">
      <div class="workspace-title"><h1 data-level-title></h1><span class="completion" data-completed hidden>已通关</span></div>
      <div class="toolbar">
        ${preview ? '<button type="button" data-back>返回编辑</button>' : ''}
        <button type="button" data-reset>${preview ? '重开' : '重置'}</button>
        <button type="button" data-pause>暂停</button>
      </div>
    </div>
    <div class="run-layout">
      <aside class="panel run-sidebar">
        <div class="sidebar-header"><h2>${manual ? '动作记录' : '与 Agent 对话'}</h2><span class="subtle" data-run-status></span></div>
        ${manual ? `
          <textarea class="recording" data-record aria-label="动作记录 JSON" wrap="off" readonly></textarea>
          <div class="sidebar-footer"><span class="subtle" data-record-status></span><button type="button" data-copy>复制 JSON</button></div>
        ` : `
          <div class="messages" role="log" aria-label="对话与工具事件" data-messages></div>
          <form class="composer" data-composer>
            <textarea aria-label="发给 Agent 的消息" placeholder="告诉 Agent 下一步怎么做…" rows="3" required></textarea>
            <div class="composer-footer"><button class="text-button" type="button" data-connect>配置模型</button><button class="primary" type="submit" disabled>发送</button></div>
          </form>
        `}
      </aside>
      <section class="panel stage-panel" aria-label="关卡画面">
        <div class="stage"><canvas width="960" height="540" aria-label="游戏画面" ${manual ? 'tabindex="0"' : ''}></canvas></div>
        <div class="stage-footer">
          <span data-stage-status role="status">${manual ? '<kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd> 移动 <span class="divider">·</span> <kbd>W</kbd> <kbd>↑</kbd> <kbd>空格</kbd> 跳跃' : '<i class="target-dot"></i>目标：踩下红色按钮'}</span>
          <span class="muted">${manual ? '手动试玩' : preview ? 'Agent 试玩' : ''}</span>
        </div>
      </section>
    </div>
    <dialog data-pause-menu class="pause-menu" aria-labelledby="pause-title">
      <div class="dialog-header"><h2 id="pause-title">游戏已暂停</h2></div>
      <div class="pause-actions">
        <button type="button" class="primary" data-resume>继续</button>
        <button type="button" data-menu-reset>${preview ? '重开' : '重置'}</button>
        <button type="button" data-menu-back>${preview ? '返回编辑' : '前往创作'}</button>
      </div>
    </dialog>`;

  const events = new AbortController();
  const { signal } = events;
  const canvas = element<HTMLCanvasElement>(root, 'canvas');
  const recorded = root.querySelector<HTMLTextAreaElement>('[data-record]');
  const recordedStatus = root.querySelector<HTMLElement>('[data-record-status]');
  const composer = root.querySelector<HTMLFormElement>('[data-composer]');
  const messages = root.querySelector<HTMLElement>('[data-messages]');
  const input = composer?.querySelector('textarea');
  const send = composer?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const connect = composer?.querySelector<HTMLButtonElement>('[data-connect]');
  const status = element(root, '[data-run-status]');
  const stageStatus = element(root, '[data-stage-status]');
  const doneBadge = element(root, '[data-completed]');
  const pauseMenu = element<HTMLDialogElement>(root, '[data-pause-menu]');

  let agent: Agent | undefined;
  let lastRecord = 0;
  let runtime: Runtime | undefined;
  element(root, '[data-level-title]').textContent = options.level.name;
  doneBadge.hidden = !options.completedAt;
  if (options.completedAt) doneBadge.title = new Date(options.completedAt).toLocaleString();

  function refreshStatus() {
    if (manual) {
      status.textContent = runtime?.world.outcome === 'active' ? '录制中' : '录制结束';
      return;
    }
    const busy = agent?.busy ?? false;
    const ended = runtime?.world.outcome !== 'active';
    if (send) send.disabled = !agent || busy || ended || !input?.value.trim();
    if (connect) connect.hidden = Boolean(agent);
    if (input) input.disabled = ended;
    status.textContent = busy ? 'Agent 行动中' : ended ? '关卡已结束' : agent ? '等待指令' : '待配置模型';
  }

  function refreshRecording() {
    const recorder = runtime?.recorder;
    if (!recorded || !recorder) return;
    const actions = recorder.actions();
    const formatted = JSON.stringify({ actions }, null, 2);
    if (recorded.value !== formatted) recorded.value = formatted;
    if (recordedStatus) recordedStatus.textContent = recorder.tooLong ? '超过单次工具调用限额' : `${actions.length} 个动作`;
  }

  function draw(snapshot: Snapshot) {
    drawScene(canvas, snapshot);
    if (manual && snapshot.outcome === 'active' && performance.now() - lastRecord >= 100) {
      refreshRecording();
      lastRecord = performance.now();
    }
  }

  function ended(outcome: Outcome) {
    stageStatus.textContent = outcome === 'won' ? '通关成功，红色按钮已踩下' : '角色离开了画面，请重开关卡';
    stageStatus.classList.add(outcome === 'won' ? 'success' : 'invalid');
    if (outcome === 'won' && !preview) {
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

  function onModelChange(model: ModelSettings | null) {
    if (manual || !runtime || !messages) return;
    const worldRun = runtime;
    agent?.dispose();
    worldRun.cancelSequence();
    messages.innerHTML = `
      <div class="chat-empty">
        <span class="agent-mark" aria-hidden="true">··</span>
        <strong>告诉 Agent 下一步</strong>
        <p>${preview ? '描述你希望 Agent 怎样探索这张地图。' : '试着说「先看看画面，再向右走到红色按钮。」'}</p>
      </div>`;
    agent = model ? new Agent(model, options.level.systemPrompt ?? defaultPrompt, {
      whenActive: (requestSignal) => worldRun.whenActive(requestSignal),
      readScreen: () => captureScene(worldRun.world.snapshot()),
      execute: (steps) => worldRun.execute(steps),
      outcome: () => worldRun.world.outcome,
    }, (event) => appendEvent(messages, event)) : undefined;
    refreshStatus();
  }

  function reset() {
    pauseMenu.close();
    options.reset();
  }

  element(root, '[data-pause]').addEventListener('click', () => {
    runtime?.setPaused(true);
    refreshRecording();
    pauseMenu.showModal();
  }, { signal });
  pauseMenu.addEventListener('close', () => { runtime?.setPaused(false); }, { signal });
  element(root, '[data-resume]').addEventListener('click', () => {
    pauseMenu.close();
    if (manual) canvas.focus();
  }, { signal });
  element(root, '[data-reset]').addEventListener('click', reset, { signal });
  element(root, '[data-menu-reset]').addEventListener('click', reset, { signal });
  element(root, '[data-menu-back]').addEventListener('click', options.back, { signal });
  root.querySelector('[data-back]')?.addEventListener('click', options.back, { signal });

  connect?.addEventListener('click', options.openSettings, { signal });
  input?.addEventListener('input', refreshStatus, { signal });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send?.disabled) composer?.requestSubmit();
    }
  }, { signal });
  composer?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input?.value.trim();
    if (!input || !agent || agent.busy || !text || runtime?.world.outcome !== 'active') return;
    const current = agent;
    input.value = '';
    const turn = current.send(text);
    refreshStatus();
    await turn;
    if (!signal.aborted && current === agent) refreshStatus();
  }, { signal });

  root.querySelector('[data-copy]')?.addEventListener('click', async () => {
    if (!recorded) return;
    refreshRecording();
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(recorded.value);
    } catch {
      recorded.select();
      if (!document.execCommand('copy')) {
        if (recordedStatus) recordedStatus.textContent = '已选中 JSON，可按复制快捷键';
        return;
      }
    }
    if (recordedStatus) recordedStatus.textContent = '已复制';
    lastRecord = performance.now() + 1500;
  }, { signal });

  runtime = new Runtime(options.level, manual, draw, ended);
  if (manual) {
    canvas.focus();
    refreshRecording();
    refreshStatus();
  } else {
    onModelChange(options.model);
  }

  return {
    onModelChange,
    dispose() {
      events.abort();
      agent?.dispose();
      runtime?.dispose();
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
