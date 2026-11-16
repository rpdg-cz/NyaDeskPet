# 两位 Live2D 模型与动作序列解读

两个 ZIP 已安全解压到项目 models/live2d 的独立目录，原压缩包保留。下面结论来自实际 model3.json、exp3.json 和 motion3.json；尚不把文件解析成功当作渲染和视觉调试已完成。

## companion-a

模型：`models/live2d/018_child_casual_spring_01/018_child_casual_spring_01.model3.json`

- 2 张 PNG 贴图，24 个表情，18 个动作。
- 动作全部为 6 秒、30 FPS、非循环；要持续待机，播放器必须在动作结束后重新启动待机，不能假设原 motion 自带循环。
- 表情包含眼睛、眉毛、嘴部等参数；叠加模式为 Add/Multiply 等。表情与身体 motion 可以同时使用，但不应每帧重置表情。
- 模型没有 HitAreas；点击需要播放器按模型显示范围或像素透明度判断，不能只依赖 SDK 命中区域。

| 中央姿态动作 | 初始 Angle X | 初始 Angle Y | 初始 Angle Z | 参数曲线数 |
|---|---:|---:|---:|---:|
| mtn_idle01_C | 2.0 | -5.0 | 2.0 | 61 |
| mtn_idle02_C | 2.0 | -3.0 | 2.0 | 61 |
| mtn_idle03_C | 2.0 | 2.0 | 2.0 | 61 |
| mtn_idle04_C | 3.0 | -8.0 | 6.0 | 61 |
| mtn_idle05_C | 0.6000000238418579 | 2.0 | -1.0 | 61 |
| mtn_idle06_C | 2.0 | 3.0 | -16.0 | 61 |

同编号的 L/R 动作主要改变头部 X 角度（L 为正，R 为负）并保留身体、呼吸与其他参数曲线；朝向的视觉含义仍需实际预览，不能仅凭命名断言其面向屏幕哪侧。

## companion-b

模型：`models/live2d/019_child_casual_spring_01/019_child_casual_spring_01.model3.json`

- 2 张 PNG 贴图，24 个表情，12 个动作。
- 动作全部为 6 秒、30 FPS、非循环；要持续待机，播放器必须在动作结束后重新启动待机，不能假设原 motion 自带循环。
- 表情包含眼睛、眉毛、嘴部等参数；叠加模式为 Add/Multiply 等。表情与身体 motion 可以同时使用，但不应每帧重置表情。
- 模型没有 HitAreas；点击需要播放器按模型显示范围或像素透明度判断，不能只依赖 SDK 命中区域。

| 中央姿态动作 | 初始 Angle X | 初始 Angle Y | 初始 Angle Z | 参数曲线数 |
|---|---:|---:|---:|---:|
| mtn_idle01_C | 0.0 | 0.0 | 0.0 | 62 |
| mtn_idle02_C | 0.0 | -12.0 | -9.0 | 62 |
| mtn_idle03_C | 0.0 | -1.0 | 14.0 | 62 |
| mtn_idle04_C | 0.0 | 0.0 | 0.0 | 62 |

同编号的 L/R 动作主要改变头部 X 角度（L 为正，R 为负）并保留身体、呼吸与其他参数曲线；朝向的视觉含义仍需实际预览，不能仅凭命名断言其面向屏幕哪侧。

## API 可选择的动作

| 语义动作 | 真实资源 |
|---|---|
| idle | exp_idle01 + mtn_idle01_C |
| happy / laugh | exp_smile01 / exp_bsmile01 |
| sad / cry | exp_sad01 / exp_cry01 |
| angry / surprised | exp_angry01 / exp_surprised01 |
| thinking / shy / serious | exp_thinking01 / exp_shy01 / exp_serious01 |
| calm | exp_idle02 |
| pose_c / pose_l / pose_r | mtn_idle01_C / L / R |

中文情绪标签是根据原资源名作出的语义归类，不是对视觉质量的保证。完整原始资源名也由 discoverActions 自动收集，API只能从当前角色已有的动作键中选择。

## 指定对话生成动作序列

测试对话：`personal/examples/model-dialogue.json`，6 句双角色雨后对话。调用接口：

```js
await runtime.generate('保留台词，按情绪编排自然表演，每句 1 至 4 个事件。', {
  mode: 'import',
  dialogue: fs.readFileSync('personal/examples/model-dialogue.json', 'utf8')
});
```

每句结果保留 characterId/text，新增 action/emotion/timeline，例如：

```json
{"characterId":"companion-a","text":"咦，窗外的雨是不是停了？","action":"thinking","emotion":"surprised","timeline":[{"atMs":0,"action":"thinking"},{"atMs":1200,"action":"surprised"}]}
```

运行时限制：每句 1 至 8 项，0 ms 起始、严格递增，最大 6000 ms；每项 action 必须是该角色可用动作。模型无资源时旧版单 action 场景仍兼容；有显式 timeline 的未知 action 会被拒绝，不会静默变成 idle。API 无权改写导入的台词、说话人或顺序。

## 已验证与待验证

- 已验证：ZIP路径安全检查；全部 MOC、贴图、物理、表情、动作引用存在；30 个 motion 的完整分段编码、端点时序及元数据合法。
- 已验证：真实模型动作别名均解析到存在的资源；时间轴越界、重复时间及未知动作被拒绝；导入原文和 timeline 经过缓存存取保持一致。
- 测试命令：`node --test personal/model-sequence.test.cjs`（4项通过；不启用语音）。
- 主代理已完成真实 DeepSeek 调用和双模型 MOC 渲染；初次结果为 6 句/18 个表情提示，随后增加身体动作要求再次生成，最新报告包含两位角色的真实 pose motion。native 执行记录见 .preview/desktop-verification.json。
