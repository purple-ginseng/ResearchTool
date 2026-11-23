/* Chinese (Simplified) dictionary fragment: the AI provider (Preferences › AI, the read-only AI panel, the status
   dialog of Codex / Grok Build / Antigravity) and the server's messages about it (lib/ai). Same shape as zh.js; zh.js
   merges every fragment after its own dictionary. The provider's name itself is never translated (keep). */
(function (root) {
  const part = { dict: {
    "AI": "AI",
    "AI provider": "AI 提供方",
    "The command-line AI tool on this computer that the AI features use, signed in with your own account. ResearchTool never asks for an API key and never stores one.":
      "AI 功能所使用的本机命令行 AI 工具，用你自己的账户登录。ResearchTool 从不索要 API 密钥，也从不保存密钥。",
    "Check again whether it is installed and signed in": "重新检查是否已安装并已登录",
    "Check again": "重新检查",
    "the CLI's default": "该 CLI 的默认模型",
    "Model for grouping": "分组所用模型",
    "the same model": "同一模型",
    "Not installed on this computer.": "本机未安装。",
    "Install it in a terminal, then start ResearchTool again:": "请在终端中安装，然后重新启动 ResearchTool：",
    "Installed, signed in": "已安装，已登录",
    "Installed, not signed in": "已安装，未登录",
    "Installed; the sign-in could not be checked": "已安装；无法检查登录状态",
    "Sign in with the person button in the AI panel.": "请用 AI 面板中的人像按钮登录。",
    "To sign in with your own account, run this in a terminal:": "要用你自己的账户登录，请在终端中运行：",
    "Use an API key from the environment ResearchTool was started with, instead of my account (off unless you tick it):": "使用启动 ResearchTool 时环境中的 API 密钥，而不是我的账户（除非勾选，否则不使用）：",
    "With this provider the AI panel is read-only: it reads your files but does not edit them.": "使用此提供方时 AI 面板为只读：它会读取你的文件，但不会编辑。",
    "First drafts are written from the text extracted from the PDF.": "初稿根据从 PDF 中提取的文本撰写。",
    "Questions about a picture in a note work.": "可以就笔记中的图片提问。",
    "Questions about a picture in a note are not possible with this provider.": "使用此提供方时无法就笔记中的图片提问。",
    "Only Claude Code reads PDFs itself.": "只有 Claude Code 会自行读取 PDF。",
    "Only Claude Code (and Codex, when you let it) edits files; only Claude Code reads PDFs itself.": "只有 Claude Code（以及你允许时的 Codex）会编辑文件；只有 Claude Code 会自行读取 PDF。",
    "With this provider the AI panel edits files, because you let it (below).": "使用此提供方时 AI 面板会编辑文件，因为你已允许（见下方）。",
    "With this provider the AI panel is read-only unless you let it edit files (below).": "使用此提供方时 AI 面板为只读，除非你允许它编辑文件（见下方）。",
    "Let Codex edit files in the AI panel": "允许 Codex 在 AI 面板中编辑文件",
    // the AI panel's checks (lib/projects.js aiRoot, lib/routes/claude.js)
    "The folder of the project “{0}” cannot be given to the AI: it is not a folder.": "项目“{0}”的文件夹不能交给 AI：它不是文件夹。",
    "The folder of the project “{0}” cannot be given to the AI: it is not in the projects folder of the workspace.": "项目“{0}”的文件夹不能交给 AI：它不在工作区的项目文件夹中。",
    "The folder of the project “{0}” cannot be given to the AI: it is the home folder, a folder that holds it, or a whole disk.": "项目“{0}”的文件夹不能交给 AI：它是主文件夹、包含主文件夹的文件夹，或整个磁盘。",
    "The folder of the project “{0}” cannot be given to the AI: it is the workspace, a folder inside it or a folder that holds it.": "项目“{0}”的文件夹不能交给 AI：它是工作区、工作区中的文件夹或包含工作区的文件夹。",
    "The folder of the project “{0}” cannot be given to the AI: its entry in settings.json no longer matches the folder that was opened. Open the folder again (Write › Open folder on disk…).": "项目“{0}”的文件夹不能交给 AI：它在 settings.json 中的记录与当初打开的文件夹已不一致。请重新打开该文件夹（写作 › 打开磁盘上的文件夹…）。",
    "ResearchTool undid what this run did to agent files, which later AI runs would load as instructions: {0}. A new one is in the workspace trash (trash/ai-agent-files).": "ResearchTool 撤销了本次运行对智能体文件所做的改动（之后的 AI 运行会把这些文件当作指令加载）：{0}。新建的文件已移到工作区的废纸篓（trash/ai-agent-files）。",
    "It runs in Codex's workspace-write sandbox: it can change the files of the open project and your reading notes, nothing else of the workspace, with no network. Each change to a LaTeX project is recorded in the project history and can be restored. Off unless you tick it.":
      "它在 Codex 的 workspace-write 沙箱中运行：只能修改当前打开项目的文件和你的阅读笔记，工作区中的其他内容都不能修改，且不能联网。对 LaTeX 项目的每次修改都会记录在项目历史中，并可恢复。除非勾选，否则不启用。",
    "Read-only:": "只读：",
    "Claude can read your library, notes and project files but cannot change them.": "Claude 可以读取你的文献库、笔记和项目文件，但不能修改它们。",
    "To let the AI edit your files, choose Claude Code in Preferences › AI, or tick “Let Codex edit files” there with Codex.": "如需让 AI 编辑你的文件，请在“偏好设置 › AI”中选择 Claude Code，或在使用 Codex 时勾选“允许 Codex 编辑文件”。",
    "▸ This conversation was with another AI provider, so a new one starts here.": "▸ 这段对话是与另一个 AI 提供方进行的，因此这里开始一段新对话。",
    "The AI provider chosen in Preferences › AI is not installed on this computer.": "“偏好设置 › AI”中选择的 AI 提供方未安装在本机上。",
    "Open a terminal and run:{0}": "打开终端并运行：{0}",
    "Sign in (see below), then check again.": "登录（见下文），然后重新检查。",
    "The sign-in could not be checked.": "无法检查登录状态。",
    "To sign in with your own account, run this in a terminal (ResearchTool never asks for a password or a key):": "要用你自己的账户登录，请在终端中运行以下命令（ResearchTool 从不索要密码或密钥）：",
    "With this provider the AI panel is read-only: it reads your files but does not change them. PDFs are sent as their extracted text.": "使用此提供方时 AI 面板为只读：它会读取你的文件，但不会修改。PDF 以提取出的文本发送。",
    "With this provider the AI panel edits files, because you let it in Preferences › AI. PDFs are sent as their extracted text.": "使用此提供方时 AI 面板会编辑文件，因为你已在“偏好设置 › AI”中允许。PDF 以提取出的文本发送。",
    // the server's messages (lib/ai, lib/notes.js)
    "This AI provider cannot look at pictures in ResearchTool yet - select the caption or the text around the picture, or switch to Claude Code or Codex in Preferences › AI.":
      "此 AI 提供方目前还不能在 ResearchTool 中查看图片——请选择图注或图片周围的文字，或在“偏好设置 › AI”中改用 Claude Code 或 Codex。",
    "Not signed in to {0}. Run “{1}” in a terminal, then try again.": "尚未登录 {0}。请在终端中运行“{1}”，然后重试。",
    // status: accounts, notes and warnings of the providers (lib/ai/providers)
    "xAI account": "xAI 账户",
    "an API key from the environment (GEMINI_API_KEY)": "环境中的 API 密钥（GEMINI_API_KEY）",
    "an API key from the environment (XAI_API_KEY)": "环境中的 API 密钥（XAI_API_KEY）",
    "Grok Build runs read-only only where its sandbox works (macOS, Linux 5.13 or later); on Windows ResearchTool stops its calls.":
      "Grok Build 只有在其沙箱可用的系统上（macOS、Linux 5.13 或更高版本）才以只读方式运行；在 Windows 上 ResearchTool 会停止它的调用。",
    "Grok Build has no read-only sandbox on Windows, so ResearchTool stops its calls there. Choose another AI provider.":
      "Grok Build 在 Windows 上没有只读沙箱，因此 ResearchTool 会在那里停止它的调用。请选择其他 AI 提供方。",
    "Your ~/.codex/config.toml is not used for these calls (only where Codex keeps your sign-in): its model, profiles and MCP servers do not apply here.":
      "这些调用不使用你的 ~/.codex/config.toml（只读取 Codex 保存登录信息的位置）：其中的模型、配置档和 MCP 服务器在这里不生效。",
    "Grok could not apply its read-only sandbox on this computer, so ResearchTool stopped the call (Grok's sandbox works on macOS and on Linux 5.13 or later, not on Windows). Choose another AI provider in Preferences › AI.":
      "Grok 无法在这台电脑上启用只读沙箱，因此 ResearchTool 停止了这次调用（Grok 的沙箱适用于 macOS 和 Linux 5.13 或更高版本，不适用于 Windows）。请在“偏好设置 › AI”中选择其他 AI 提供方。",
    "Grok did not accept ResearchTool's list of read-only tools, so ResearchTool stopped the call. Update Grok Build (grok update) or choose another AI provider in Preferences › AI.":
      "Grok 没有接受 ResearchTool 的只读工具列表，因此 ResearchTool 停止了这次调用。请更新 Grok Build（grok update），或在“偏好设置 › AI”中选择其他 AI 提供方。",
    // Google Antigravity (agy, lib/ai/providers/antigravity.js)
    "Run “agy” once in a terminal and sign in with Google (a personal Google account works). ResearchTool cannot check the sign-in without a call: it shows at the first one.":
      "请在终端中运行一次“agy”并用 Google 账户登录（个人 Google 账户也可以）。ResearchTool 无法在不发起调用的情况下检查登录状态：第一次调用时才会知道。",
    "ResearchTool does not check the Antigravity sign-in (that would mean starting agy): it shows at the first call.":
      "ResearchTool 不检查 Antigravity 的登录状态（那需要启动 agy）：第一次调用时才会知道。",
    "ResearchTool could not tell which version of Antigravity is installed, so it did not start it. Update Antigravity (agy update) or choose another AI provider in Preferences › AI.":
      "ResearchTool 无法确定已安装的 Antigravity 版本，因此没有启动它。请更新 Antigravity（agy update），或在“偏好设置 › AI”中选择其他 AI 提供方。",
    "Antigravity {0} is too old for ResearchTool (it needs {1} or later to run read-only). Update Antigravity (agy update), then try again.":
      "Antigravity {0} 对 ResearchTool 来说太旧了（需要 {1} 或更高版本才能以只读方式运行）。请更新 Antigravity（agy update），然后重试。",
    "This version of Antigravity does not know the options ResearchTool runs it with read-only, so ResearchTool stopped the call. Update Antigravity (agy update), then try again.":
      "这个版本的 Antigravity 不认识 ResearchTool 以只读方式运行它所用的选项，因此 ResearchTool 停止了这次调用。请更新 Antigravity（agy update），然后重试。",
    "Antigravity did not report the permission mode it runs in, so ResearchTool stopped the call before using its answer. Update Antigravity (agy update) or choose another AI provider in Preferences › AI.":
      "Antigravity 没有报告它运行时的权限模式，因此 ResearchTool 在使用其回答之前停止了这次调用。请更新 Antigravity（agy update），或在“偏好设置 › AI”中选择其他 AI 提供方。",
    "Antigravity answered without first reporting the permission mode it runs in, so ResearchTool stopped the call before using its answer. Update Antigravity (agy update) or choose another AI provider in Preferences › AI.":
      "Antigravity 在报告其权限模式之前就开始回答，因此 ResearchTool 在使用其回答之前停止了这次调用。请更新 Antigravity（agy update），或在“偏好设置 › AI”中选择其他 AI 提供方。",
    "Antigravity tried to use a file outside the folders ResearchTool gave it, so ResearchTool stopped the call before using its answer. Check your Antigravity settings (Non-Workspace Access, allow rules, hooks) or choose another AI provider in Preferences › AI.":
      "Antigravity 试图使用 ResearchTool 提供的文件夹之外的文件，因此 ResearchTool 在使用其回答之前停止了这次调用。请检查你的 Antigravity 设置（Non-Workspace Access、允许规则、hooks），或在“偏好设置 › AI”中选择其他 AI 提供方。",
    "Antigravity has not been set up on this computer yet: run “agy” once in a terminal and sign in with Google.":
      "这台电脑上还没有设置 Antigravity：请在终端中运行一次“agy”并用 Google 账户登录。",
    "Not signed in to Antigravity. Run “agy” in a terminal and sign in with Google, then try again.":
      "尚未登录 Antigravity。请在终端中运行“agy”并用 Google 账户登录，然后重试。",
    "Antigravity stopped at its time limit before the answer was complete. Try again, or choose a shorter text.":
      "Antigravity 在回答完成前达到了时间上限并停止。请重试，或选择更短的文本。",
    "This conversation is not known to {0} any more.": "{0} 已不再记得这段对话。",
    "Antigravity could not run with its sandbox on this computer, so ResearchTool stopped the call (it needs the OS sandbox: macOS, Linux with user namespaces, Windows 11 24H2 or later). Choose another AI provider in Preferences › AI.":
      "Antigravity 无法在这台电脑上启用沙箱运行，因此 ResearchTool 停止了这次调用（它需要操作系统沙箱：macOS、启用了用户命名空间的 Linux、Windows 11 24H2 或更高版本）。请在“偏好设置 › AI”中选择其他 AI 提供方。",
    "Antigravity did not accept ResearchTool's read-only settings, so ResearchTool stopped the call. Update Antigravity (agy update) or choose another AI provider in Preferences › AI.":
      "Antigravity 没有接受 ResearchTool 的只读设置，因此 ResearchTool 停止了这次调用。请更新 Antigravity（agy update），或在“偏好设置 › AI”中选择其他 AI 提供方。",
    "Antigravity started with the permission mode “{0}” instead of asking for approval, so ResearchTool stopped the call before using its answer. Choose another AI provider in Preferences › AI.":
      "Antigravity 以权限模式“{0}”启动，而不是先请求批准，因此 ResearchTool 在使用其回答之前停止了这次调用。请在“偏好设置 › AI”中选择其他 AI 提供方。",
    "Application Default Credentials (AGY_ADC_AUTH)": "应用默认凭据（AGY_ADC_AUTH）",
    "{0} says the usage limit of your account is reached: {1}": "{0} 表示你账户的用量已达上限：{1}",
    "{0} returned an empty answer.": "{0} 返回了空回答。",
    // saved content and messages that name the provider which produced them; the Guide for other providers
    "Draft by {0}": "{0} 的草稿",
    "Draft by {0} - not applied (the note changed meanwhile)": "{0} 的草稿——未应用（期间笔记已被修改）",
    "The note was changed while {0} was writing, so the draft was not put in its place. The draft is in History (“Draft by {1} - not applied”) - restore it from there if you want it.": "{0} 写作期间笔记被修改，因此草稿没有替换笔记。草稿在历史中（“{1} 的草稿——未应用”）——如需要可从那里恢复。",
    "picked by {0}": "由 {0} 挑选",
    "Grouped with {0} (library re-group)": "由 {0} 分组（文献库重新分组）",
    "{0} returned no brief for this paper.": "{0} 没有为这篇论文返回简介。",
    "{0} cannot look at pictures in ResearchTool yet - select the caption or the text around the picture, or choose a provider that reads pictures in Preferences › AI.": "{0} 目前还不能在 ResearchTool 中查看图片——请选择图注或图片周围的文字，或在“偏好设置 › AI”中选择能读取图片的提供方。",
    "{0} cannot watch a video.": "{0} 无法观看视频。",
    "{0} cannot look at an SVG picture - select its caption or the text around it instead.": "{0} 无法查看 SVG 图片——请改为选择它的图注或周围的文字。",
    "{0} returned an empty answer - try again.": "{0} 返回了空回答——请重试。",
    "{0} could not answer: {1}": "{0} 无法回答：{1}",
    // Help › Copy diagnostics (diagnostics.js, core.js) and the reader's lost paper (reader.js)
    "Copy diagnostics": "复制诊断信息",
    "Copy diagnostics: versions, AI status and the last errors, as text for a bug report (no papers, notes or account names)": "复制诊断信息：版本、AI 状态和最近的错误，以文本形式用于错误报告（不含论文、笔记或账户名）",
    "Copy diagnostics for a bug report": "复制诊断信息（用于错误报告）",
    "Diagnostics copied - paste them into your bug report": "诊断信息已复制——请粘贴到你的错误报告中",
    "Diagnostics": "诊断信息",
    "The clipboard could not be used. The text below is selected: copy it ({0}) and paste it into your bug report.": "无法使用剪贴板。下面的文本已选中：请复制（{0}）并粘贴到你的错误报告中。",
    "Something went wrong - Help › Copy diagnostics has the details": "出错了——“帮助 › 复制诊断信息”中有详细信息",
    "This paper is no longer in the library view - reopen it from the list": "这篇论文已不在文献库视图中——请从列表中重新打开它",
    // an older Claude Code that refuses an option of the AI features also with the compatible set (lib/ai/claude-compat.js)
    "Claude Code needs an update: run \"claude update\", then try again. Your version ({0}) does not support an option ResearchTool uses.": "Claude Code 需要更新：运行 \"claude update\"，然后重试。你的版本（{0}）不支持 ResearchTool 使用的某个选项。",
    "Claude could not answer: Claude Code needs an update: run \"claude update\", then try again. Your version ({0}) does not support an option ResearchTool uses.": "Claude 无法回答：Claude Code 需要更新：运行 \"claude update\"，然后重试。你的版本（{0}）不支持 ResearchTool 使用的某个选项。",
    "{0} did not return the cells of this paper - try again.": "{0} 没有返回这篇论文的单元格——请重试。",
    "{0} could not be started - check in Preferences › AI that it is installed and signed in ({1}).": "无法启动 {0}——请在“偏好设置 › AI”中检查它是否已安装并已登录（{1}）。",
    "The brief could not be written:": "无法写出简介：",
    "Questions about a snapshot need a provider that reads pictures (Preferences › AI); with this one, select the caption or the text around the figure instead.": "就截图提问需要能读取图片的提供方（偏好设置 › AI）；使用当前提供方时，请改为选择图注或图表周围的文字。",
    ": select a phrase, or right-click a paragraph or a table (a picture is asked about through its caption, as this provider cannot look at pictures), and choose": "：选中一个短语，或右键点击段落或表格（图片通过其图注提问，因为此提供方无法查看图片），然后选择",
    "Accepted — the change is kept in the history as a version by {0}.": "已接受——此修改在历史中是一个 {0} 版本。",
    "Draft inserted, citing {0} paper{1} — it is kept in the history as a version by {2}.": "草稿已插入，引用了 {0} 篇论文——它在历史中是一个 {2} 版本。",
    "Note kept instead of the draft": "保留了笔记，未采用草稿",
    "Claude Code could not be started. Open the Claude panel and check the account (person button).": "无法启动 Claude Code。请打开 Claude 面板并检查账户（人像按钮）。",
    "{0} is starting…": "{0} 正在启动…",
    "{0} is reading the paper…": "{0} 正在阅读论文…",
    "{0} is thinking about what to ask…": "{0} 正在思考要问什么…",
    "Pages read — {0} is writing the note… (this can take a few minutes)": "页面已读取——{0} 正在写笔记…（可能需要几分钟）",
    "{0} did not return a note (the answer was empty or did not start with a heading). Nothing was saved.": "{0} 没有返回笔记（回答为空或没有以标题开头）。没有保存任何内容。",
    "{0} did not return a quiz. Nothing was saved - try again.": "{0} 没有返回测验。没有保存任何内容——请重试。",
    "{0} did not return a diagram. Nothing was saved - try again.": "{0} 没有返回图解。没有保存任何内容——请重试。",
    "Questions about a picture are not possible with Claude - select its caption or the text around it.": "使用 Claude 时无法就图片提问——请选择它的图注或周围的文字。",
    "Comparison table inserted": "已插入对比表格",
    "Suggest a fix with Claude": "让 Claude 给出修复建议",
    "Suggest fixes for all {0} errors with Claude": "让 Claude 为全部 {0} 个错误给出修复建议",
    "Suggest a fix with Claude: send the errors to the Claude panel, which says what to change (with this provider the panel does not edit files)": "让 Claude 给出修复建议：把错误发送到 Claude 面板，由它说明要改什么（使用此提供方时面板不会编辑文件）",
    "Claude Code account: status and how to sign in": "Claude Code 账户：状态与登录方法",
    "Claude writes the missing briefs of {0} in the background. This uses your Claude account. Start now?": "Claude 将在后台为 {0}补写缺少的简介，这会消耗你的 Claude 用量。现在开始吗？",
    "AI panel": "AI 面板",
    "{0} added {1} not in your library:": "{0} 添加了 {1}不在你文献库中的引用键：",
    "By provider": "按提供方",
    "once in a terminal - the account window shows how.": "只需一次，在终端中完成——账户窗口会显示方法。",
    "Check it now": "立即检查",
    "If Claude Code is not installed, the window shows the command that installs it.": "如果没有安装 Claude Code，窗口会显示安装它的命令。",
    "Sign in once in a terminal, with the command the window shows. ResearchTool has no sign-in of its own for this provider, and the window cannot sign you out.": "用窗口显示的命令在终端中登录一次。对此提供方，ResearchTool 没有自己的登录，窗口也无法帮你退出登录。",
    "You never type a password or an API key into ResearchTool: Claude Code keeps its own sign-in, the same one it uses in a terminal. Preferences › AI changes the provider at any time.": "你永远不需要在 ResearchTool 中输入密码或 API 密钥：Claude Code 自己保存登录信息，与它在终端中使用的是同一个。随时可在“偏好设置 › AI”中更换提供方。",
    ": ask about the open paper or project. With this provider it only reads your files: it shows a change as text, for you to make.": "：询问当前论文或项目。使用此提供方时它只读取你的文件：修改会以文本形式给出，由你自己来改。",
    ": Claude reads the text of the PDF and writes the note in your note format. Your previous note stays in the history. The figures and tables the draft refers to are cut out of the PDF and put into the note by the app itself; only a figure that could not be found stays as a 📷 placeholder for the snapshot tool.": "：Claude 阅读 PDF 的文本，并按你的笔记格式写出笔记。你之前的笔记会保留在历史中。初稿提到的图表会由应用本身从 PDF 中裁剪并放入笔记；只有找不到的图才会保留为 📷 占位符，留给截图工具处理。",
  }, keep: ['Codex', 'Grok', 'OpenAI', 'ChatGPT', 'xAI', 'Google', 'Antigravity', 'Claude Code', 'OpenAI Codex', 'xAI Grok Build', 'Codex CLI', 'Grok Build', 'Google Antigravity', 'Antigravity CLI', 'Ctrl+C'],
  // the lines of the diagnostics report (English: read by whoever fixes the bug) and texts that only go into it
  notUi: ['ResearchTool diagnostics (', '(commit {0})', 'App version: {0}{1}', 'OS: {0} {1} ({2})', 'Node: {0}', 'Server details: not available ({0})', 'Browser: {0}',
    'UI language: {0}', 'AI provider: {0} ({1}) - installed: {2}, version: {3}, signed in: {4}', ', using the compatible option set (an older Claude Code)', ', problem: {0}',
    'Tools:', 'Workspace: {0}', 'Recent errors in the page ({0}):', 'Recent AI errors on the server ({0}):', 'no clipboard', 'reader: library refresh',
    'the open paper {0} is not in RT.library.items() ({1} items)'] };
  if (typeof module === 'object' && module.exports) module.exports = part;
  else (root.RT_I18N_ZH_PARTS = root.RT_I18N_ZH_PARTS || []).push(part);
})(typeof window !== 'undefined' ? window : globalThis);
