# SANDBOX Physics

[English](README.md) | [简体中文](README.zh-CN.md)

SANDBOX 是由光锥边界（南京）科技有限公司开发的 OpenCode 原生物理研究扩展。它在 OpenCode 常规能力的基础上，增加 PhysicsOcean 本地检索、arXiv 搜索与论文保存、引用网络追踪，以及物理研究专用主智能体。

## 原生工具

| 工具 | 用途 |
|---|---|
| `physics_catalog` | 按主题、标题、作者、难度或类型筛选 PhysicsOcean 物理知识库目录。 |
| `physics_search` | 搜索本地 FTS5 知识库索引，或查看指定资料的目录。 |
| `physics_read` | 按安全的行号范围读取 PhysicsOcean LaTeX 原文。 |
| `arxiv_search` | 优先搜索本地 arXiv 元数据镜像，并可回退到 arXiv 在线 API。 |
| `arxiv_fetch` | 将论文保存到本地；优先读取 LaTeX，失败时使用原生 PDF 文本提取。 |
| `paper_references` | 通过 Semantic Scholar 追踪论文的参考文献。 |
| `paper_citations` | 查找引用了指定论文的后续文献。 |

## 系统要求

- macOS、Linux 或 Windows
- OpenCode `1.18.22` 或更高版本，并可通过 `opencode` 命令运行
- 以下任一 Node.js 版本：
  - Node 22：`22.22.2` 或更高
  - Node 24：`24.15.0` 或更高
  - Node 26 或更高
- npm
- 软件包运行时不依赖 Python，但建议为 OpenCode 中的科学计算工作流配置完善的 Python 环境

## 快速开始

安装 OpenCode：

```bash
npm install -g opencode-ai
```

然后安装 SANDBOX：

```bash
npm install -g @lightcone-boundary/sandbox
```

创建本地数据目录并检查环境：

```bash
sandbox setup
sandbox doctor
```

启动 OpenCode Web 界面：

```bash
sandbox
```

## 安装 PhysicsOcean

完整 PhysicsOcean 数据约 3.6 GB，因此与 npm 软件包分开发放。请获取物理知识库包、arXiv 包及各自对应的校验文件：

```text
physicsocean-textbooks-<date>.tar.gz
physicsocean-textbooks-<date>.tar.gz.sha256
physicsocean-arxiv-<date>.tar.gz
physicsocean-arxiv-<date>.tar.gz.sha256
```

将每个 `.sha256` 文件与对应压缩包放在同一目录，然后导入本地文件：

```bash
sandbox data install \
  ./physicsocean-textbooks-<date>.tar.gz \
  ./physicsocean-arxiv-<date>.tar.gz
```

PowerShell：

```powershell
sandbox data install .\physicsocean-textbooks-<date>.tar.gz .\physicsocean-arxiv-<date>.tar.gz
```

导入程序会：

- 流式计算并验证 SHA-256；
- 拒绝链接、嵌套或路径穿越、不可移植名称、未知文件、重复文件与超限输入；
- 只接受已知目录、数据库与平铺的 `.tex` 原文；
- 验证解包后大小与 SQLite 文件头；
- 通过私有暂存目录和带回滚的替换流程安装；
- 保留 `PhysicsOcean/arxiv/` 中用户已经保存的论文。

检查安装状态：

```bash
sandbox data status
sandbox doctor
```

## CLI 命令

```text
sandbox                         启动 OpenCode Web 界面
sandbox [web 选项]              使用 --port 等选项启动 Web 模式
sandbox tui [选项]              启动 OpenCode 终端界面
sandbox <opencode 命令> ...     转发其他 OpenCode 命令
sandbox setup [--home 路径]     创建 SANDBOX 数据目录
sandbox data install 数据包 ... 安装本地 PhysicsOcean 数据包
sandbox data status             查看 PhysicsOcean 安装状态
sandbox doctor                  检查 Node、OpenCode、插件、主目录与数据
```

完整命令说明请运行 `sandbox --help`。

## 数据位置

默认 SANDBOX 主目录在 macOS/Linux 上为 `~/sandbox`，在 Windows 上为用户主目录下的 `sandbox` 文件夹。

```text
PhysicsOcean/search.db          原生 FTS5 物理知识库索引
PhysicsOcean/books.md           可搜索的知识库目录
PhysicsOcean/arxiv_meta.db      本地 arXiv 元数据镜像
PhysicsOcean/arxiv/             arxiv_fetch 保存的论文
shared/sandbox-runtime.db       请求节流与 24 小时响应缓存
shared/research/                按任务保存的长期研究文件
artifacts/                      其他生成结果
```

## 卸载

仅卸载 npm 软件包，不删除本地数据：

```bash
npm uninstall -g @lightcone-boundary/sandbox
```

确定不再需要时，再单独删除数据：

```bash
rm -rf ~/sandbox
```

```powershell
Remove-Item -Recurse -Force "$HOME\sandbox"
```

## 维护者工具

Python 用于离线制作数据。`scripts/` 中以下脚本只使用 Python 标准库：

- `arxiv_oai_sync.py`
- `build_search_index.py`
- `build_books_catalog.py`
- `build_arxiv_index.py`
- `make_physicsocean_pack.py`

数据维护流程见 [KNOWLEDGE_BASE_WORKFLOW.md](KNOWLEDGE_BASE_WORKFLOW.md)。

## 微信

扫描二维码，通过微信联系我们。

<img src="wechat_qr.png" alt="微信二维码" width="240">
