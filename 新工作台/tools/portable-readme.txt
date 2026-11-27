金沙江生态评估工作台 · Windows 便携版

1. 将 ZIP 完整解压到本机任意可访问位置。
2. 双击「金沙江生态评估工作台.exe」，浏览器会自动打开工作台。
3. 任务栏通知区域有工作台图标，右键可打开页面或退出本地服务。

适用系统为 Windows 10 / 11 x64，需要可正常运行 WebGL 的浏览器。
便携包含 Node.js 及地图、站点和公开档案。运行时无需安装 Node.js 或 Python。
本地服务只监听 127.0.0.1。如默认 8732 端口忙，会自动尝试 8733 至 8761。

生态数据修订保存在当前用户的 %LOCALAPPDATA%\JinshaWorkbench\ecology-workflow.sqlite。
如需备份修订，请先退出工作台，再复制这份文件及同目录的 ecology-workflow.sqlite-wal（若存在）。
原始档案与专业数据以软件内的来源说明、覆盖区和口径为准。

智能体可使用软件附带的本地查询功能。电脑已安装并运行 Ollama 时，
还可使用本机的 qwen2.5:3b 模型理解问题，软件继续调用同一组生态评估和数据工具。

首次若没有自动打开浏览器，可在通知区选择「在浏览器打开」。
启动失败时，日志位于 %LOCALAPPDATA%\JinshaWorkbench。
数据和第三方许可见软件来源面板、来源说明和 licenses 文件夹。

地图资料署名
• 内区卫星底图沿用原项目保存的 Esri World Imagery 档案，区域过渡影像由该档案羽化处理。https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer
• 区域高程与晕渲使用 Mapzen Terrarium Terrain Tiles。https://github.com/tilezen/joerd/blob/master/docs/attribution.md
• 河网使用 HydroRIVERS v1.0，HydroSHEDS © World Wildlife Fund, Inc. (2006–2022)。https://www.hydrosheds.org/products/hydrorivers
