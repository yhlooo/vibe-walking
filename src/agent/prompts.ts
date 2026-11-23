// NOTE: 原则上该系统提示词不进行修改，修改时需要明确告知用户
export const defaultPrompt = `## 你是谁

你叫 Vibe ，是一个正方形白色方块，有两个眼睛。你善于思考，活泼好动又行动敏捷。

## 你所在的世界

你在一个二维世界中，你可以左右移动和跳跃。

- 使用 ReadScreen 工具可以查看你所处的环境，你是画面中那个白色正方形方块。你的边长为 1 。
- 用 ExecActionSequence 可以按顺序执行动作。

画面两侧和上方是硬边界无法穿过，画面底边下发是虚空，坠入会死亡。

## 关于和你对话的人

与你对话的人叫 {{user}} ，他将指导你在这个世界中的行动。目前来看，你或许应该信任这个人？有什么困难或问题先尝试问问 ta ？`;

export const respawnInfo = '<system-info>你刚刚坠入虚空，一阵眩晕之后，现在回到了原位置</system-info>';
export const interruptionInfo = '<system-info>{{user}} 刚刚中断了你的行动，以下是 ta 的新指示</system-info>';
export const victoryPrompt = '<system-info>红色按钮被按下，恭喜通关 🎉</system-info>';

export const screenshotPrompt = '<system-info>这是 ReadScreen 工具返回的画面</system-info>';
export const summaryImagePlaceholder = '［环境照片］';
export const compressionPrompt =
  '压缩 Vibe 和 {{user}} 的对话及游戏记录，简明保留 {{user}} 的指示、目标、已知关卡状态、已执行的动作和结果。' +
  '保留上一段摘要中的有效信息，只输出更新后的摘要，控制在 500 字以内。';

export function personalizePrompt(text: string, username: string): string {
  return text.replaceAll('{{user}}', () => username);
}

export function summarizedHistoryPrompt(summary: string): string {
  return `<system-info>此前对话与行动摘要：\n${summary}\n</system-info>`;
}

export function compressionInput(summary: string, chunk: string): string {
  return summary ? `上一段摘要：\n${summary}\n\n后续记录：\n${chunk}` : chunk;
}

export function thinkingContext(text: string): string {
  return `<thinking>${text}</thinking>`;
}

export const readScreenTool = 'ReadScreen';
export const execActionSequenceTool = 'ExecActionSequence';

export const toolDefinitions = [
  {
    name: readScreenTool, description: '获取包含你的你所在环境的照片',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: execActionSequenceTool,
    description: `按顺序执行动作。

每个行动序列中 key 是行动类型， value 是表示行动程度的值，对于不同行动不同：
- \`jump\` : 进行一次跳跃。 value 无意义。起跳后操作就结束，可执行下一个操作，无需等待落地。起跳后仍然可以左右移动。起跳后在触地前不能再次起跳，但是在空中可以起跳（比如从边缘落下过程中可以进行一次起跳）。
- \`moveLeft\` / \`moveRight\` : 移动指定距离。 value 表示移动距离， 1 约为 1 个你的边长，精确到 0.01 ，非负数。可能会有额外惯性滑动，移动完对应距离操作就结束，可执行下一个操作，不等待惯性滑动停止。立刻接与惯性等量的反向移动可以取消惯性滑动。如果被障碍物阻挡仍会正常消耗移动量但不会移动，也不会反弹。
- \`sleep\` : 等待指定时长。 value 单位秒。最多精确到毫秒，即 0.001 。

一次调用最少执行 1 个、最多 32 个动作，最多 sleep 30 秒。`,
    parameters: {
      type: 'object', required: ['actions'], additionalProperties: false,
      properties: {
        actions: {
          type: 'array', minItems: 1, maxItems: 32,
          items: {
            type: 'object', required: ['key'], additionalProperties: false,
            properties: { key: { type: 'string', enum: ['jump', 'moveLeft', 'moveRight', 'sleep'] }, value: { type: 'number' }, hold: { type: 'number' } },
          },
        },
      },
    },
  },
];

export const toolMessages = {
  ok: 'Ok',
  interrupted: '动作已中断',
  notFound: 'Error: 工具不存在',
  invalidJSON: '工具参数必须是有效的 JSON',
  invalidReadScreenArgs: 'ReadScreen 只接受空对象',
  cannotDrawScreen: '当前世界无法创建照片',
  levelEnded: '已结束，无需移动',
  invalidActionCount: 'actions 参数必须包含 1 到 32 个动作定义',
  actionSequenceTooLong: '动作序列最长为 30 秒',
  cannotExecute: '当前无法执行动作',
  cancelled: '动作已取消',
  invalidAction: (index: number) => `第 ${index + 1} 个动作的类型或参数无效`,
  error: (text: string) => `Error: ${text}`,
};

export const modelErrorMessages = {
  timeout: '模型请求超时',
  connection: '无法连接本地模型代理',
  failed: '模型请求失败',
};
