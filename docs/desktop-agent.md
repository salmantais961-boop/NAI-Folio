# 在桌面版里用 Agent 画图

打开带有 Agent 的 Folio.exe，顶栏里的 **Agent** 就在工作台和作品集之间。左边写要求，右边沿用原来的画布和历史。比如可以发一句「画两个人在雨后的书店门口等车，让左边的人拿红伞」。如果只是想推敲构图，也可以说「先给我提示词，暂时别生成」。

## 第一次需要连两个服务

1. 在桌面右上角设置好 **NovelAI 生图账户**。沿用工作台已经连好的官方账户或中转站就行。真正生成时，这个账户负责出图和结算。
2. 回到 **Agent**，打开输入区的模型选择，进入 **管理模型连接**。这里连的是负责理解要求、查角色和写提示词的语言模型。选服务商，填它的地址与 API Key，点 **拉取模型**，再选模型。
3. 点 **检测连接**，让所选模型实际回复一次短请求。部分网关只开放聊天接口，不提供模型列表；这时可直接填服务商给的模型 ID，再检测、保存。语言模型请求按所用服务的规则计费。

模型设置支持 OpenAI Responses、OpenAI 兼容的 Chat Completions、Anthropic Messages、Google Gemini 和 Ollama 协议。用本机模型时，先在 Ollama 或 LM Studio 里启动服务。使用自建网关时，选择对应协议，保留网关的路径前缀；Folio 会补齐常见 API 路径。缺少原生函数调用的模型可在 **连接名称与协议** 里启用文本工具协议，实际效果取决于模型能否稳定返回约定的 JSON。

## 正面和负面提示词可以分开锁定

在对话输入区点 **锁定词块**。正向栏可以放惯用的画风和质量词，Agent 接着写场景、动作、光线和各个角色的样貌。负面栏可以选词块，也可以点 **锁定工作台当前负面**，把工作台负面输入框里的整段内容连同引用的词块一起存为快照。展开 **查看锁定的负面提示词** 就能核对这次会发出的文字。

锁定负面词块后，最终发送给 NovelAI 的负面提示词只用你选定的内容，按选择时的顺序拼接。模型补写的全图负面词、单独角色的负面词和额外的 UC 预设都会跳过。负面栏留空时，支持自定义负面提示词的模型会用 Agent 配的词。V5 Full 的 Medium 档使用固定负面预设，要按锁定内容出图，请先把运算强度切到 **High**。

如果你在负面提示词里自己写了竖线，例如 `lowres | red hat | blue hat`，Folio 会沿用这三段，把后两段分别放进对应角色的负面栏。锁定时保存的快照会保留权重、重复标签和顺序，之后修改词块库也不会改动已经选好的快照。原图和生成参数照常进作品集，左侧历史可以找回这次对话。

## 在对话里选生图参数

Agent 每轮都会看到当前 NAI 模型的正、负向 token 上限、锁定词块的占用量和还可以写多少。角色和主提示词共用各自方向的额度，预设自动添加的标签也会预先计入。交付配方或生图前，Folio 会用本地词表重新计算完整提示词。超限时先让 Agent 精简可编辑的部分，锁定的负面词保持原文。

点输入区的生图设置，可以换 NovelAI 模型、数据集和画幅，也可以调整采样、步数与种子。默认跟随工作台。应用一套 Agent 专用参数后，下一次生图会使用这套设置，手选的尺寸也会保留。

每条回复末尾都能复制或重新生成。在较早的一条上重新生成，会从那里分出一段对话。末尾的 tokens 汇总这条回复各轮模型调用的输入和输出，TPS 表示每秒输出的 token 数。带「≈」的速度按模型请求耗时估算，工具检索和生图等待时间单独计算。没有完整用量记录时显示「—」。

## 请 Agent 上网查资料

查公开角色时，Agent 会先确认英文名和别名，再核对 Danbooru 的正式角色标签、作品后缀或别名指向。需要特定服装或缺少可靠角色标签时，再查官方立绘和外观资料。私人 OC 继续从本地查找。

在 **Agent 设置 → 技能与工具 → DeepSeek 联网检索** 可以开关搜索或指定连接。如果已经在「模型连接」里保存了官方 DeepSeek 连接和密钥，Agent 会自动复用，即使聊天时选了另一个模型也可以搜索。比如可以说「查一下这个角色在官网公布的服装设定，给我出处，再整理成提示词」。工具记录里可以展开搜索词、来源网址和抓取的正文。网页搜索和抓取按 DeepSeek 的调用规则计费。[DeepSeek 搜索与抓取说明](https://api-docs.deepseek.com/zh-cn/guides/search/)

## 看它用了哪些工具

在输入框旁点 **思考强度**，可以为当前对话选档。**自动** 会沿用模型默认值。如果服务只提供思考开关，菜单里就显示开关；不同模型能选的档位会跟着变化。这个选择控制语言模型，NovelAI 的生图步数和 V5 运算强度仍在工作台设置。

一条要求可能先查角色、再读技能，最后才提交画布。展开回复里的 **工具调用**，就能按轮次查看每一步。点开具体工具可以复制调用字符串和返回内容，回到历史对话也能查看。耗时和状态来自实际执行记录。凭据会遮盖，大段二进制数据会省略，过长的文本会标注截断。

## 让 Agent 使用额外技能或工具

内置角色检索和出图可以直接使用。需要扩展时，打开 Agent 设置里的 **技能与工具**，添加配置，点 **读取技能与工具** 看实际发现了哪些项目，再 **保存配置**。新配置从下一条消息开始生效。

**Skills** 是给模型看的工作说明。例如从 NovelAI-Image-MCP 仓库取得 `skills/novelai-mcp-tools/` 后，把该目录或里面 `SKILL.md` 的完整本机路径填进 **Skills · 文件或目录**。Folio 先展示技能名和简介，用到时才读取正文，以及同目录下引用的文档。Pi 包清单中的 `pi.skills` 也可以用。[NovelAI 示例技能](https://github.com/xinvxueyuan/NovelAI-Image-MCP/tree/main/skills) · [Pi Skills 文档](https://pi.dev/docs/latest/skills)

**MCP** 可以让 Agent 调用外部程序。下面的配置适用于已经在本机装好的 `novelai-image-mcp`，仅开放它的标签联想工具。先在本机设置 `NAI_MCP_TOKEN` 环境变量，重新打开 Folio，再把示例填入 **MCP 服务 · JSON**。密钥由桌面进程从环境中读取。这个外部服务使用自己配置的账号。[NovelAI-Image-MCP 安装与工具说明](https://github.com/xinvxueyuan/NovelAI-Image-MCP)

```json
{
  "mcpServers": {
    "nai-reference": {
      "command": "novelai-image-mcp",
      "args": ["serve"],
      "env": { "NOVELAI_TOKEN": "${NAI_MCP_TOKEN}" },
      "exposure": "hidden",
      "toolExposure": { "suggest_tags": "direct" }
    }
  }
}
```

如果服务已经在运行，可把上面服务的 `command`、`args` 和 `env` 换为 `"url": "http://127.0.0.1:8000/mcp"`，按实际部署填写地址。需要鉴权时可用 `headers`，例如 `{ "Authorization": "Bearer ${MY_MCP_TOKEN}" }`。支持 stdio 和 Streamable HTTP，默认公开启用服务的工具。可用 `enabled: false` 暂停某个服务。[MCP 协议](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

**Pi 工具扩展** 适合自己写一个动作。以下代码存为 `palette.mjs`，把文件的完整路径填进 **Pi 工具扩展**。重新读取后，工具列表里会出现带扩展名称的 `palette`。

```js
export default function (pi) {
  pi.registerTool({
    name: 'palette',
    label: '雨天色盘',
    description: '返回一组适合雨天街景的颜色。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: 'slate blue, muted teal, warm amber' }] };
    },
  });
}
```

也可以选一个已安装的 Pi 包目录来读取 `pi.extensions`。本地工具在独立 Node 子进程里运行，支持 `registerTool` 和 `session_start`、`session_shutdown` 生命周期；使用第三方依赖的扩展需先在本机安装其依赖。Folio 的插件入口采用 Pi 工具约定，完整 Pi 终端 UI、Codemode 与 Cordis 插件需要各自的宿主。只添加你信任的本地扩展和 stdio 服务，读取工具列表时就会启动它们。[Pi 工具扩展](https://pi.dev/docs/latest/extensions) · [Pi 包格式](https://pi.dev/docs/latest/packages) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

对话及连接设置保存在当前 Windows 用户的桌面工作区。发送对话时，文字、必要的历史和已调用工具的结果会交给选中的语言模型；生图时最终提示词交给选中的 NovelAI 服务。
