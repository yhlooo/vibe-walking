# 自然语言指挥角色完成任务的游戏

调查日期为 2026 年 11 月 23 日。依据商店页、开发者项目页和研究论文判断玩法及公开状态。资料和摘录见 [自然语言指挥游戏角色的资料摘录](../reference/language-guided-games.md)。本次调查未实玩。

## 对照范围

Vibe Walking 让玩家在对话里给 Vibe 指引。默认关卡允许 Agent 用 `ReadScreen` 读取关卡截图，用 `ExecActionSequence` 执行移动、跳跃和等待。关卡引擎根据物理状态和按钮接触判断通关。创作者可以设置地形、物理参数和关卡提示词。见 [一期实施方案](../design/20261122-phase-one.md)。

## 商业游戏

- **Bot Colony _redux** 于 2026 年 10 月 30 日在 Windows 的 Steam 上开启抢先体验。玩家通过语音或打字指挥机器人，也能询问线索推进调查。第一章直接把用语言控制机器人设为考核。Steam 披露开发商将 OpenAI 的生成式 AI 接入自研对话系统，公开材料未说明走路、拿物等具体动作由哪一层决定。[Steam 商店页](https://store.steampowered.com/app/3613080/Bot_Colony__redux/)
- **Prompt Crisis** 的 Steam 状态为即将推出。玩家通过对话说服同伴跟随自己、共同操作机关，角色的信任和记忆影响合作。商店披露通过阿里云接入 Qwen 实时生成同伴对话及结局标题，未说明机关动作如何接入模型。[Steam 商店页](https://store.steampowered.com/app/5203720)
- **PUBG Ally** 是能理解语音、与玩家一起完成局内行动的 AI 队友。语言模型负责策略推理和沟通，行为树负责即时行动。Steam 在 2026 年 6 月进行过限时公测，这次调查未确认该模式目前是否仍可游玩。[公测公告](https://www.nvidia.com/en-us/geforce/news/pubg-ally-ai-teammate-beta-available-now/) · [技术访谈](https://developer.nvidia.com/blog/how-krafton-built-pubg-ally-a-co-playable-character-powered-by-nvidia-ace)

## 原型与研究

- **GameSpeak** 是最接近玩法循环的原型。玩家口述想达成的目标，AI 根据场景决定动作，操作角色通过 Godot 解谜环境。开发者尝试过 Gemini 视觉方案，最终由选择模型 Jev 根据引擎提供的结构化状态从可用动作中选出下一步。项目以游戏无障碍为目标。[Devpost 项目页](https://devpost.com/software/voice-of-the-devil)
- **IF:CARGO** 是有玩家测试的网格解谜实验。玩家用自然语言写机器人的 IF/THEN 行为规则，LLM 负责转成受约束的指令，游戏引擎验证并执行。玩家主要通过观察执行结果来修改规则。[论文摘要](https://arxiv.org/abs/2608.12195)
- **CaveBridge** 为《巨洞冒险》提供自然语言输入，支持多步指令和按目标自动推进。LLM 将玩家输入映射为文字冒险命令，原版引擎维护世界状态。[作者项目页](https://shangao.li/zh/projects/cavebridge/)
- **SIMA 2** 是 Google DeepMind 发布的限量研究预览。Gemini 是 Agent 的核心，参与目标理解、推理和游戏行动。Agent 能在多款 3D 游戏里观察画面并采取动作，和 Vibe Walking 的观察与行动循环相近。项目重心是跨游戏的 Agent 能力。[DeepMind 发布文章](https://deepmind.google/blog/sima-2-an-agent-that-plays-reasons-and-learns-with-you-in-virtual-3d-worlds/)

## 结论

Bot Colony _redux 是本次检索中最接近的已发售游戏。GameSpeak 的玩家意图、角色控制和解谜目标与本项目更接近，SIMA 2 则与本项目的视觉观察和任务执行方式更接近。检索范围内尚未找到同样以自然语言指导视觉 Agent 完成 2D 物理平台关卡为核心的已发售作品。
