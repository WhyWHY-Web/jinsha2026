# AGENTS.md

金沙江流域森林生态环境智能评估项目。**当前唯一在维护的产品是 `新工作台/`**，其余目录只有数据和素材。

## 先看哪里

- 产品说明：`新工作台/README.md`
- 仓库总览：`README.md`
- 前端源码：`新工作台/src/`
- 后端源码：`新工作台/server/`（Node + TypeScript，`node --experimental-strip-types`）
- 数据导入、导出脚本：`新工作台/scripts/`、`新工作台/tools/`

## 常用命令（在 `新工作台/` 下执行）

```bash
npm run dev        # 开发服务器 http://127.0.0.1:5173/
npm start          # 本地后端服务（Node，读取 系统/data 与 新工作台/data）
npm run build      # 类型检查 + 打包 + 首屏校验
npm run export:web # 导出静态站点
```

## 不要读取的目录（体积大、与任务无关）

- `新工作台/node_modules/`、`新工作台/dist/`、`新工作台/tmp/`
- `系统/data/` 下的二进制与切片：`*.bin`、`detail/`、`tiles/`、`regional-dem/`、`terrain/`、`rsei/`、`lulc/`、`nightlight/`、`population/`
- `系统/data/**/*.json` 只在需要确认字段时按单个文件读取，不要整目录检索
- `_fenzu_img/`、`截图/`、`dist/*.zip`、`*.tar.gz`
- `.git/`、`node_modules/`、任意 `__pycache__/`

## 目录约定

- `系统/data/` 是**数据源**，`新工作台/server/index.ts` 通过 `JINSHA_WORKBENCH_SOURCE`（默认 `../系统/`）读取，不要随意移动或重命名。
- 静态资源映射集中在 `新工作台/server/index.ts` 的 `sourceAssets` 表。
- 旧版 Python 系统已清理，源码归档为 `归档-旧版系统源码-20261128.tar.gz`，**不要解压**，需要查历史实现时按单个文件 `tar -xOf` 提取。

## 注意

- 不要把 `*.bin`、`*.sqlite`、`tiles/`、`node_modules/` 提交进仓库。
- 修改评分指标或数据字段前，先读 `新工作台/README.md` 里对应的说明，不要凭猜测改。
