/* Chinese (Simplified) dictionary fragment: the strings of the reader area of the UI refresh. Same shape as zh.js; zh.js
   merges every fragment after its own dictionary (a key here wins over the same key in zh.js). */
(function (root) {
  const part = { dict: {
    // tabs of the working pane and their context bar
    "Views of this paper": "论文视图",
    "Notes: your reading note of the paper": "笔记：你对这篇论文的阅读笔记",
    "Key points: the sentences that carry the paper, with your remarks": "要点：论文中的关键句子，以及你的批注",
    "Draft": "草稿",
    "Draft with Claude": "用 Claude 起草",
    "Drafting…": "正在起草…",
    "Figures": "图表",
    // the note's ⋯ menu
    "Compare and restore earlier versions of this note": "比较并恢复这篇笔记的早期版本",
    "Import and template": "导入与模板",
    "The format guide Claude follows when it writes a first draft": "Claude 撰写初稿时遵循的格式指南",
    "Languages": "语言",
    "The language of the editor's own menus and hints": "编辑器自身菜单和提示所用的语言",
    // the empty note
    "Write your own, or let Claude draft a first version from the paper.": "自己动手写，或让 Claude 根据论文起草第一版。",
    "Start writing": "开始写作",
    // the Vditor toolbar (tip: values)
    "Summary callout (green)": "摘要提示框（绿色）",
    "Key explanation callout (red)": "重点讲解提示框（红色）",
    "Concept callout (purple)": "概念解释提示框（紫色）",
    "Background callout (orange)": "背景介绍提示框（橙色）",
    "Physical-quantity table": "物理量表",
    "Split view: editor + rendered preview": "分栏：编辑 + 渲染预览",
    // the PDF toolbar
    "Annotate": "标注",
    "Navigate": "导航",
    "Window": "窗口",
    "More PDF tools": "更多 PDF 工具",
    // the Details tab
    "PDF file": "PDF 文件",
    "Open PDF": "打开 PDF",
    "Mark": "标记",
    "Star": "星标",
    "Metadata": "元数据",
    // the Related tab
    "No reference list found": "没有找到参考文献列表",
    "Neither OpenAlex nor Semantic Scholar has the reference list of this paper. That is common for a recent preprint; the refresh button asks again.": "OpenAlex 和 Semantic Scholar 都没有这篇论文的参考文献列表。新近的预印本常常如此；刷新按钮会再查询一次。",
    "No citing papers yet": "还没有引用它的论文",
    "Nothing in this list matches the filter": "列表中没有符合筛选条件的条目",
    // the Claude panel
    "Claude Code": "Claude Code",
    // quiz: plural() already gives "7 道题", so the patterns add no 道 of their own
    "Review: {0} due today, from all papers": "复习：今天有 {0} 到期，来自所有论文",
    "{0} {1} still due today{2}.": "今天仍有 {0}到期{2}。",
    // the save state of the note and of the Details fields (a time follows)
    "Saved {0}": "已保存 {0}",
    "Autosaved {0}": "已自动保存 {0}",
  }, keep: ['Claude Code'], notUi: [], rules: [], captureWords: [] };
  if (typeof module === 'object' && module.exports) module.exports = part;
  else (root.RT_I18N_ZH_PARTS = root.RT_I18N_ZH_PARTS || []).push(part);
})(typeof window !== 'undefined' ? window : globalThis);
