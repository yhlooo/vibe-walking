import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Agent, emptyRequestStats } from '../src/agent/agent.ts';
import { defaultPrompt, respawnInfo } from '../src/agent/prompts.ts';
import { adapters } from '../src/agent/protocols.ts';
import { protocols } from '../src/agent/settings.ts';
import { World } from '../src/game/world.ts';
import { readLevel } from '../src/level/definition.ts';

const flatLevel = readLevel(JSON.parse(readFileSync(new URL('./fixtures/legacy-level.json', import.meta.url))));
const png = 'data:image/png;base64,cG5n';
const actions = { actions: [{ key: 'moveRight', value: 21 }] };
const splitReadScreen = [
  { type: 'function_call', id: 'fc_open', status: 'completed', name: 'ReadScreen', call_id: 'ReadScreen_0_c95fe814', arguments: '{' },
  { type: 'function_call', id: 'fc_close', status: 'completed', arguments: '}' },
];

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
  if (protocol === 'OllamaChat') {
    const message = index < 3 ? { tool_calls: [{ function: { name, arguments: args } }] } : { content: text };
    return { message };
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

function streamedFixture(protocol, index, inputTokens, partialJSON, { cached, output } = {}) {
  const fixtures = [index].flat().map((entry) => fixture(protocol, entry));
  const [result] = fixtures;
  if (protocol === 'OllamaChat') {
    const events = [
      { message: { thinking: '先看画面' }, done: false },
      ...fixtures.map(({ message }) => ({ message, done: false })),
      { message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: inputTokens,
        prompt_eval_cached_count: cached, eval_count: output, eval_duration: output === undefined ? undefined : output * 1e7 },
    ];
    const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join('\n'));
    return new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  }
  let events;
  if (protocol === 'OpenAIChatCompletions') {
    const { finish_reason, message } = result.choices[0];
    const calls = fixtures.flatMap(({ choices: [choice] }) => choice.message.tool_calls ?? []);
    const chunk = (delta, reason = null) => ({ choices: [{ delta, finish_reason: reason }] });
    if (calls.length) {
      const starts = calls.map(({ id, function: fn }, index) => ({ index, id, type: 'function',
        function: { name: fn.name, arguments: fn.arguments.slice(0, 1) },
      }));
      const ends = calls.map(({ function: fn }, index) => ({ index, function: { arguments: fn.arguments.slice(1) } }));
      events = [chunk({ tool_calls: starts.reverse() }), chunk({ tool_calls: ends })];
    } else {
      events = [chunk({ content: message.content.slice(0, 4) }), chunk({ content: message.content.slice(4) })];
    }
    const cache = cached === 0 ? { prompt_tokens_details: { cached_tokens: cached } } : { prompt_cache_hit_tokens: cached };
    events.push(chunk({}, finish_reason), { choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: output, ...cache } }, '[DONE]');
  } else if (protocol === 'OpenAIResponses') {
    const item = result.output.at(-1);
    events = item.type === 'message' ? [
      { type: 'response.output_text.delta', delta: item.content[0].text.slice(0, 4) },
      { type: 'response.output_text.delta', delta: item.content[0].text.slice(4) },
    ] : [];
    const items = [...result.output.slice(0, -1), ...fixtures.map(({ output }) => output.at(-1))];
    events.push({ type: 'response.completed', response: { ...result, output: items, usage: {
      input_tokens: inputTokens, input_tokens_details: { cached_tokens: cached }, output_tokens: output,
    } } });
  } else {
    const blocks = fixtures.flatMap(({ content }) => content);
    events = [
      { type: 'message_start', message: { usage: {
        input_tokens: cached === undefined ? inputTokens : inputTokens - cached - 10,
        cache_read_input_tokens: cached, cache_creation_input_tokens: cached === undefined ? undefined : 10,
        output_tokens: output === undefined ? undefined : 1,
      } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看画面' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } },
      { type: 'content_block_stop', index: 0 },
      ...blocks.flatMap((block, offset) => {
        const index = offset + 1;
        const delta = block.type === 'text' ? { type: 'text_delta', text: block.text } :
          { type: 'input_json_delta', partial_json: partialJSON?.[offset] ?? JSON.stringify(block.input) };
        return [
          { type: 'content_block_start', index, content_block: block.type === 'text' ? { ...block, text: '' } : { ...block, input: {} } },
          { type: 'content_block_delta', index, delta },
          { type: 'content_block_stop', index },
        ];
      }),
      { type: 'message_delta', delta: { stop_reason: result.stop_reason }, usage: { output_tokens: output } },
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
  } else if (protocol === 'OllamaChat') {
    const [thinking, result, screenshot] = request.messages.slice(-3);
    assert.equal(thinking.thinking, '先看画面');
    assert.deepEqual(thinking.tool_calls, [{ function: { name: 'ReadScreen', arguments: {} } }]);
    assert.deepEqual(result, { role: 'tool', tool_name: 'ReadScreen', content: 'Ok' });
    assert.equal(screenshot.role, 'user');
    assert.deepEqual(screenshot.images, ['cG5n']);
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
  test(`${protocol} executes a batch in order and returns all results before the next response`, async () => {
    const originalFetch = globalThis.fetch;
    const world = new World(flatLevel);
    const events = [];
    const statesSeen = [];
    const requests = [];
    const requestOutcomes = [];
    const conversation = { events: [], history: [] };
    const updates = [];
    const tracker = {
      stats: emptyRequestStats(),
      onChange() { updates.push([this.stats.turns, this.stats.outputTokens]); },
    };
    let disableReadScreen = false;
    const prompt = '只属于这张关卡的系统提示词';
    const model = { api: protocol, model: 'mock', baseURL: 'http://unused', hasAPIKey: true,
      reasoningEffort: protocol === 'OllamaChat' ? 'true' : '' };
    const agent = new Agent(model, prompt, {
      isReadScreenDisabled: () => disableReadScreen,
      readScreen(disabled) { statesSeen.push([world.outcome, disabled]); return png; },
      async whenActive() {},
      async execute(steps) {
        await Promise.resolve();
        for (const input of steps) {
          let remaining = world.step(input);
          while (remaining > 0 && world.outcome === 'active') {
            remaining = world.step({ ...input, jump: false, distance: remaining });
          }
        }
      },
      outcome: () => world.outcome,
    }, (entry) => { if (!events.includes(entry)) events.push(entry); }, conversation, '', tracker);
    globalThis.fetch = async (url, request) => {
      assert.equal(url, protocols[protocol].path);
      assert.equal(request.headers.Authorization, undefined);
      const body = JSON.parse(request.body);
      const requestPrompt = body.instructions ?? body.system ?? body.messages[0].content;
      assert.equal(requestPrompt, prompt);
      assert.equal(body.stream, true);
      assert.notEqual(body.parallel_tool_calls, false);
      assert.notEqual(body.tool_choice?.disable_parallel_tool_use, true);
      const screenTool = body.tools[0].function ?? body.tools[0];
      assert.equal(screenTool.name, 'ReadScreen');
      assert.equal(screenTool.description, disableReadScreen
        ? '不知道发生了什么 ReadScreen 似乎不可用了'
        : '获取包含你的你所在环境的照片');
      if (protocol === 'OllamaChat') {
        assert.equal(body.messages[0].role, 'system');
        assert.equal(body.think, true);
      }
      requests.push(body);
      requestOutcomes.push(world.outcome);
      if (requests.length === 2) disableReadScreen = true;
      const turn = requests.length;
      return streamedFixture(protocol, turn === 1 ? [0, 1] : turn, turn * 100, undefined, {
        cached: [undefined, 120, 0][turn - 1], output: turn * 10,
      });
    };
    try {
      await agent.send('先读图，再走到按钮。');
      assert.equal(requests.length, 3);
      const { stats } = tracker;
      assert.equal(stats.turns, 3);
      assert.equal(stats.inputTokens, 600);
      assert.equal(stats.outputTokens, 60);
      assert.equal(stats.cachedTokens / stats.inputTokensWithCacheData, 0.24);
      assert.equal(stats.lastCacheRatio, 0);
      if (protocol === 'OllamaChat') assert.equal(stats.lastOutputRate, 100);
      else assert.ok(stats.lastOutputRate > 0);
      assert.deepEqual(updates, [[1, 0], [1, 10], [2, 10], [2, 30], [3, 30], [3, 60]]);
      assert.deepEqual(requestOutcomes, ['active', 'won', 'won']);
      const batch = requests[1];
      if (protocol === 'OpenAIResponses') {
        assert.deepEqual(batch.input.slice(-4).map(({ type, call_id }) => [type, call_id]), [
          ['function_call', 'call_0'], ['function_call', 'call_1'],
          ['function_call_output', 'call_0'], ['function_call_output', 'call_1'],
        ]);
        assert.deepEqual(batch.input.at(-2).output, [{ type: 'input_image', image_url: png, detail: 'auto' }]);
        assert.equal(batch.input.at(-1).output, 'Ok');
      } else if (protocol === 'AnthropicMessages') {
        verifyImage(protocol, batch, 'call_0');
        assert.deepEqual(batch.messages.at(-2).content.slice(1).map(({ id }) => id), ['call_0', 'call_1']);
        assert.equal(batch.messages.at(-1).content.length, 2);
        assert.deepEqual(batch.messages.at(-1).content[1], { type: 'tool_result', tool_use_id: 'call_1', content: 'Ok' });
      } else {
        const [assistant, screen, action, screenshot] = batch.messages.slice(-4);
        assert.deepEqual(assistant.tool_calls.map(({ function: fn }) => fn.name), ['ReadScreen', 'ExecActionSequence']);
        assert.deepEqual([screen, action], protocol === 'OllamaChat' ? [
          { role: 'tool', tool_name: 'ReadScreen', content: 'Ok' },
          { role: 'tool', tool_name: 'ExecActionSequence', content: 'Ok' },
        ] : [
          { role: 'tool', tool_call_id: 'call_0', content: 'Ok' },
          { role: 'tool', tool_call_id: 'call_1', content: 'Ok' },
        ]);
        assert.equal(screenshot.role, 'user');
        if (protocol === 'OllamaChat') assert.deepEqual(screenshot.images, ['cG5n']);
        else assert.equal(screenshot.content[1].image_url.url, png);
      }
      verifyImage(protocol, requests[2], 'call_2');
      assert.deepEqual(statesSeen, [['active', false], ['won', true]]);
      const expected = ['player', 'tool', 'tool', 'tool', 'assistant'];
      if (protocol === 'AnthropicMessages' || protocol === 'OllamaChat') {
        assert.equal(events.filter((event) => event.kind === 'thinking').length, 3);
      }
      assert.deepEqual(events.filter((event) => event.kind !== 'thinking').map((event) => event.kind), expected);
      assert.deepEqual(events.filter((event) => event.kind === 'tool'), [
        { kind: 'tool', text: '看了一眼', image: png },
        { kind: 'tool', text: '执行动作', detail: '向右移动 21' },
        { kind: 'tool', text: '看了一眼', image: png },
      ]);
      assert.equal(world.outcome, 'won');
      assert.equal(agent.busy, false);
    } finally {
      agent.dispose();
      globalThis.fetch = originalFetch;
    }
  });
}

test('tool failures keep action descriptions and show raw arguments only for unsupported tools', async (t) => {
  const sequence = { actions: [{ key: 'moveLeft', value: 1.2 }, { key: 'jump' }, { key: 'sleep', value: 1 },
    { key: 'moveRight', hold: 0.25 }] };
  const attemptedActions = '向左移动 1.2\n跳起\n等待 1s\n按住向右 0.25s';
  const calls = [
    { name: 'ExecActionSequence', arguments: JSON.stringify(sequence) },
    { name: 'ExecActionSequence', arguments: JSON.stringify({ actions: [...sequence.actions, { key: 'invalid' }] }) },
    { name: 'ExecActionSequence', arguments: JSON.stringify(sequence) },
    { name: 'ReadScreen', arguments: '{' },
    { name: 'Fly', arguments: ' { "height": 2 } ' },
    { arguments: '{broken' },
  ];
  const conversation = { events: [], history: [] };
  const titles = [];
  const results = [];
  let callIndex = 0;
  let executions = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const lastItem = JSON.parse(request.body).input.at(-1);
    if (lastItem.type === 'function_call_output') results.push(lastItem.output);
    const call = calls[callIndex++];
    const output = call ? [{ type: 'function_call', call_id: `call_${callIndex}`, ...call }] : [];
    return sse(eventBytes({ type: 'response.completed', response: { status: 'completed', output } }));
  });
  const agent = new Agent({ api: 'OpenAIResponses', model: 'mock', baseURL: '' }, '', {
    whenActive: async () => {},
    readScreen: () => assert.fail('unexpected screenshot'),
    async execute() { executions++; throw new Error('当前无法执行动作'); },
    outcome: () => callIndex >= 3 ? 'won' : 'active',
  }, (event) => { if (event.kind === 'tool') titles.push(event.text); }, conversation);

  await agent.send('开始');

  assert.equal(executions, 1);
  assert.deepEqual(titles.slice(0, 2), ['执行动作', '执行动作失败']);
  assert.deepEqual(conversation.events.filter(({ kind }) => kind === 'tool').map(({ text, detail }) => [text, detail]), [
    ['执行动作失败', attemptedActions],
    ['执行动作失败', `${attemptedActions}\n无法识别的动作`],
    ['执行动作失败', attemptedActions],
    ['查看画面失败', '工具参数必须是有效的 JSON'],
    ['不支持的行动', ' { "height": 2 } '],
    ['不支持的行动', '{broken'],
  ]);
  assert.equal(results.length, calls.length);
  assert.ok(results.every((result) => result.startsWith('Error: ')));
});

test('a hidden victory notice reaches the model and stays in history after switching protocols', async (t) => {
  const notice = '<system-info>红色按钮被按下，恭喜通关🎉</system-info>';
  const prompt = '关卡提示词，玩家是 {{user}}。';
  const conversation = { events: [], history: [] };
  const requests = [];
  let outcome = 'active';
  const tools = { whenActive: async () => {}, readScreen: () => png, outcome: () => outcome };
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const protocol = url === protocols.OpenAIResponses.path ? 'OpenAIResponses' : 'OpenAIChatCompletions';
    requests.push(JSON.parse(request.body));
    return streamedFixture(protocol, requests.length === 1 ? 0 : 3);
  });
  const createAgent = (api) => new Agent({ api, model: 'mock', baseURL: '' }, prompt, tools, () => {}, conversation, '小明');

  const gameAgent = createAgent('OpenAIResponses');
  await gameAgent.send('先看一眼。');
  const priorHistory = structuredClone(conversation.history);
  outcome = 'won';
  await gameAgent.send(notice, prompt, { hidden: true });
  await createAgent('OpenAIChatCompletions').send('接下来呢？');

  assert.deepEqual(conversation.events.filter(({ kind }) => kind === 'player'), [
    { kind: 'player', text: '先看一眼。' },
    { kind: 'player', text: notice, hidden: true },
    { kind: 'player', text: '接下来呢？' },
  ]);
  assert.deepEqual(requests[2].input, [...priorHistory, { role: 'user', content: notice }]);
  assert.equal(requests[2].instructions, '关卡提示词，玩家是 小明。');
  assert.equal(requests[3].messages[0].content, requests[2].instructions);
  assert.deepEqual(requests[3].messages.filter(({ role }) => role === 'user').map(({ content }) => content),
    ['先看一眼。', notice, '接下来呢？']);
});

test('switching providers with the same protocol rebuilds history from conversation text', async (t) => {
  const api = 'OpenAIResponses';
  const conversation = { events: [], history: [] };
  const requests = [];
  const tools = { whenActive: async () => {}, readScreen: () => png, outcome: () => 'active' };
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return streamedFixture(api, 3);
  });
  const createAgent = (model) => new Agent({ api, model, baseURL: '' }, 'prompt', tools, () => {}, conversation);
  const first = createAgent('first/mock');
  await first.send('第一条消息');
  const reasoning = { type: 'reasoning', encrypted_content: 'provider-specific' };
  conversation.history.push(reasoning);
  await first.send('同一供应商');
  assert.ok(requests[1].input.some(({ encrypted_content }) => encrypted_content === reasoning.encrypted_content));

  await createAgent('second/mock').send('切到另一家');
  assert.equal(requests[2].model, 'second/mock');
  assert.ok(!requests[2].input.some(({ encrypted_content }) => encrypted_content));
  assert.deepEqual(requests[2].input.filter(({ role }) => role === 'user').map(({ content }) => content),
    ['第一条消息', '同一供应商', '切到另一家']);
});

test('invalid Anthropic tool JSON fails each affected call and allows the remaining call', async (t) => {
  const requests = [];
  const conversation = { events: [], history: [] };
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return streamedFixture('AnthropicMessages', requests.length === 1 ? [0, 1, 2] : 3, undefined, ['{broken', '[broken']);
  });
  const agent = new Agent({ api: 'AnthropicMessages', model: 'mock', baseURL: '' }, '', {
    whenActive: async () => {},
    readScreen: () => png,
    execute: async () => assert.fail('invalid action must not execute'),
    outcome: () => 'active',
  }, () => {}, conversation);

  await agent.send('查看画面');

  const detail = '工具参数必须是有效的 JSON';
  assert.deepEqual(conversation.events.filter(({ kind }) => kind === 'tool'), [
    { kind: 'tool', text: '查看画面失败', detail },
    { kind: 'tool', text: '执行动作失败', detail },
    { kind: 'tool', text: '看了一眼', image: png },
  ]);
  assert.deepEqual(requests[1].messages.at(-1).content, [
    { type: 'tool_result', tool_use_id: 'call_0', is_error: true, content: `Error: ${detail}` },
    { type: 'tool_result', tool_use_id: 'call_1', is_error: true, content: `Error: ${detail}` },
    { type: 'tool_result', tool_use_id: 'call_2', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
    ] },
  ]);
});

test('a split ReadScreen in Responses executes once and sends repaired history upstream', async (t) => {
  const requests = [];
  const placeholder = { type: 'message', role: 'assistant', content: [{ type: 'output_text', annotations: [] }] };
  const reasoning = { type: 'reasoning', id: 'rs_original', summary: [{ type: 'summary_text', text: '先看画面' }] };
  const [opening, closing] = splitReadScreen;
  const output = [reasoning, placeholder, opening, placeholder, closing, placeholder];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    if (requests.length > 1) return streamedFixture('OpenAIResponses', 3);
    const events = [
      { type: 'response.function_call_arguments.delta', output_index: 4, item_id: closing.id, delta: '}' },
      { type: 'response.function_call_arguments.done', output_index: 4, item_id: closing.id, arguments: '}' },
      { type: 'response.output_item.done', output_index: 4, item: closing },
      { type: 'response.completed', response: { model: 'kimi-k3.1-pro', status: 'completed', output } },
    ];
    return sse(new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(eventBytes(event));
        controller.close();
      },
    }));
  });
  const conversation = { events: [], history: [] };
  const agent = new Agent({ api: 'OpenAIResponses', model: 'kimi-k3.1-pro', baseURL: '' }, '', {
    whenActive: async () => {},
    readScreen: () => png,
    execute: async () => assert.fail('unexpected action'),
    outcome: () => 'active',
  }, () => {}, conversation);

  await agent.send('看一眼');

  assert.deepEqual(requests[1].input, [
    { role: 'user', content: '看一眼' },
    reasoning,
    { ...opening, arguments: '{}' },
    { type: 'function_call_output', call_id: opening.call_id, output: [{ type: 'input_image', image_url: png, detail: 'auto' }] },
  ]);
  assert.equal(requests.length, 2);
  assert.deepEqual(conversation.events.map(({ kind }) => kind), ['player', 'tool', 'assistant']);
});

test('Responses reassembles a split action sequence before executing the next identified call', async (t) => {
  const [opening, closing] = splitReadScreen;
  const action = { ...opening, name: 'ExecActionSequence', call_id: 'action_call' };
  const body = { ...closing, id: 'fc_body', arguments: '"actions": [{"key":"moveRight","value":1.5},' +
    '{"key":"jump"},{"key":"moveRight","value":2.5},{"key":"sleep","value":0.5}]' };
  const placeholder = { type: 'message', role: 'assistant', content: [{ type: 'output_text', annotations: [] }] };
  const screen = { ...opening, id: 'fc_screen', arguments: '{}' };
  const output = [placeholder, action, placeholder, body, placeholder, closing, placeholder, screen];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    if (requests.length > 1) return streamedFixture('OpenAIResponses', 3);
    return sse(eventBytes({ type: 'response.completed', response: { status: 'completed', output } }));
  });
  const execution = [];
  const conversation = { events: [], history: [] };
  const agent = new Agent({ api: 'OpenAIResponses', model: 'kimi-k3.1-pro', baseURL: '' }, '', {
    whenActive: async () => {},
    async execute(steps) {
      assert.deepEqual(steps.slice(0, 3), [
        { direction: 1, jump: false, distance: 1.5 },
        { direction: 1, jump: true, distance: 2.5 },
        { direction: 0, jump: false },
      ]);
      await Promise.resolve();
      execution.push('action');
    },
    readScreen() { execution.push('screen'); return png; },
    outcome: () => 'active',
  }, () => {}, conversation);

  await agent.send('向右跳');

  assert.deepEqual(execution, ['action', 'screen']);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].input.slice(1), [
    { ...action, arguments: `{${body.arguments}}` },
    screen,
    { type: 'function_call_output', call_id: action.call_id, output: 'Ok' },
    { type: 'function_call_output', call_id: screen.call_id, output: [{ type: 'input_image', image_url: png, detail: 'auto' }] },
  ]);
  assert.ok(!conversation.events.some(({ kind }) => kind === 'error'));
});

test('Responses keeps distinct calls and rejects ambiguous or invalid fragments', () => {
  const read = (output) => adapters.OpenAIResponses.read({ status: 'completed', output });
  const [opening, closing] = splitReadScreen;
  const named = { ...closing, name: 'ReadScreen', call_id: 'second_call', arguments: '{}' };
  const distinct = [{ ...opening, arguments: '{}' }, named];
  assert.deepEqual(read(distinct).calls.map(({ id }) => id), [opening.call_id, named.call_id]);
  assert.deepEqual(read(distinct).history, distinct);

  const text = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先等等' }] };
  assert.throws(() => read([opening, text, closing]), /缺少 call_id/);
  assert.throws(() => read([opening, named, closing]), /缺少 call_id/);
  assert.throws(() => read([opening, { ...closing, arguments: '"actions":' }]), /缺少 call_id/);
  assert.throws(() => read([opening, closing, { ...closing, id: 'fc_extra' }]), /缺少 call_id/);
});

test('a game turn executes tools past the former request limit until a response has no call', async (t) => {
  const toolCount = 10;
  const requests = [];
  const conversation = { events: [], history: [] };
  let screensRead = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    const index = requests.length;
    assert.ok(index <= toolCount + 1, 'the turn should end after the response without a call');
    const output = index <= toolCount
      ? [{ type: 'function_call', name: 'ReadScreen', call_id: `call_${index}`, arguments: '{}' }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '看完了。' }] }];
    if (index === 8) output.unshift({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '再看一眼。' }] });
    return sse(eventBytes({ type: 'response.completed', response: { status: 'completed', output } }));
  });
  const agent = new Agent({ api: 'OpenAIResponses', model: 'mock', baseURL: '' }, '', {
    whenActive: async () => {},
    readScreen() { screensRead++; return png; },
    execute: async () => assert.fail('unexpected action'),
    outcome: () => 'active',
  }, () => {}, conversation);

  await agent.send('观察画面。');

  assert.equal(screensRead, toolCount);
  assert.equal(requests.length, toolCount + 1);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.tool_choice, 'auto');
    if (index > 0) {
      assert.equal(request.input.at(-1).type, 'function_call_output');
      assert.equal(request.input.at(-1).call_id, `call_${index}`);
    }
  }
  assert.deepEqual(conversation.events.filter(({ kind }) => kind === 'assistant').map(({ text }) => text),
    ['再看一眼。', '看完了。']);
  assert.equal(agent.busy, false);
});

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

test('interrupting a batch retains completed results and cancels active and queued calls', async (t) => {
  const requests = [];
  let startAction;
  const acting = new Promise((resolve) => { startAction = resolve; });
  let stopped = false;
  let screenshots = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return streamedFixture('OpenAIChatCompletions', requests.length === 1 ? [0, 1, 2] : 3);
  });
  const agent = new Agent({ api: 'OpenAIChatCompletions', model: 'mock', baseURL: '' }, '', {
    whenActive: async () => {},
    readScreen: () => { screenshots++; return png; },
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
  assert.equal(screenshots, 1);
  assert.equal(requests.length, 1);
  await agent.send('停');
  assert.deepEqual(requests[1].messages[2].tool_calls.map(({ id }) => id), ['call_0', 'call_1', 'call_2']);
  assert.deepEqual(requests[1].messages.slice(3, 6), [
    { role: 'tool', tool_call_id: 'call_0', content: 'Ok' },
    { role: 'tool', tool_call_id: 'call_1', content: '动作已中断' },
    { role: 'tool', tool_call_id: 'call_2', content: '工具调用未执行' },
  ]);
  assert.equal(requests[1].messages[6].content[1].image_url.url, png);
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
