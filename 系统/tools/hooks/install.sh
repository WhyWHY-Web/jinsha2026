#!/bin/sh
# 安装仓库防护配置：pre-push 钩子 + blame 忽略清单
# 用法：sh 系统/tools/hooks/install.sh
set -e

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
cd "$root"

gitdir=$(git rev-parse --git-dir)

cp "$here/pre-push" "$gitdir/hooks/pre-push"
chmod +x "$gitdir/hooks/pre-push" 2>/dev/null || true

git config blame.ignoreRevsFile .git-blame-ignore-revs

echo "已安装 pre-push 钩子：$gitdir/hooks/pre-push"
echo "已启用 blame 忽略清单：.git-blame-ignore-revs"
echo "阈值调整示例：MASS_DELETE_LIMIT=50 git push"
