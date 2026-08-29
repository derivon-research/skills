# Derivon Agent Skills

Agent skills for operating Derivon weighted directed B-hypergraphs and Derivon
Mindmap workspaces.

## Install

Install all skills globally for personal use:

```sh
npx skills add derivon-research/skills --all -g
```

List skills before installing:

```sh
npx skills add derivon-research/skills --list
```

For a reproducible project installation, install the shared core plus one
workflow, for example:

```sh
npx skills add derivon-research/skills \
  --skill derivon-cli derivon-mindmap derivon-exploration \
  --agent '*' -y
```

Simple workspace recipes require `derivon`, `jq`, and a POSIX shell. Windows
users can use WSL or Git Bash. The bundled validator, renderer, and textbook
exporter require Node.js but no workspace npm dependencies.

## Skills

| Skill | Use |
| --- | --- |
| `derivon-cli` | Mathematical model, installation, graph CRUD, queries, subgraphs, and apply. |
| `derivon-mindmap` | Full workspace operations, object documents, replacements, validation, rendering, and route textbook export. |
| `derivon-book-import` | Source-faithful chapter-by-chapter tutorial-book import. |
| `derivon-teaching` | Read-only graph-grounded understanding assessment. |
| `derivon-exploration` | Agent-led personal learning exploration that grows a graph. |
| `derivon-creation` | Expert-led graph creation through dependency-ordered grilling. |

The workflow skills require both `derivon-cli` and `derivon-mindmap`. They do not
implicitly activate one another.

## Existing private-test workspaces

Derivon Mindmap no longer manages Agent files. It deliberately leaves previously
generated `.agents`, `.claude`, `.github/skills`, and `.derivon/agent` content
untouched so it cannot remove user edits. Review those files and delete the old
bundle manually before installing this package at project scope.

## Development

```sh
npm install
npm test
```

`npm run build` creates the checked-in self-contained document renderer. Tests
exercise real `derivon` and `jq` commands, workspace fixtures, route export, and a
loopback preview server.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

# Derivon Agent Skills（中文）

本仓库提供六个可独立发现的 Derivon Skills。个人使用推荐一次全局安装：

```sh
npx skills add derivon-research/skills --all -g
```

团队项目可以按需安装 `derivon-cli`、`derivon-mindmap` 和一个工作流 Skill，
由 `skills-lock.json` 固定来源。普通工作区操作使用 `jq | derivon | jq`，不会用
另一层 CRUD wrapper 隐藏 CLI；完整校验、Markdown/KaTeX/交互 HTML 发布，以及
学习路线教材导出由自包含 Node 工具处理。

- `derivon-book-import`：按章节忠实导入教程类书籍，只把来源中真实存在的推导写成超边。
- `derivon-teaching`：只读拷打用户理解，不提前泄露答案，默认不持久化掌握状态。
- `derivon-exploration`：面向用户也不熟悉的领域，Agent 查证、解释、验证理解并持续完善个人图谱。
- `derivon-creation`：面向领域熟练用户，按设计树访谈、审查并确认批次后写图。

规范 Skill 正文使用英文；Agent 应使用用户的语言开展对话和生成项目文档。旧内测项目中
由 Mindmap 生成的 Agent 文件不会被新版应用自动删除，请先检查个人修改，再手动清理旧
`.agents`、`.claude`、`.github/skills` 和 `.derivon/agent` 内容。
