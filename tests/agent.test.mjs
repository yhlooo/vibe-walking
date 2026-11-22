import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Agent, defaultPrompt, respawnInfo } from '../src/agent/agent.ts';
import { protocols } from '../src/agent/settings.ts';
import { World } from '../src/game/world.ts';
import { readLevel } from '../src/level/definition.ts';

const flatLevel = readLevel(JSON.parse(readFileSync(new URL('./fixtures/legacy-level.json', import.meta.url))));
const png = 'data:image/png;base64,cG5n';
const actions = { actions: [{ key: 'moveRight', value: 21 }] };

function fixture(protocol, index) {
  const name = index === 1 ? 'ExecActionSequence' : 'ReadScreen';
  const args = index === 1 ? actions : {};
  const id = `call_${index}`;
  const text = '已经踩下红色按钮。';
  if (protocol === 'OpenAIChatCompletions') {
    const tool = { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    const message = index < 3 ? { role: 'assistant', content: null, tool_calls: [tool] } : { role: 'assistant', content: text };
    return { choices: [{ finish_reason: index < 3 ? 'tool_calls' : 'stop', message }] };
  }
  if (protocol === 'OpenAIResponses') {
    const item = index < 3 ? { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }
      : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
    return { status: 'completed', output: [{ type: 'reasoning', encrypted_content: 'opaque' }, item] };
  }
  const block = index < 3 ? { type: 'tool_use', id, name, input: args } : { type: 'text', text };
  return { stop_reason: index < 3 ? 'tool_use' : 'end_turn', content: [block] };
}

function eventBytes(event) {
  return new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`);
}

function sse(stream) {
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

function streamedFixture(protocol, index, inputTokens) {
  const result = fixture(protocol, index);
  let events;
  if (protocol === 'OpenAIChatCompletions') {
    const { finish_reason, message } = result.choices[0];
    const call = message.tool_calls?.[0];
    const chunk = (delta, reason = null) => ({ choices: [{ delta, finish_reason: reason }] });
    if (call) {
      const { name, arguments: args } = call.function;
      events = [
        chunk({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name, arguments: args.slice(0, 1) } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(1) } }] }),
      ];
    } else {
      events = [chunk({ content: message.content.slice(0, 4) }), chunk({ content: message.content.slice(4) })];
    }
    events.push(chunk({}, finish_reason), { choices: [], usage: { prompt_tokens: inputTokens } }, '[DONE]');
  } else if (protocol === 'OpenAIResponses') {
    const item = result.output.at(-1);
    events = item.type === 'message' ? [
      { type: 'response.output_text.delta', delta: item.content[0].text.slice(0, 4) },
      { type: 'response.output_text.delta', delta: item.content[0].text.slice(4) },
    ] : [];
    events.push({ type: 'response.completed', response: { ...result, usage: { input_tokens: inputTokens } } });
  } else {
    const block = result.content[0];
    const index = 1;
    const delta = block.type === 'text' ? { type: 'text_delta', text: block.text } :
      { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
    events = [
      { type: 'message_start', message: { usage: { input_tokens: inputTokens } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看画面' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index, content_block: block.type === 'text' ? { ...block, text: '' } : { ...block, input: {} } },
      { type: 'content_block_delta', index, delta },
      { type: 'content_block_stop', index },
      { type: 'message_delta', delta: { stop_reason: result.stop_reason } },
      { type: 'message_stop' },
    ];
  }
  return sse(new ReadableStream({
    start(controller) {
      for (const event of events) {
        const bytes = eventBytes(event);
        // Split CRLF and allow UTF-8 code points to span chunks.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      }
      controller.close();
    },
  }));
}

function verifyImage(protocol, request, id) {
  if (protocol === 'OpenAIChatCompletions') {
    const [result, screenshot] = request.messages.slice(-2);
    assert.deepEqual(result, { role: 'tool', tool_call_id: id, content: 'Ok' });
    assert.equal(screenshot.role, 'user');
    assert.equal(screenshot.content[1].image_url.url, png);
  } else if (protocol === 'OpenAIResponses') {
    const [reasoning, , screenshot] = request.input.slice(-3);
    assert.equal(reasoning.encrypted_content, 'opaque');
    assert.equal(screenshot.call_id, id);
    assert.deepEqual(screenshot.output, [{ type: 'input_image', image_url: png, detail: 'auto' }]);
  } else {
    assert.deepEqual(request.messages.at(-2).content[0], {
      type: 'thinking', thinking: '先看画面', signature: 'opaque-signature',
    });
    const message = request.messages.at(-1);
    assert.equal(message.role, 'user');
    assert.deepEqual(message.content[0], { type: 'tool_result', tool_use_id: id, content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
    ] });
  }
}

for (const protocol of Object.keys(protocols)) {
  test(`${protocol} reads the screen, acts, and observes the completed level`, async () => {
    const originalFetch = globalThis.fetch;
    const world = new World(flatLevel);
    const events = [];
    const statesSeen = [];
    const requests = [];
    const prompt = '只属于这张关卡的系统提示词';
    const model = { api: protocol, model: 'mock', baseURL: 'http://unused', hasAPIKey: true };
    const agent = new Agent(model, prompt, {
      readScreen() { statesSeen.push(world.outcome); return png; },
      async whenActive() {},
      async execute(steps) { for (const input of steps) world.step(input); },
      outcome: () => world.outcome,
    }, (entry) => { if (!events.includes(entry)) events.push(entry); });
    globalThis.fetch = async (url, request) => {
      assert.equal(url, protocols[protocol].path);
      assert.equal(request.headers.Authorization, undefined);
      const body = JSON.parse(request.body);
      assert.equal(body.instructions ?? body.system ?? body.messages[0].content, prompt);
      assert.equal(body.stream, true);
      requests.push(body);
      return streamedFixture(protocol, requests.length - 1);
    };
    try {
      await agent.send('先读图，再走到按钮。');
      assert.equal(requests.length, 4);
      verifyImage(protocol, requests[1], 'call_0');
      verifyImage(protocol, requests[3], 'call_2');
      assert.deepEqual(statesSeen, ['active', 'won']);
      const expected = ['player', 'tool', 'tool', 'tool', 'assistant'];
      if (protocol === 'AnthropicMessages') {
        assert.equal(events.filter((event) => event.kind === 'thinking').length, 4);
      }
      assert.deepEqual(events.filter((event) => event.kind !== 'thinking').map((event) => event.kind), expected);
      assert.equal(world.outcome, 'won');
      assert.equal(agent.busy, false);
    } finally {
      agent.dispose();
      globalThis.fetch = originalFetch;
    }
  });
}

test('a response arriving after cancellation never schedules an old action', async () => {
  const originalFetch = globalThis.fetch;
  let receive;
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  globalThis.fetch = () => new Promise((resolve) => { receive = resolve; started(); });
  const agent = new Agent({ api: 'OpenAIResponses', model: 'mock', baseURL: '', hasAPIKey: false }, '', {
    readScreen: () => assert.fail('unexpected screenshot'),
    whenActive: async (signal) => signal.throwIfAborted(),
    execute: async () => assert.fail('old action was executed'),
    outcome: () => 'active',
  }, () => {});
  try {
    const pending = agent.send('move');
    await requested;
    agent.dispose();
    receive(streamedFixture('OpenAIResponses', 1));
    await pending;
    assert.equal(agent.busy, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a canceled turn keeps chat, and a respawn notice prefixes only the next user message', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const conversation = { events: [], history: [] };
  const model = { api: 'OpenAIResponses', model: 'mock', baseURL: '', hasAPIKey: false };
  const tools = {
    readScreen: () => png,
    async whenActive(signal) { signal.throwIfAborted(); },
    async execute() {},
    outcome: () => 'active',
  };
  let received;
  const requested = new Promise((resolve) => { received = resolve; });
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    if (requests.length === 1) {
      received();
      await new Promise((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      });
    }
    return streamedFixture('OpenAIResponses', 3);
  };
  try {
    const agent = new Agent(model, defaultPrompt, tools, () => {}, conversation);
    const pending = agent.send('向右走');
    await requested;
    agent.dispose();
    await pending;
    assert.deepEqual(conversation.events.map(({ text }) => text), ['向右走']);
    conversation.pendingSystemInfo = respawnInfo;
    const restarted = new Agent(model, defaultPrompt, tools, () => {}, conversation);
    await restarted.send('看看画面');
    await restarted.send('等一秒');
    const last = requests.at(-1);
    assert.doesNotMatch(last.instructions, /红色按钮|玩家/);
    assert.deepEqual(last.input.filter(({ role }) => role === 'user').map(({ content }) => content),
      ['向右走', `${respawnInfo}\n看看画面`, '等一秒']);
    assert.deepEqual(conversation.events.filter(({ kind }) => kind === 'player').map(({ text }) => text),
      ['向右走', '看看画面', '等一秒']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('interrupting a streaming turn keeps partial reasoning and text and personalizes only built-in prompts', async (t) => {
  const requests = [];
  const conversation = { events: [], history: [] };
  let painted;
  const updated = new Promise((resolve) => { painted = resolve; });
  const username = '$&🙂';
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    if (requests.length > 1) return streamedFixture('OpenAIResponses', 3);
    return sse(new ReadableStream({
      start(controller) {
        controller.enqueue(eventBytes({ type: 'response.reasoning_summary_text.delta', delta: '先观察' }));
        controller.enqueue(eventBytes({ type: 'response.output_text.delta', delta: '我看到' }));
      },
    }));
  });
  const agent = new Agent({ api: 'OpenAIResponses', model: 'mock', baseURL: '' }, '你好 {{user}}', {
    whenActive: async () => {},
    readScreen: () => assert.fail('incomplete stream should not invoke a tool'),
    execute: async () => assert.fail('incomplete stream should not invoke a tool'),
    outcome: () => 'active',
  }, (event) => { if (event.kind === 'assistant') painted(); }, conversation, username);
  const pending = agent.send('保留 {{user}}');
  await updated;
  assert.equal(agent.busy, true);
  agent.interrupt();
  await pending;
  await agent.send('停在这里');
  await agent.send('然后呢');
  assert.equal(requests[1].instructions, `你好 ${username}`);
  assert.deepEqual(requests[1].input, [
    { role: 'user', content: '保留 {{user}}' },
    { role: 'assistant', content: '<thinking>先观察</thinking>\n我看到' },
    { role: 'user', content: `<system-info>${username} 刚刚中断了你的行动，以下是 ta 的新指示</system-info>\n停在这里` },
  ]);
  assert.equal(requests[2].input.at(-1).content, '然后呢');
});

test('interrupting an active tool cancels motion and replays a paired tool result', async (t) => {
  const requests = [];
  let startAction;
  const acting = new Promise((resolve) => { startAction = resolve; });
  let stopped = false;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return streamedFixture('OpenAIChatCompletions', requests.length === 1 ? 1 : 3);
  });
  const agent = new Agent({ api: 'OpenAIChatCompletions', model: 'mock', baseURL: '' }, '', {
    whenActive: async () => {},
    readScreen: () => assert.fail('unexpected screenshot'),
    execute: async (_steps, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }, { once: true });
      startAction();
    }),
    outcome: () => 'active',
  }, () => {}, undefined, '小明');
  const pending = agent.send('走');
  await acting;
  agent.interrupt();
  await pending;
  assert.equal(stopped, true);
  assert.equal(requests.length, 1);
  await agent.send('停');
  assert.equal(requests[1].messages[2].tool_calls[0].id, 'call_1');
  assert.deepEqual(requests[1].messages[3], { role: 'tool', tool_call_id: 'call_1', content: '动作已中断' });
});

test('reported input usage triggers streamed compression and keeps the new instruction verbatim', async (t) => {
  const requests = [];
  const conversation = { events: [], history: [] };
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    return streamedFixture('OpenAIResponses', 3, requests.length === 1 ? 6000 : 900);
  });
  const model = { api: 'OpenAIResponses', model: 'mock', baseURL: '', maxInputToken: 5000, reasoningEffort: 'custom-effort' };
  const agent = new Agent(model, defaultPrompt, {
    whenActive: async () => {},
    readScreen: () => assert.fail('unexpected screenshot'),
    execute: async () => assert.fail('unexpected action'),
    outcome: () => 'active',
  }, () => {}, conversation, '小明');
  await agent.send('前一轮的指示');
  await agent.send('这一轮的指示');
  assert.equal(requests.length, 3);
  assert.equal(requests[1].stream, true);
  assert.equal(requests[1].tools, undefined);
  assert.match(requests[1].instructions, /小明/);
  assert.match(requests[1].input[0].content, /前一轮的指示/);
  assert.equal(requests[2].reasoning.effort, 'custom-effort');
  assert.match(requests[2].input[0].content, /此前对话与行动摘要/);
  assert.equal(requests[2].input[1].content, '这一轮的指示');
  assert.deepEqual(conversation.events.filter(({ kind }) => kind === 'player').map(({ text }) => text),
    ['前一轮的指示', '这一轮的指示']);
});
