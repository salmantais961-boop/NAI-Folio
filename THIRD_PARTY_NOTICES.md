# 素材与第三方声明

[MIT 许可](LICENSE) 适用于 Folio 自有代码。下列资源使用各自的条款。

| 资源 | 用途与许可 |
| --- | --- |
| Instrument Serif、Italiana | 本地排版字体，使用 SIL Open Font License 1.1。[Instrument Serif](public/fonts/instrument-LICENSE.txt) · [Italiana](public/fonts/italiana-LICENSE.txt) |
| MiSans、MiSans L3 | 中文界面使用小米原版字体，版权归小米所有。安装版嵌入字体，设置中附有署名和许可；源码构建时从官方获取。[小米官方下载](https://hyperos.mi.com/font/download) · [MiSans 字体许可](public/fonts/misans/LICENSE.pdf) |
| Three.js、Meshoptimizer | 本地图形与模型解码，使用 MIT 许可。[Three.js](public/vendor/three-LICENSE.txt) · [Meshoptimizer](public/vendor/meshoptimizer-LICENSE.txt) |
| Draco | WebAssembly 解码器及包装代码，使用随附的 Apache 2.0 许可和附录声明。[Draco 声明](public/vendor/draco/LICENSE.txt) |
| React Bits · Dot Grid | 点阵背景作为工作台的一部分分发。该组件使用附 Commons Clause 条件的许可，单独分发及商业使用范围以原文为准。[组件许可](public/vendor/react-bits-LICENSE.txt) |
| Qwen、T5、CLIP 与 HTML 实体数据 | 本地提示词分词。数据的具体版本、生成方式和上游许可见分词目录。[来源及许可](public/tokenizers/README.md) |

## 图鉴数据

「搭配预测」使用 newtextdoc1111 发布的 Danbooru 共现次数与同批次的标签频次，按当前词库筛选并分片。该数据集按 MIT 许可发布。[数据来源](https://huggingface.co/datasets/newtextdoc1111/danbooru-tag-csv/tree/fdf2772213f13d46bff60fc5ebd876e1a811a053) · [共现数据说明与许可](public/catalog-data/cooccurrence/LICENSE.txt)

内置标签的英文名称、中文翻译、分类和使用次数来自 ffdkj 的 Danbooru 中英文对照表，以 MIT 许可分发。[上游快照](https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/tree/15f5f4b50428226649d371cbf7faff8ddaacdb24) · [随附许可](public/catalog-data/ffdkj-LICENSE.txt)

角色、画师图鉴、别名和关联资料来自 Aurora Bright Edition、AnimaDex（2026 年 5 月版）与 Danbooru Tag Lab。本地封面及在线缩略图来自 AnimaDex，画作权利归各自权利人。项目的 MIT 许可适用于 Folio 自有代码。[本期索引清单](public/catalog-data/manifest.json) · [图鉴说明](docs/catalog.md)

## 便携包运行时

Windows x64 便携包另附官方 Node.js v24.22.2，可执行文件与完整许可位于包内的 `runtime/`。[Node.js 官方发行目录](https://nodejs.org/dist/v24.22.2/)

Folio Desktop 使用 Tauri 2、Rust 和系统 WebView2。桌面安装目录的 `notices/` 包含项目许可、Rust 依赖及前端资源的许可信息，Node.js 许可位于 `backend/runtime/LICENSE`。[Tauri 源码与许可](https://github.com/tauri-apps/tauri)

## 示例插画

人物插画由项目维护者提供，用于本仓库的 README、画刊刊头和工作台示例。作品权利由相应权利人保留，另行使用或分发插画请取得授权。此说明同样适用于透明底人物素材和工作台截图中的插画。[本期画刊素材](docs/media/edition) · [工作台示例原图](public/art/portrait-study.png)
