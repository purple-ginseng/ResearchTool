/* Chinese (Simplified) dictionary fragment: the strings of the library area of the UI refresh (library-list.js,
   categories.js, organize.js, project-papers.js, compare.js, lineage.js). Same shape as zh.js; zh.js merges every
   fragment after its own dictionary (a key here wins over the same key in zh.js). */
(function (root) {
  const part = { dict: {
    // ---- toolbar: search, full-text chip, groups, overflow menu
    "Search title, author, tag…": "搜索标题、作者、标签…",
    "Search everywhere": "全局搜索",
    "Search everywhere ({0}K): papers, notes and every action": "全局搜索（{0}K）：论文、笔记和所有操作",
    "Search everywhere ({0}K)": "全局搜索（{0}K）",
    "Full text": "全文",
    "Full text: searching inside the PDFs, notes and key points too - click to search titles and details only": "全文：同时在 PDF、笔记和要点中搜索——点击改为只搜索标题和信息",
    "Full text: also search inside the PDFs, notes and key points": "全文：同时在 PDF、笔记和要点中搜索",
    "Also search inside the PDFs, notes and key points": "同时在 PDF、笔记和要点中搜索",
    "Add by ID": "按 ID 添加",
    "Explore": "探索",
    "More actions": "更多操作",
    "More actions: expand or collapse all groups, recently deleted, venues, briefs": "更多操作：展开或折叠所有分组、最近删除、发表信息、简介",
    "No grouping": "不分组",
    "Check venues of {0}…": "检查 {0}的发表信息…",
    "Write the missing brief with Claude…": "用 Claude 写缺少的简介…",
    "Write the {0} missing briefs with Claude…": "用 Claude 写缺少的 {0} 篇简介…",
    "Every paper has a brief": "每篇论文都有简介",
    // ---- filter chips
    "All": "全部",
    "No PDF": "无 PDF",
    "Clear filters": "清除筛选",
    "Clear the filters (show all papers)": "清除筛选（显示所有论文）",
    "Show all papers again": "重新显示所有论文",
    "Tag filter: click to show all tags again": "标签筛选：点击以重新显示所有标签",
    // ---- list: divider, rows, project chip
    "Years": "年份",
    "Not grouped": "未分组",
    "No PDF attached: open the paper to attach one": "未附加 PDF：打开论文即可附加",
    "Working project: “{0}”. Papers you bookmark are added to this project. Click to switch it; drop papers here to add them.": "工作项目：“{0}”。你加书签的论文会添加到这个项目。点击可切换项目；把论文拖到这里即可添加。",
    // ---- empty states
    "No papers match “{0}”": "没有与“{0}”匹配的论文",
    "No papers match these filters": "没有符合这些筛选条件的论文",
    "The filters above the list are on too.": "列表上方的筛选也在生效。",
    "Search inside PDFs too": "同时搜索 PDF 内容",
    // ---- Ask across papers (compare.js)
    "No table yet": "还没有表格",
    "Select a few papers in the Library list ({0}-click or Shift-click) or right-click a category, and choose Compare. Claude reads each paper once and fills a table with the method, the data, the results - or whatever columns you name - each with the pages it comes from. You can also ask all of them one question.": "在文献库列表中选择几篇论文（{0}-点击或 Shift-点击），或右键点击某个类别，然后选择“对比”。Claude 会逐篇阅读论文一次，并填写一张表格：方法、数据、结果——或你指定的任意列——每项都注明来源页码。你也可以向所有论文提同一个问题。",
    "Use the {0} selected papers": "使用所选的 {0} 篇论文",
    // ---- Lineage (lineage.js)
    "In “{0}” - Remove": "已在“{0}”中 - 移除",
    // ---- measure words: {1} / {0} below already carry 篇 (plural(n, 'paper') -> "3 篇论文")
    "“{0}” has {1} - the first {2} are ticked.": "“{0}”有 {1}——已勾选前 {2} 篇。",
    "Venue check {0}. Of the {1} checked: {2}": "发表检查{0}。在已检查的 {1}中：{2}",
    "· {0} by title or details": "· {0}按标题或信息匹配",
  }, keep: [], notUi: [], rules: [], captureWords: [] };
  if (typeof module === 'object' && module.exports) module.exports = part;
  else (root.RT_I18N_ZH_PARTS = root.RT_I18N_ZH_PARTS || []).push(part);
})(typeof window !== 'undefined' ? window : globalThis);
