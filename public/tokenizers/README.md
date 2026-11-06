# 提示词分词资源

Folio 自带三套离线词表。浏览器按模型读取对应文件，在本地 Web Worker 中计算正向和负面提示词的 Token 用量。日常启动和测试仅需要 Node.js。

| 文件 | 上游来源及许可 | Folio 的处理 |
| --- | --- | --- |
| `qwen35.def` | [Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B/tree/2fc06364715b967f1860aea9cf38778875588b17)，© 2026 Alibaba Cloud，[Apache 2.0](./Qwen3.5-LICENSE.txt) | 提取 248,070 个词项 ID、247,587 对合并规则及 26 个添加词项。将上游正则的大小写和 Unicode 空白匹配转成浏览器语法。 |
| `t5.def` | [Google T5 Small](https://huggingface.co/google-t5/t5-small/tree/df1b051c49625cf57a3d0d8d3863ed4d13564fe4)，[Apache 2.0](./T5-LICENSE.txt) | 提取 Unigram 模型的 32,100 个词项、得分和未知词 ID。 |
| `clip.def` | [OpenAI CLIP](https://github.com/openai/CLIP/tree/d05afc436d78f1c48dc0dbf8e5980a9d471f35f6)，[MIT](./CLIP-LICENSE.txt)；[CPython HTML5 实体表](https://github.com/python/cpython/blob/0cc81280367df838c4b199f8f0378837165071c2/Lib/html/entities.py)，[Python 许可](./Python-LICENSE.txt) | 提取 CLIP 编码器使用的前 48,894 对合并规则，以及处理 HTML 转义所需的 2,231 个实体。 |

发布时逐项核对了上述词表与原工作台的分词数据。Qwen 的词项 ID、特殊词和合并顺序相同，CLIP 的合并规则及实体映射相同。T5 的词项、ID 与 32 位分值全部相同。两个来源的 JSON 将部分 T5 分值写成略有差异的双精度小数，最大差为 1.78 × 10⁻¹⁵。逐一测试全部 T5 词项及 32,100 组词项拼接，所得 Token ID 均一致。

计数规则保留了工作台针对 NovelAI 网页版本 `b94bdee` 验证的行为，包括 T5 结束标记、权重处理和各模型的提示词上限。发布文件由上表列出的项目重建。将来服务端规则变化时，需要重新比对测试用例。

## 从上游重建

在项目根目录运行以下命令。构建工具使用 Python 3.9 或更新版本的标准库。它按 [sources.json](./sources.json) 的固定版本下载并校验源文件和许可文本，提取本地分词器所需的字段，以 UTF-8 JSON 和 raw DEFLATE 格式写入本目录。

```sh
python scripts/build-tokenizers.py
python scripts/build-tokenizers.py --check
node --test test/prompt-tokens.test.mjs
```

`--check` 会将重建内容与仓库中的分词资源、许可文本逐个比较。也可以预先下载清单中的八个源文件，按对应键名保存于同一目录，再用 `--source-dir <目录>` 离线重建或校验。`payloadSha256` 为解压后字节的 SHA-256，便于在不同 zlib 版本间复核。
