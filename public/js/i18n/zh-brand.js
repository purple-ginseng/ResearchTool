/* Chinese (Simplified) dictionary fragment: the strings of the shared chrome of the UI refresh (header, Help and More
   menus, banners, empty-state helper, export confirm). Same shape as zh.js; zh.js merges every fragment after its own
   dictionary (a key here wins over the same key in zh.js). */
(function (root) {
  const part = { dict: {
    "ResearchTool home": "ResearchTool 首页",
    "Views": "视图",
    "Overview": "概览",
    "Search papers and actions…": "搜索论文和操作…",
    "Go to anything: find a paper or an action ({0}K)": "跳转到任意位置：查找论文或操作（{0}K）",
    "Help": "帮助",
    "Help: the guide, a tour of this screen and the keyboard shortcuts": "帮助：指南、当前页面导览和键盘快捷键",
    "More": "更多",
    "More: export references, recently deleted papers, backups": "更多：导出参考文献、最近删除的论文、备份",
    "Guide": "指南",
    "Take the tour of this screen": "导览当前页面",
    "Keyboard shortcuts": "键盘快捷键",
    "Export references…": "导出参考文献…",
    "Recently deleted…": "最近删除…",
    "Backups…": "备份…",
    "Dismiss": "关闭",
    "Dismiss for a week": "一周内不再显示",
    "Open backup settings": "打开备份设置",
    "The last backup of your workspace was made {0}.": "你的工作区上次备份于{0}。",
    "Your workspace has no backup yet.": "你的工作区还没有备份。",
    "the export folder": "导出文件夹",
    "Write references.bib, notes.md, library.csv and the reading notes (the notes/ folder) to {0}? Files of an earlier export there are replaced. The folder is set in Preferences › Library & files.":
      "将 references.bib、notes.md、library.csv 和阅读笔记（notes/ 文件夹）写入 {0}？那里以前导出的文件会被替换。导出文件夹在“偏好设置 › 文献库与文件”中设置。",
    "Export": "导出",
    "Exported to the export folder: {0}": "已导出到导出文件夹：{0}",
    "Export failed: {0}": "导出失败：{0}",
    // {2} is "3 backups" (already "3 个备份"): no second measure word
    "Last backup: {0} ({1}) · {2} kept, {3} on disk": "上次备份：{0}（{1}）· 保留 {2}，磁盘上 {3}",
  }, keep: ['Claude', 'ResearchTool', 'Codex', 'Grok', 'Gemini', 'OpenAI', 'ChatGPT', 'xAI', 'Google', 'Antigravity'], notUi: ["RT.icon: no icon named '{0}'"], rules: [
    // the boot notice of missing tools: each tool's own words translated, joined with the Chinese comma
    [/^Not found on this machine: (.+)$/, (m, tr) => '本机未找到：' + m[1].split(', ').map((x) => tr(x.trim(), 1) || x).join('、')],
  ], captureWords: ['today', 'yesterday'] };
  if (typeof module === 'object' && module.exports) module.exports = part;
  else (root.RT_I18N_ZH_PARTS = root.RT_I18N_ZH_PARTS || []).push(part);
})(typeof window !== 'undefined' ? window : globalThis);
