import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Agent } from '../src/agent/agent.ts';
import { protocols } from '../src/agent/settings.ts';
import { World } from '../src/game/world.ts';
import { readLevel } from '../src/level/definition.ts';

const firstLevel = readLevel(JSON.parse(readFileSync(new URL('../levels/definitions/0001-walk-to-button.json', import.meta.url))));
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
    const world = new World(firstLevel);
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
    }, (entry) => events.push(entry));
    globalThis.fetch = async (url, request) => {
      assert.equal(url, protocols[protocol].path);
      assert.equal(request.headers.Authorization, undefined);
      const body = JSON.parse(request.body);
      assert.equal(body.instructions ?? body.system ?? body.messages[0].content, prompt);
      assert.equal(body.stream, false);
      requests.push(body);
      return Response.json(fixture(protocol, requests.length - 1));
    };
    try {
      await agent.send('先读图，再走到按钮。');
      assert.equal(requests.length, 4);
      verifyImage(protocol, requests[1], 'call_0');
      verifyImage(protocol, requests[3], 'call_2');
      assert.deepEqual(statesSeen, ['active', 'won']);
      assert.deepEqual(events.map((event) => event.kind), ['player', 'tool', 'tool', 'tool', 'assistant']);
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
    receive(Response.json(fixture('OpenAIResponses', 1)));
    await pending;
    assert.equal(agent.busy, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
