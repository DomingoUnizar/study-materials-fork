HGhub {{VERSION}} - Windows x64 便携版 (portable build)
==================================================

【运行方式】
  把压缩包完整解压到任意文件夹，双击 HGhub.exe 即可运行。
  无需安装，也不需要管理员权限；请不要直接在压缩包预览窗口里运行。

【运行依赖】
  - 64 位 Windows 10 / Windows 11（x64）。
  - Microsoft Edge WebView2 Runtime：Windows 11 已内置，一般无需处理。
    如果系统里没有（被手动卸载，或较旧的 Windows 10），请先安装 Evergreen 版：
    https://developer.microsoft.com/microsoft-edge/webview2/
  - 不需要安装 Visual C++ 运行库（VC 运行时已静态链接进 exe，构建时已核对导入表）。
  - 不需要 .NET，压缩包内也没有其他必须的组件。

【数据位置】
  便携版不会把数据写进 exe 所在目录，而是和安装版一样写入当前用户目录：
    %APPDATA%\com.hghub.huangguo        （会话、线路设置、日志）
    %LOCALAPPDATA%\com.hghub.huangguo   （WebView2 缓存与本地存储）
  删除这两个目录即可清除全部本地数据；安装版与便携版共用同一份数据。

【安全提示】
  本构建没有代码签名（未使用任何证书）。首次运行时 Windows SmartScreen 可能提示
  “Windows 已保护你的电脑”，核对下方 SHA-256 后可点击“更多信息” -> “仍要运行”。

【构建信息】
  版本      {{VERSION}} (x64, Release)
  源码提交  {{COMMIT}}
  构建记录  {{RUN_URL}}
  SHA-256   {{EXE_SHA256}}  HGhub.exe

【许可证】
  PolyForm Noncommercial License 1.0.0（全文与版权声明见 LICENSE.txt），禁止任何商业用途。
  本构建来自： {{REPO_URL}}
