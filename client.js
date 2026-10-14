// Browser half of dsh-workspace-toolkit.
// Workspace utility toolkit: open workspace path in file explorer, batch archive
// sessions, and future file/session operations.
// Injects items into each workspace row's ellipsis menu using DOM observation.

window.__ModuleLoader__.load({
  id: 'dsh-workspace-toolkit',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports


    // ---- Lightweight locale (DSH locale switching is not reachable from an external plugin). ----
    function isZh() {
      var lang = (typeof navigator !== 'undefined' && navigator.language) || 'en'
      return lang.indexOf('zh') === 0
    }
    var LABELS = {
      copyPath: isZh() ? '复制工作区路径' : 'Copy Workspace Path',
      copied: isZh() ? '已复制到剪贴板' : 'Copied to clipboard',
      copyFailed: isZh() ? '复制失败：' : 'Copy failed: ',
      batchArchive: isZh() ? '批量归档会话…' : 'Batch Archive Sessions…',
      batchArchiveTitle: isZh() ? '批量归档会话' : 'Batch Archive Sessions',
      selectAll: isZh() ? '全选' : 'Select all',
      archiveSelected: isZh() ? '归档所选' : 'Archive selected',
      cancel: isZh() ? '取消' : 'Cancel',
      close: isZh() ? '关闭' : 'Close',
      noSessions: isZh() ? '该工作区下没有可归档的会话。' : 'No archivable sessions in this workspace.',
      loading: isZh() ? '加载中…' : 'Loading…',
      archiveFailed: isZh() ? '归档失败：' : 'Archive failed: ',
      archivedCount: isZh() ? '已归档 {n} 个会话' : 'Archived {n} sessions',
      selectedCount: isZh() ? '已选择 {n} 个' : '{n} selected',
      workspaceNotFound: isZh() ? '未找到该工作区，请重试。' : 'Workspace not found. Please try again.',
      attachmentOpenFailed: isZh() ? '无法打开该附件：' : 'Cannot open attachment: ',
      attachmentNotFound: isZh() ? '未找到该附件的存储路径。' : 'Attachment file not found.',
      pasteTextFallback: isZh() ? '粘贴的文本' : 'Pasted text',
      pasteConverted: isZh() ? '内容较长，已转为文件附件：' : 'Long content converted to attachment: ',
      pasteRestore: isZh() ? '粘贴原文至输入框' : 'Paste original',
      pasteRestored: isZh() ? '已恢复原文至输入框' : 'Content restored to the input box',
      pasteTooLongRestore: isZh() ? '内容过长，无法恢复至输入框' : 'Content too long to restore',
      expand: isZh() ? '展开' : 'Expand',
      collapse: isZh() ? '收起' : 'Collapse'
    }

    // ---- Workspace row tracking ----
    var pendingWorkspace = null // { workspaceId, path, title, expires }

    function isWorkspaceMenuButton(btn) {
      var label = btn.getAttribute('aria-label') || ''
      return label.indexOf('Workspace actions') !== -1 ||
        (label.indexOf('工作区') !== -1 && label.indexOf('的操作') !== -1)
    }

    function findWorkspaceRow(el) {
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.getAttribute && el.getAttribute('role') === 'treeitem') return el
        el = el.parentElement
      }
      return null
    }

    // Workspace cache populated from ctx.workspaces.list
    var workspaceItems = []
    var archivedSessionIds = []

    function extractTitleFromAria(label) {
      var m = label.match(/工作区“([^”]+)”的操作/)
      if (m) return m[1]
      m = label.match(/Workspace actions for (.+)/)
      if (m) return m[1]
      return null
    }

    function findWorkspaceItemByTitle(title) {
      for (var i = 0; i < workspaceItems.length; i++) {
        if (workspaceItems[i].title === title) return workspaceItems[i]
      }
      return null
    }

    function findWorkspaceItemById(id) {
      for (var i = 0; i < workspaceItems.length; i++) {
        if (workspaceItems[i].workspaceId === id) return workspaceItems[i]
      }
      return null
    }

    // Session cache populated from ctx.sessions.list
    var sessionById = {}
    var sessionIds = []
    var sessionCurrent = null
    var sessionPhase = 'idle'

    document.addEventListener('pointerdown', function (e) {
      var target = e.target
      if (!(target instanceof Element)) { pendingWorkspace = null; return }
      // 菜单内部（菜单项）的点击不清空 pendingWorkspace——它正被点击的
      // 菜单项消费。否则 pointerdown 先清、click 后读 → 永远是 null。
      if (target.closest('[role="menu"]')) return
      var btn = target.closest('button[aria-label]')
      if (!btn) { pendingWorkspace = null; return }
      var label = btn.getAttribute('aria-label') || ''
      var isSessionMenu = label.indexOf('Session actions') !== -1 ||
        (label.indexOf('会话') !== -1 && label.indexOf('的操作') !== -1)
      if (isSessionMenu) {
        pendingWorkspace = null
        return
      }
      // 除工作区行菜单按钮外的任何点击都立即作废 pendingWorkspace，
      // 防止 10 秒窗口内打开其它菜单（会话下拉/打开按钮）被误注入。
      if (!isWorkspaceMenuButton(btn)) { pendingWorkspace = null; return }
      var row = findWorkspaceRow(btn)
      if (!row) { pendingWorkspace = null; return }
      var title = extractTitleFromAria(label)
      var item = title ? findWorkspaceItemByTitle(title) : null
      var workspaceId = (item && item.workspaceId) || null
      // 只在真正的单个工作区行菜单注入；跳过会话菜单和最顶层工作区菜单。
      if (!workspaceId) { pendingWorkspace = null; return }
      pendingWorkspace = {
        workspaceId: workspaceId,
        path: (item && item.path) || null,
        title: title || (item && item.title) || '',
        expires: Date.now() + 10000,
        setAt: Date.now()
      }
    }, true)

    // ---- Toast notification ----
    function showToast(message) {
      var toast = document.createElement('div')
      toast.className = 'dsh-wst-toast'
      toast.setAttribute('role', 'alert')
      toast.textContent = message
      document.body.appendChild(toast)
      var holdMs = 2000
      var fadeMs = 1000
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast)
      }, holdMs + fadeMs + 160)
    }

    // ---- Clipboard helper ----
    function copyTextToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)
      }
      return new Promise(function (resolve, reject) {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try {
          var ok = document.execCommand('copy')
          document.body.removeChild(ta)
          if (ok) resolve()
          else reject(new Error('execCommand copy failed'))
        } catch (err) {
          document.body.removeChild(ta)
          reject(err)
        }
      })
    }


    // ---- Attachment click-to-open (right Sidebar) ----
    // DSH renders user-message file attachments as inert cards. We watch the
    // session event feed for user/message file blocks (each carries a
    // FileAttachmentRef: sha256 digest + sanitized name + byte size), index
    // them by name per session, and make the rendered card openable.  Clicking
    // one resolves attachmentsRoot/files/<sha256[0:2]>/<sha256>/<name> (the
    // content-addressed object path below DSH_HOME) into a
    // dsh-resource://file/session/<id>/<path> address and asks the right
    // Sidebar to open it - the same openResource path the built-in "open file"
    // affordances use, so the viewer, tab title, and renderer selection behave
    // exactly like a source-file preview.
    var attachmentRefsBySession = {} // sessionId -> { name -> FileAttachmentRef }
    var pluginBoot = null

    function toolkitConfig() {
      if (pluginBoot) return pluginBoot
      var cfg = (typeof window !== 'undefined' && window.__DSH_WORKSPACE_TOOLKIT__) || null
      pluginBoot = {
        attachmentsRoot: (cfg && cfg.attachmentsRoot) || null,
        pasteToFileLimit: (cfg && typeof cfg.pasteToFileLimit === 'number') ? cfg.pasteToFileLimit : 2000,
        maxPasteRestoreBytes: (cfg && typeof cfg.maxPasteRestoreBytes === 'number') ? cfg.maxPasteRestoreBytes : 614400
      }
      return pluginBoot
    }

    function attachmentIdHex(ref) {
      var id = ref && ref.attachmentId
      if (typeof id !== 'string') return null
      var m = /^sha256:([a-f0-9]{64})$/.exec(id)
      return m ? m[1] : null
    }

    function attachmentObjectPath(ref) {
      var hex = attachmentIdHex(ref)
      if (!hex || !pluginBoot || !pluginBoot.attachmentsRoot) return null
      return pluginBoot.attachmentsRoot + '/files/' + hex.slice(0, 2) + '/' + hex + '/' + ref.name
    }

    function rememberMessageFileAttachments(sessionId, content) {
      if (!sessionId || !content || !Array.isArray(content)) return
      var bucket = attachmentRefsBySession[sessionId] || (attachmentRefsBySession[sessionId] = {})
      for (var i = 0; i < content.length; i++) {
        var block = content[i]
        if (block && block.type === 'file' && block.attachment && block.attachment.name) {
          bucket[block.attachment.name] = block.attachment
        }
      }
    }

    // 兜底：从会话事件窗口重放 user/message，索引历史消息的附件引用。
    // 新事件走 ctx.on('session/event')；历史页面/首次挂载用这个扫一遍。
    function indexSessionHistory(sessionId) {
      if (!sessionId || !ctx || !ctx.sessions || typeof ctx.sessions.binding !== 'function') return
      var binding = null
      try { binding = ctx.sessions.binding(sessionId) } catch (err) { return }
      if (!binding || !binding.eventSource) return
      var window = null
      try { window = binding.eventSource.getSnapshot() } catch (err) { return }
      if (!window || !window.entries || !Array.isArray(window.entries)) return
      for (var i = 0; i < window.entries.length; i++) {
        var entry = window.entries[i]
        if (!entry || entry.type !== 'event' || !entry.event) continue
        var event = entry.event
        if (event.type !== 'user/message') continue
        rememberMessageFileAttachments(sessionId, event.data && event.data.content)
      }
    }

    function openAttachmentByName(sessionId, name) {
      var bucket = attachmentRefsBySession[sessionId]
      var ref = bucket ? bucket[name] : null
      if (!ref) {
        // 历史消息可能还没进索引：先扫会话事件窗口再试一次。
        indexSessionHistory(sessionId)
        bucket = attachmentRefsBySession[sessionId]
        ref = bucket ? bucket[name] : null
      }
      if (!ref) {
        window.alert(LABELS.attachmentNotFound)
        return
      }
      var objectPath = attachmentObjectPath(ref)
      if (!objectPath) {
        window.alert(LABELS.attachmentOpenFailed + 'missing attachmentsRoot')
        return
      }
      // sessionFileAddress() keeps the absolute path in the session scope; the
      // text tab's canOpen accepts any file/session address and workspace-files
      // read allows files outside the workspace root.
      var address = 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' +
        objectPath.split('/').map(function (seg) { return encodeURIComponent(seg).replace(/%3A/gi, ':') }).join('/')
      var sidebarRight = (ctx && typeof ctx.get === 'function') ? ctx.get('sidebarRight') : null
      if (sidebarRight && typeof sidebarRight.openResource === 'function') {
        sidebarRight.openResource(address)
      } else {
        window.alert(LABELS.attachmentOpenFailed + 'sidebarRight unavailable')
      }
    }

    // Delegate clicks on message attachment cards to openAttachmentByName.
    // CSS-module class names are content-hashed, so we identify the file card
    // structurally: inside [data-message-attachments], an image is a <button>
    // (its own click opens the lightbox) and a file card is a <span> whose
    // title IS the file name (MessageItem renders
    // <span className={fileCard} title={name}>). We walk up from the click
    // target: stop at a <button> (image, leave it alone) and take the nearest
    // titled <span> as the file card.
    document.addEventListener('click', function (e) {
      var target = e.target
      if (!target || typeof target.closest !== 'function') return
      var row = target.closest('[data-message-attachments]')
      if (!row) return
      var el = target
      var card = null
      var ancestry = []
      while (el && el !== row && el !== document.body && el !== document.documentElement) {
        var tag = el.tagName
        ancestry.push(tag + (el.getAttribute && el.getAttribute('title') ? '[title=' + el.getAttribute('title') + ']' : ''))
        if (tag === 'BUTTON') { card = null; break }
        if (tag === 'SPAN' && el.getAttribute && el.getAttribute('title')) { card = el; break }
        el = el.parentElement
      }
      if (!card || !card.getAttribute) return
      // Session id: DSH marks the conversation root with data-conversation-session.
      // Fall back to walking ancestors for any data-session-ish marker.
      var sessionId = null
      var node = row
      while (node && node !== document.body) {
        var marker = node.getAttribute && (node.getAttribute('data-conversation-session') || node.getAttribute('data-session-id') || node.getAttribute('data-session'))
        if (marker) { sessionId = marker; break }
        node = node.parentElement
      }
      if (!sessionId) {
        try {
          var snap = ctx && ctx.sessions && ctx.sessions.list && ctx.sessions.list.getSnapshot()
          var byId = (snap && snap.byId) || {}
          var ids = (snap && snap.ids) || []
          // 无 current 字段：取第一个非 blank 会话作为当前会话兜底（单会话场景成立）。
          for (var i = 0; i < ids.length; i++) {
            var row2 = byId[ids[i]]
            if (row2 && !row2.blank) { sessionId = ids[i]; break }
          }
        } catch (err) {
        }
      }
      if (!sessionId) return
      var name = card.getAttribute('title')
      if (!name) return
      e.preventDefault()
      e.stopPropagation()
      openAttachmentByName(sessionId, name.trim())
    }, true)

    // ---- Paste-to-file (mirrors web deepseek.com) ----
    // When the user pastes plain text longer than pasteToFileLimit characters
    // into the composer, convert it into a .txt attachment through the official
    // draft pipeline instead of inlining it.  The composer contenteditable is
    // marked data-composer-input; the current session comes from ctx.sessions.
    // The native paste handler still runs for short pastes - we only intercept
    // oversized plain-text ones and let them ride the normal upload path.
    var PASTE_TO_FILE = true
    // 粘贴转文件的原文记录：{ sessionId, draftId, name, text }，供 composer
    // 附件卡片上的“粘贴原文至输入框”按钮恢复。draftId 用于释放附件资源，
    // name 用于 DOM 卡片匹配（文件名来自内容，同 session 内唯一）。
    var pasteOriginals = []

    // Web deepseek.com names the file from the first line; DSH composer shows
    // the full name, so we derive it from the TEXT ITSELF (head of the content,
    // whitespace/specials collapsed) instead of a fixed 50-char first line —
    // a long pasted block yields a recognizable name, not a "warning" stub.
    function pasteFileName(text, fallback) {
      var head = text.replace(/\r|\n/g, ' ').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim()
      if (head.length > 24) {
        var cut = 24
        // Avoid splitting a surrogate pair.
        if (head.charCodeAt(cut - 1) >= 0xd800 && head.charCodeAt(cut - 1) <= 0xdbff) cut -= 1
        head = head.slice(0, cut)
      }
      return (head || fallback) + '.txt'
    }

    // ---- 用户超长消息气泡折叠（参考 AI 思考折叠：限高 + 渐隐 + 展开按钮） ----
    // 用户气泡 DOM：[data-chat-flow-kind="user"] 行，气泡是行内文本最多的
    // 文本节点其父容器。CSS-module 类名被 hash，不靠类名，用文本量定位。
    var LONG_TEXT_LIMIT = 2000
    var collapseWatched = {}

    function walkBubbleRows(root) {
      if (!root || typeof root.querySelectorAll !== 'function') return
      var rows = root.querySelectorAll('[data-chat-flow-kind="user"]')
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i]
        var key = row.getAttribute('data-chat-node-key') || row.getAttribute('data-chat-flow-key')
        if (!key) continue
        var len = textLengthOf(row)
        var prev = collapseWatched[key]
        // 同 key 且文本长度未变 → 已处理过（折叠或确认不折叠），跳过。
        // 长度变化（e.g. 渐进渲染/替换）→ 重新评估。
        if (prev !== undefined && prev === len) continue
        maybeCollapseUserRow(row, key, len)
      }
    }

    function maybeCollapseUserRow(row, key, rowTotal) {
      // 判断用行总文本量：超长文本会被 refChip 按钮切成多个 span，单个 span
      // 长度不超阈值，但行总量远超——所以先看行总量，够长才精确定位气泡。
      if (rowTotal <= LONG_TEXT_LIMIT) {
        collapseWatched[key] = rowTotal
        return
      }
      // 气泡定位：取行内最深文本节点，上溯到第一个「DIV 且文本量超阈值」
      // 的容器 = .bubble（.userRow > .userStack > .bubble 嵌套结构）。
      var walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null)
      var node
      var maxLen = 0
      var deepest = null
      while ((node = walker.nextNode())) {
        var len = (node.textContent || '').trim().length
        if (len > maxLen) { maxLen = len; deepest = node }
      }
      if (!deepest) { collapseWatched[key] = rowTotal; return }
      var bubble = deepest.parentElement
      while (bubble && bubble !== row && bubble !== document.body) {
        if (bubble.tagName === 'DIV' && textLengthOf(bubble) > LONG_TEXT_LIMIT) break
        bubble = bubble.parentElement
      }
      if (!bubble || bubble === row || bubble === document.body) {
        collapseWatched[key] = rowTotal
        return
      }
      clampUserBubble(row, bubble)
      collapseWatched[key] = rowTotal
    }

    function textLengthOf(el) {
      if (!el || !el.textContent) return 0
      // 排除插件自己插入的折叠按钮文本：否则按钮自增使长度每轮变化，
      // 触发无限重评估（每扫一次 +2 字符「展开」→ 又插按钮 → 又变长……）。
      var toggles = el.querySelectorAll ? el.querySelectorAll('.dsh-long-text-toggle') : null
      if (!toggles || toggles.length === 0) return el.textContent.length
      var len = 0
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
      var node
      while ((node = walker.nextNode())) {
        if (node.parentElement && node.parentElement.classList && node.parentElement.classList.contains('dsh-long-text-toggle')) continue
        len += (node.textContent || '').length
      }
      return len
    }

    function clampUserBubble(row, bubble) {
      // 幂等：行级检查（按钮插在 bubble 外、行内），已存在就不重复插。
      // 同时清理历史自增 bug 堆叠的多余按钮，只保留第一个。
      var existing = row.querySelectorAll('.dsh-long-text-toggle')
      if (existing.length > 0) {
        for (var si = 1; si < existing.length; si++) {
          if (existing[si].parentNode) existing[si].parentNode.removeChild(existing[si])
        }
        return
      }
      bubble.classList.add('dsh-long-text-clamp')
      var toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'dsh-long-text-toggle'
      toggle.textContent = LABELS.expand
      toggle.setAttribute('aria-expanded', 'false')
      toggle.addEventListener('click', function (ev) {
        ev.preventDefault()
        ev.stopPropagation()
        var expanded = bubble.classList.toggle('dsh-long-text-clamp')
        toggle.textContent = expanded ? LABELS.expand : LABELS.collapse
        toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true')
      })
      // 按钮插在气泡同级、气泡之后（消息操作行之前），不混进 pre-wrap 文本流。
      if (bubble.nextSibling) bubble.parentElement.insertBefore(toggle, bubble.nextSibling)
      else bubble.parentElement.appendChild(toggle)
    }

    // ---- Batch archive dialog ----
    var archiveOverlay = null
    var archivePanel = null

    function formatTime(t) {
      if (!t) return ''
      var d = new Date(t)
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }

    function template(fmt, vars) {
      return fmt.replace(/\{([^{}]+)\}/g, function (_, key) {
        return vars[key] !== undefined ? String(vars[key]) : ''
      })
    }

    function closeArchiveDialog() {
      if (archiveOverlay && archiveOverlay.parentNode) {
        archiveOverlay.parentNode.removeChild(archiveOverlay)
      }
      archiveOverlay = null
      archivePanel = null
    }

    function openArchiveDialog() {
      closeArchiveDialog()
      if (!pendingWorkspace || !pendingWorkspace.workspaceId) {
        window.alert(LABELS.workspaceNotFound)
        return
      }
      var item = findWorkspaceItemById(pendingWorkspace.workspaceId)
      if (!item) {
        window.alert(LABELS.workspaceNotFound)
        return
      }

      var archivedSet = {}
      for (var i = 0; i < archivedSessionIds.length; i++) archivedSet[archivedSessionIds[i]] = true

      // 延迟读取 sessions 快照，避免应用启动/订阅时因 inactive context 抛错。
      if (ctx.sessions && ctx.sessions.list) {
        try {
          var sessionSnap = ctx.sessions.list.getSnapshot()
          sessionIds = sessionSnap.ids || []
          sessionCurrent = sessionSnap.current || null
          sessionById = sessionSnap.byId || {}
          sessionPhase = sessionSnap.phase || 'idle'
        } catch (err) {
          // inactive context 等情况下静默跳过
        }
      }

      var workspaceSessionIds = item.sessionIds || []
      var candidates = []
      for (var j = 0; j < workspaceSessionIds.length; j++) {
        var sid = workspaceSessionIds[j]
        var s = sessionById[sid]
        if (!s) continue
        if (s.blank) continue
        if (archivedSet[sid]) continue
        candidates.push({ id: sid, title: s.displayTitle || s.title || sid, updatedAt: s.updatedAt, running: s.running })
      }

      archiveOverlay = document.createElement('div')
      archiveOverlay.className = 'dsh-batch-archive-overlay'
      archivePanel = document.createElement('div')
      archivePanel.className = 'dsh-batch-archive-panel'
      archivePanel.setAttribute('role', 'dialog')
      archivePanel.setAttribute('aria-modal', 'true')
      archivePanel.setAttribute('aria-label', LABELS.batchArchiveTitle)

      var header = document.createElement('div')
      header.className = 'dsh-batch-archive-header'
      var titleEl = document.createElement('div')
      titleEl.className = 'dsh-batch-archive-title'
      titleEl.textContent = LABELS.batchArchiveTitle + ' — ' + item.title
      var closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.className = 'dsh-batch-archive-close'
      closeBtn.setAttribute('aria-label', LABELS.close)
      closeBtn.textContent = '×'
      closeBtn.addEventListener('click', closeArchiveDialog)
      header.appendChild(titleEl)
      header.appendChild(closeBtn)
      archivePanel.appendChild(header)

      var body = document.createElement('div')
      body.className = 'dsh-batch-archive-body'

      var selectedIds = []
      var listContainer = null
      var selectAllCheckbox = null
      var statusEl = null
      var archiveBtn = null

      function updateState() {
        if (statusEl) statusEl.textContent = template(LABELS.selectedCount, { n: selectedIds.length })
        if (archiveBtn) archiveBtn.disabled = selectedIds.length === 0
        if (selectAllCheckbox && listContainer) {
          var boxes = listContainer.querySelectorAll('input[type="checkbox"][data-session-id]')
          var allChecked = boxes.length > 0
          for (var i = 0; i < boxes.length; i++) {
            if (!boxes[i].checked) { allChecked = false; break }
          }
          selectAllCheckbox.checked = allChecked
        }
      }

      if (candidates.length === 0) {
        var emptyEl = document.createElement('div')
        emptyEl.className = 'dsh-batch-archive-empty'
        emptyEl.textContent = LABELS.noSessions
        body.appendChild(emptyEl)
      } else {
        var toolbar = document.createElement('div')
        toolbar.className = 'dsh-batch-archive-toolbar'
        var selectAllLabel = document.createElement('label')
        selectAllLabel.className = 'dsh-batch-archive-selectall'
        selectAllCheckbox = document.createElement('input')
        selectAllCheckbox.type = 'checkbox'
        var selectAllText = document.createElement('span')
        selectAllText.textContent = LABELS.selectAll
        selectAllLabel.appendChild(selectAllCheckbox)
        selectAllLabel.appendChild(selectAllText)
        statusEl = document.createElement('span')
        statusEl.className = 'dsh-batch-archive-status'
        toolbar.appendChild(selectAllLabel)
        toolbar.appendChild(statusEl)
        body.appendChild(toolbar)

        listContainer = document.createElement('div')
        listContainer.className = 'dsh-batch-archive-list'
        for (var c = 0; c < candidates.length; c++) {
          (function (candidate) {
            var row = document.createElement('label')
            row.className = 'dsh-batch-archive-row'
            if (candidate.running) row.className += ' dsh-batch-archive-running'
            var checkbox = document.createElement('input')
            checkbox.type = 'checkbox'
            checkbox.setAttribute('data-session-id', candidate.id)
            checkbox.addEventListener('change', function () {
              var idx = selectedIds.indexOf(candidate.id)
              if (checkbox.checked && idx === -1) selectedIds.push(candidate.id)
              if (!checkbox.checked && idx !== -1) selectedIds.splice(idx, 1)
              updateState()
            })
            var labelSpan = document.createElement('span')
            labelSpan.className = 'dsh-batch-archive-name'
            labelSpan.textContent = candidate.title
            var timeSpan = document.createElement('span')
            timeSpan.className = 'dsh-batch-archive-time'
            timeSpan.textContent = formatTime(candidate.updatedAt)
            row.appendChild(checkbox)
            row.appendChild(labelSpan)
            row.appendChild(timeSpan)
            listContainer.appendChild(row)
          })(candidates[c])
        }
        body.appendChild(listContainer)

        selectAllCheckbox.addEventListener('change', function () {
          var boxes = listContainer.querySelectorAll('input[type="checkbox"][data-session-id]')
          for (var i = 0; i < boxes.length; i++) {
            var sid = boxes[i].getAttribute('data-session-id')
            boxes[i].checked = selectAllCheckbox.checked
            var idx = selectedIds.indexOf(sid)
            if (selectAllCheckbox.checked && idx === -1) selectedIds.push(sid)
            if (!selectAllCheckbox.checked && idx !== -1) selectedIds.splice(idx, 1)
          }
          updateState()
        })
      }

      archivePanel.appendChild(body)

      var footer = document.createElement('div')
      footer.className = 'dsh-batch-archive-footer'
      archiveBtn = document.createElement('button')
      archiveBtn.type = 'button'
      archiveBtn.className = 'dsh-batch-archive-primary'
      archiveBtn.textContent = LABELS.archiveSelected
      archiveBtn.disabled = true
      archiveBtn.addEventListener('click', function () {
        if (selectedIds.length === 0) return
        if (typeof ctx === 'undefined' || !ctx.uiWorkspace || typeof ctx.uiWorkspace.archiveSession !== 'function') {
          window.alert(LABELS.archiveFailed + 'uiWorkspace.archiveSession not available')
          return
        }
        archiveBtn.disabled = true
        if (cancelBtn) cancelBtn.disabled = true
        archiveBtn.textContent = LABELS.loading

        var failedOnce = false
        function archiveNext(i) {
          if (i >= selectedIds.length) {
            if (!failedOnce) {
              window.alert(template(LABELS.archivedCount, { n: selectedIds.length }))
              closeArchiveDialog()
            } else {
              archiveBtn.disabled = false
              if (cancelBtn) cancelBtn.disabled = false
              archiveBtn.textContent = LABELS.archiveSelected
            }
            return
          }
          ctx.uiWorkspace.archiveSession(selectedIds[i]).then(function () {
            archiveNext(i + 1)
          }).catch(function (err) {
            failedOnce = true
            window.alert(LABELS.archiveFailed + (err && err.message ? err.message : String(err)))
            archiveBtn.disabled = false
            if (cancelBtn) cancelBtn.disabled = false
            archiveBtn.textContent = LABELS.archiveSelected
          })
        }
        archiveNext(0)
      })
      var cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'dsh-batch-archive-secondary'
      cancelBtn.textContent = LABELS.cancel
      cancelBtn.addEventListener('click', closeArchiveDialog)
      footer.appendChild(cancelBtn)
      footer.appendChild(archiveBtn)
      archivePanel.appendChild(footer)

      archiveOverlay.appendChild(archivePanel)
      document.body.appendChild(archiveOverlay)
      updateState()

      archiveOverlay.addEventListener('click', function (e) {
        if (e.target === archiveOverlay) closeArchiveDialog()
      })
    }

    // ---- Menu injection ----
    var COPY_PATH_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'
    var ARCHIVE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path></svg>'

    function makeMenuItem(ref, label, iconSvg, markerAttr, onClick, extraClass) {
      var item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.setAttribute(markerAttr, 'true')
      item.className = ref.className + (extraClass ? ' ' + extraClass : '')
      var refChildren = ref.children
      var iconClass = refChildren[0] ? refChildren[0].className : ''
      var labelClass = refChildren[1] ? refChildren[1].className : ''
      var iconSpan = document.createElement('span')
      if (iconClass) iconSpan.className = iconClass
      iconSpan.innerHTML = iconSvg
      var labelSpan = document.createElement('span')
      if (labelClass) labelSpan.className = labelClass
      labelSpan.textContent = label
      item.appendChild(iconSpan)
      item.appendChild(labelSpan)
      item.addEventListener('click', function (e) {
        e.stopPropagation()
        onClick()
      })
      return item
    }

    function injectMenuItem(menu) {
      if (menu.querySelector('[data-dsh-copy-path-item]') && menu.querySelector('[data-dsh-batch-archive-item]')) return
      var ref = menu.querySelector('[role="menuitem"]')
      if (!ref) return

      if (!menu.querySelector('[data-dsh-copy-path-item]')) {
        var copyPathItem = makeMenuItem(ref, LABELS.copyPath, COPY_PATH_ICON_SVG, 'data-dsh-copy-path-item', function () {
          if (!pendingWorkspace || !pendingWorkspace.path) {
            window.alert(LABELS.workspaceNotFound)
            return
          }
          copyTextToClipboard(pendingWorkspace.path).then(function () {
            showToast(LABELS.copied)
          }).catch(function (err) {
            window.alert(LABELS.copyFailed + (err && err.message ? err.message : String(err)))
          })
        })
        if (ref.parentElement) ref.parentElement.insertBefore(copyPathItem, ref)
        else menu.appendChild(copyPathItem)
      }

      if (!menu.querySelector('[data-dsh-batch-archive-item]')) {
        var archiveItem = makeMenuItem(ref, LABELS.batchArchive, ARCHIVE_ICON_SVG, 'data-dsh-batch-archive-item', function () {
          openArchiveDialog()
        })
        if (ref.parentElement) {
          var sibling = menu.querySelector('[data-dsh-copy-path-item]') || ref
          if (sibling.nextSibling) ref.parentElement.insertBefore(archiveItem, sibling.nextSibling)
          else ref.parentElement.appendChild(archiveItem)
        } else {
          menu.appendChild(archiveItem)
        }
      }
    }

    function handleMenuMutations(mutations) {
      if (!pendingWorkspace || Date.now() > pendingWorkspace.expires) return
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes
        for (var j = 0; j < added.length; j++) {
          var node = added[j]
          if (node.nodeType !== 1) continue
          var menu = (node.getAttribute && node.getAttribute('role') === 'menu') ? node : null
          if (!menu && node.querySelector) menu = node.querySelector('[role="menu"]')
          if (menu) injectMenuItem(menu)
        }
      }
    }

    // ---- Styles for the archive dialog ----
    function injectStyles() {
      if (document.getElementById('dsh-batch-archive-styles')) return
      var style = document.createElement('style')
      style.id = 'dsh-batch-archive-styles'
      style.textContent = [
        '.dsh-batch-archive-overlay { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45)); z-index: 2147483640; display: flex; align-items: center; justify-content: center; }',
        '.dsh-batch-archive-panel { background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #1f2328); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.1)); border-radius: 14px; box-shadow: var(--dsw-elevation-prominent, 0 10px 40px rgba(0,0,0,0.25)); width: min(480px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 48px)); display: flex; flex-direction: column; overflow: hidden; }',
        '.dsh-batch-archive-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7eb); }',
        '.dsh-batch-archive-title { font-size: 15px; font-weight: 600; line-height: 1.35; color: var(--dsw-alias-label-primary, inherit); }',
        '.dsh-batch-archive-close { background: transparent; border: none; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px; }',
        '.dsh-batch-archive-close:hover { color: var(--dsw-alias-label-primary, #111827); background: var(--dsw-alias-interactive-bg-hover, transparent); }',
        '.dsh-batch-archive-body { padding: 12px 18px; overflow-y: auto; flex: 1; }',
        '.dsh-batch-archive-empty { padding: 24px 0; text-align: center; color: var(--dsw-alias-label-secondary, #6b7280); }',
        '.dsh-batch-archive-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 13px; color: var(--dsw-alias-label-secondary, #6b7280); }',
        '.dsh-batch-archive-selectall { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--dsw-alias-label-secondary, #374151); }',
        '.dsh-batch-archive-selectall input[type="checkbox"] { accent-color: var(--dsw-alias-brand-primary, #2563eb); width: 14px; height: 14px; margin: 0; }',
        '.dsh-batch-archive-status { color: var(--dsw-alias-label-tertiary, #6b7280); }',
        '.dsh-batch-archive-list { display: flex; flex-direction: column; gap: 2px; }',
        '.dsh-batch-archive-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; user-select: none; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }',
        '.dsh-batch-archive-row:hover { background: var(--dsw-alias-interactive-bg-hover, #f3f4f6); }',
        '.dsh-batch-archive-row.dsh-batch-archive-running { opacity: 0.6; }',
        '.dsh-batch-archive-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.dsh-batch-archive-time { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px; flex-shrink: 0; }',
        '.dsh-batch-archive-footer { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 18px; border-top: 1px solid var(--dsw-alias-border-l2, #e5e7eb); }',
        '.dsh-batch-archive-primary, .dsh-batch-archive-secondary { padding: 7px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }',
        '.dsh-batch-archive-primary { background: var(--dsw-alias-button-primary-fill, #111827); color: var(--dsw-alias-label-primary-foreground, #fff); }',
        '.dsh-batch-archive-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #374151); }',
        '.dsh-batch-archive-primary:disabled { opacity: 0.5; cursor: not-allowed; }',
        '.dsh-batch-archive-secondary { background: transparent; color: var(--dsw-alias-label-secondary, #374151); border-color: var(--dsw-alias-border-l2, #d1d5db); }',
        '.dsh-batch-archive-secondary:hover { background: var(--dsw-alias-interactive-bg-hover, #f3f4f6); }',
        '',
        '@keyframes dsh-wst-toast-in { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }',
        '@keyframes dsh-wst-toast-fade { to { opacity: 0; visibility: hidden; } }',
        '.dsh-wst-toast { position: fixed; top: 40px; left: 50%; z-index: 1100; pointer-events: none; display: flex; align-items: center; padding: 12px 16px; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-toast-bg, #1f2328); color: var(--dsw-alias-toast-label, #fff); font-size: 14px; line-height: 22px; box-shadow: var(--dsw-shadow-lv3, 0 4px 20px rgba(0,0,0,0.25)); transform: translateX(-50%); width: max-content; max-width: min(640px, calc(100vw - 48px)); white-space: nowrap; animation: dsh-wst-toast-in 160ms ease-out, dsh-wst-toast-fade 1000ms ease 2000ms forwards; }',
        '@media (prefers-reduced-motion: reduce) { .dsh-wst-toast { animation: dsh-wst-toast-fade 1000ms ease 2000ms forwards; } }',
        '',
        // 消息附件卡片可点击样式：CSS-module 类名被 hash，用结构选择器定位
        // （附件行内带 title 的 span 就是文件卡片）。
        '[data-message-attachments] span[title] { cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease; }',
        '[data-message-attachments] span[title]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); border-color: var(--dsw-alias-border-l3, rgba(0,0,0,0.18)); }',
        '[data-message-attachments] span[title]:active { background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.08)); }',
        '',
        // Composer 附件卡片：可点击预览 + “粘贴原文至输入框”按钮。
        // 按钮是文件名/meta 下方的一行纯文字（带下划线），与 deepseek 网页端一致。
        '[data-composer-card] .dsh-paste-restore { display: block; align-self: flex-start; margin: 2px 0 0; padding: 0; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #374151); font-size: 12px; line-height: 16px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; text-align: left; }',
        '[data-composer-card] .dsh-paste-restore:hover { color: var(--dsw-alias-label-primary, inherit); }',
        '',
        // 用户超长消息气泡折叠：折叠 = 限高 + 底部渐隐，行尾放展开/收起按钮。
        '[data-chat-flow-kind="user"] .dsh-long-text-clamp { max-height: 120px; overflow: hidden; position: relative; }',
        '[data-chat-flow-kind="user"] .dsh-long-text-clamp::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 32px; background: linear-gradient(to top, var(--dsw-specific-bubble, #fff), transparent); pointer-events: none; }',
        '[data-chat-flow-kind="user"] .dsh-long-text-toggle { display: inline-flex; align-items: center; gap: 4px; margin: 2px 0 0; padding: 0; border: none; background: transparent; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px; line-height: 18px; cursor: pointer; }',
        '[data-chat-flow-kind="user"] .dsh-long-text-toggle:hover { color: var(--dsw-alias-label-primary, inherit); }'
      ].join('\n')
      document.head.appendChild(style)
    }

    // Handle Escape to close the dialog.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && archiveOverlay) {
        e.stopPropagation()
        closeArchiveDialog()
      }
    }, true)

    // ---- Plugin entry ----
    var ctx = null

    function apply(pluginCtx) {
      ctx = pluginCtx
      injectStyles()
      if (ctx.workspaces && ctx.workspaces.list) {
        try {
          var refreshWorkspaces = function () {
            try {
              var snap = ctx.workspaces.list.getSnapshot()
              workspaceItems = snap.items.map(function (w) {
                return { workspaceId: w.workspaceId, path: w.path, title: w.title, sessionIds: w.sessionIds || [] }
              })
              archivedSessionIds = snap.archivedSessionIds || []
            } catch (err) {
            }
          }
          refreshWorkspaces()
          ctx.workspaces.list.subscribe(refreshWorkspaces)
        } catch (err) {
        }
      } else {
      }

      // sessions/uiWorkspace 只在批量归档弹窗中使用；快照延迟到打开弹窗时读取，
      // 避免在 inactive context 中反复订阅、刷屏报错。

      // 功能一：从 user/message 事件抓取文件附件引用，供附件卡片点击打开。
      toolkitConfig()
      if (ctx.sessions && ctx.sessions.list) {
        try {
          var initSnap = ctx.sessions.list.getSnapshot()
          if (initSnap) {
            var initIds = initSnap.ids || []
            var initBy = initSnap.byId || {}
            for (var k = 0; k < initIds.length; k++) {
              var initRow = initBy[initIds[k]]
              if (initRow && !initRow.blank) { indexSessionHistory(initIds[k]); break }
            }
          }
        } catch (err) { /* 忽略 */ }
      }
      if (ctx.on) {
        ctx.on('session/event', function (session, event) {
          if (!event || event.type !== 'user/message') return
          var sessionId = (session && session.id) || null
          var content = event.data && event.data.content
          rememberMessageFileAttachments(sessionId, content)
        })
      }

      // 功能二：超长纯文本粘贴自动转文件附件（对齐网页版 2000 字符阈值）。
      // 上传状态变化时自动刷新恢复按钮（卡片就绪/上传完成都会触发）。
      try {
        var uploadConv = (typeof ctx.get === 'function') ? ctx.get('conversation') : null
        if (uploadConv && uploadConv.fileUploads && typeof uploadConv.fileUploads.subscribe === 'function') {
          uploadConv.fileUploads.subscribe(function () { ensureComposerRestoreButtons() })
        }
      } catch (err) { /* 可选服务，忽略 */ }

      // 用户超长消息气泡折叠：消息区任何 DOM 变化都防抖扫描一次。
      // React 渲染是渐进添加子节点，不能只看「新增 user 行」——只要消息区
      // 有变化（新消息、历史加载、文本流式写入）都全量重扫，collapseWatched
      // 按行 key 去重，重复扫描零成本。
      // 折叠扫描：合并后的统一 observer 检测到用户行特征时调用（防抖）。
      var bubbleScanTimer = null
      function scheduleBubbleScan() {
        if (bubbleScanTimer) return
        bubbleScanTimer = setTimeout(function () {
          bubbleScanTimer = null
          walkBubbleRows(document.body)
        }, 120)
      }
      // 初始扫描多轮覆盖：历史会话消息是异步加载的，单次 400ms 可能太早。
      // 400ms / 1.5s / 3s 各扫一次，配合 observer 覆盖后续任何变化。
      setTimeout(function () { walkBubbleRows(document.body) }, 400)
      setTimeout(function () { walkBubbleRows(document.body) }, 1500)
      setTimeout(function () { walkBubbleRows(document.body) }, 3000)

      document.addEventListener('paste', function (e) {
        if (!PASTE_TO_FILE) return
        var target = e.target
        if (!target || typeof target.closest !== 'function') return
        if (!target.closest('[data-composer-input]')) return
        if (!ctx || !ctx.sessions || !ctx.sessions.list) return
        var snap = null
        try { snap = ctx.sessions.list.getSnapshot() } catch (err) { return }
        // SessionListState 没有 current 字段：DOM 优先，其次取第一个非 blank 会话。
        var sessionId = null
        var srcNode = target
        while (srcNode && srcNode !== document.body) {
          var srcMarker = srcNode.getAttribute && (srcNode.getAttribute('data-conversation-session') || srcNode.getAttribute('data-session-id'))
          if (srcMarker) { sessionId = srcMarker; break }
          srcNode = srcNode.parentElement
        }
        if (!sessionId && snap) {
          var snapIds = snap.ids || []
          var snapBy = snap.byId || {}
          for (var si = 0; si < snapIds.length; si++) {
            if (snapBy[snapIds[si]] && !snapBy[snapIds[si]].blank) { sessionId = snapIds[si]; break }
          }
        }
        if (!sessionId) return
        var text = ''
        try {
          if (e.clipboardData && typeof e.clipboardData.getData === 'function') {
            text = e.clipboardData.getData('text/plain') || ''
          }
        } catch (err) { return }
        if (!text || text.length <= toolkitConfig().pasteToFileLimit) return
        // 通过公开契约拿本会话的输入面：conversation.input.for(scope)。
        var conversation = (ctx && typeof ctx.get === 'function') ? ctx.get('conversation') : null
        var input = conversation && conversation.input
        var actx = (ctx && ctx.sessions && ctx.sessions.scope) ? ctx.sessions.scope(sessionId) : null
        var shell = (actx && input && typeof input.for === 'function') ? input.for(actx) : null
        if (!shell || typeof shell.addAttachments !== 'function'
          || typeof conversation.createDrafts !== 'function') {
          // 服务暂不可用：不拦截，让原生粘贴继续（对用户透明）。
          return
        }
        // 只要纯文本超阈值：阻止原生粘贴，转成文件附件走官方草稿管线。
        e.preventDefault()
        e.stopPropagation()
        var file = new File([text], pasteFileName(text, LABELS.pasteTextFallback), { type: 'text/plain;charset=utf-8' })
        var drafts = null
        try { drafts = conversation.createDrafts(sessionId, [file]) } catch (err) {
          // 转文件失败：把原文塞回输入框，不丢用户粘贴内容。
          try { shell.setDraft(text) } catch (err2) {}
          return
        }
        if (!drafts || drafts.length === 0) {
          try { shell.setDraft(text) } catch (err2) {}
          return
        }
        var id = drafts[0].id
        var ok = false
        try { ok = shell.addAttachments([id]) } catch (err) { ok = false }
        if (ok) {
          // 记录「原文 → 附件」映射，供 composer 卡片上的“粘贴原文至输入框”恢复。
          // 存下 paste 时活的 shell 与 conversation 引用：恢复时直接用，
          // 避免会话 scope 已 inactive 后重新解析服务抛 “inactive context”。
          pasteOriginals.push({ sessionId: sessionId, draftId: id, name: file.name, text: text, shell: shell, conversation: conversation })
          // 上传完成前卡片可能还没就绪；等 fileUploads 报告 ready 时自动注入按钮。
          ensureComposerRestoreButtons()
          showToast(LABELS.pasteConverted + file.name)
        } else {
          // 附加失败：释放草稿并把原文塞回输入框，不丢用户粘贴内容。
          try { conversation.releaseDraftAttachment(id) } catch (err) {}
          try { shell.setDraft(text) } catch (err2) {}
        }
      }, true)

      // ---- Composer 附件区：卡片可点击预览 + 粘贴原文恢复 ----
      // 与消息区不同，composer 的附件还没发送，实体经 conversation.fileUploads
      // （公开 store）按 name 匹配已上传的 FileAttachmentRef。同 session 内
      // name 唯一（createDrafts 名来自内容），匹配可靠。
      document.addEventListener('click', function (e) {
        var target = e.target
        if (!target || typeof target.closest !== 'function') return
        // 附件卡片 = FileCard 本体：div[title=文件名]，位于 [data-composer-card]
        // 输入框容器内，且内含 remove 按钮。点击按钮（remove/retry/恢复）跳过。
        var cardEl = target.closest('[data-composer-card] div[title]')
        if (!cardEl) return
        if (target.closest('button')) return
        var name = cardEl.getAttribute('title')
        if (!name) return
        // 若这张卡片是“粘贴生成”的，先确保“粘贴原文至输入框”按钮已就位。
        ensurePasteRestoreButton(cardEl, name)
        var sessionId2 = null
        var n = cardEl
        while (n && n !== document.body) {
          var mk = n.getAttribute && (n.getAttribute('data-conversation-session') || n.getAttribute('data-session-id'))
          if (mk) { sessionId2 = mk; break }
          n = n.parentElement
        }
        if (!sessionId2) {
          try {
            var snap2 = ctx && ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null
            var ids2 = (snap2 && snap2.ids) || []
            var by2 = (snap2 && snap2.byId) || {}
            for (var j = 0; j < ids2.length; j++) {
              if (by2[ids2[j]] && !by2[ids2[j]].blank) { sessionId2 = ids2[j]; break }
            }
          } catch (err) { return }
        }
        if (!sessionId2) return
        // 统一预览逻辑走下方。
        openComposerAttachment(sessionId2, name)
      }, true)

      // 遍历当前 composer 区所有文件卡片，为“粘贴生成”的卡片自动注入恢复按钮。
      function ensureComposerRestoreButtons() {
        var cards = document.querySelectorAll('[data-composer-card] div[title]')
        for (var i = 0; i < cards.length; i++) {
          var name = cards[i].getAttribute('title')
          if (name) ensurePasteRestoreButton(cards[i], name)
        }
      }

      // 在 composer 附件卡片上插入“粘贴原文至输入框”按钮（仅对粘贴生成的附件）。
      // 插入点：卡片文字区（.body 即 flex column：文件名行 + meta 行）的末尾，
      // 使按钮成为文件名/meta 下方的独立一行，不挤占横向布局。
      function ensurePasteRestoreButton(cardEl, name) {
        if (!cardEl || cardEl.querySelector('.dsh-paste-restore')) return
        // 只对“粘贴生成”的卡片加按钮。
        var origin = null
        for (var i = 0; i < pasteOriginals.length; i++) {
          if (pasteOriginals[i].name === name) { origin = pasteOriginals[i]; break }
        }
        if (!origin) return
        // 定位文字区 body：FileCard 的 .body 是 flex column（.name 在上、.meta 在下），
        // 带 aria-label（"Pending file {name}"）的 span。按钮 append 到它末尾，
        // 成为文件名/meta 下方的独立一行，不挤占横向布局。
        var bodyEl = null
        var spans = cardEl.querySelectorAll('span')
        for (var i = 0; i < spans.length; i++) {
          var aria = spans[i].getAttribute && spans[i].getAttribute('aria-label')
          var nameIn = (spans[i].textContent || '').indexOf(name) !== -1
          if (aria || (nameIn && spans[i].querySelector && spans[i].querySelector('span'))) {
            bodyEl = spans[i]
            break
          }
        }
        if (!bodyEl) bodyEl = cardEl
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'dsh-paste-restore'
        btn.textContent = LABELS.pasteRestore
        ;btn.addEventListener('click', function (ev) {
          ev.preventDefault()
          ev.stopPropagation()
          restorePastedText(origin)
        })
        bodyEl.appendChild(btn)
      }

      // “粘贴原文至输入框”：把原文塞回输入框，并释放该附件草稿（文件消失）。
      function restorePastedText(origin) {
        if (!origin || !origin.sessionId) return
        // 全用 paste 时存下的引用：会话 scope 此刻可能已 inactive，现解析
        // 任何服务（ctx.get/input.for/scopeOf）都会抛 “inactive context”。
        var shell = (origin.shell && typeof origin.shell.setDraft === 'function') ? origin.shell : null
        var conv = (origin.conversation && typeof origin.conversation.releaseDraftAttachment === 'function') ? origin.conversation : null
        if (!shell || typeof shell.setDraft !== 'function') {
          window.alert(LABELS.pasteTooLongRestore)
          return
        }
        if (origin.text && origin.text.length > 0) {
          try { shell.setDraft(origin.text) } catch (err) {
            window.alert(LABELS.pasteTooLongRestore)
            return
          }
        }
        // 先从 composer 输入状态移除附件 id（卡片从 UI 消失的关键），
        // 再释放上传资源。顺序不能反：removeAttachment 只看 shell 的
        // attachmentIds，releaseDraftAttachment 只清 ConversationController
        // 的草稿注册表与上传状态，两者独立。
        if (origin.draftId && typeof shell.removeAttachment === 'function') {
          try { shell.removeAttachment(origin.draftId) } catch (err) { /* busy phase 拒绝 */ }
        }
        if (conv && origin.draftId) {
          try { conv.releaseDraftAttachment(origin.draftId) } catch (err) { /* 附件可能已发送 */ }
        }
        // 从记录里移除，放行 DOM 卡片移除。
        for (var i = 0; i < pasteOriginals.length; i++) {
          if (pasteOriginals[i] === origin) { pasteOriginals.splice(i, 1); break }
        }
        showToast(LABELS.pasteRestored)
      }

      // 用 fileUploads store 把 name 映射成 FileAttachmentRef，再走同一套 openResource
      function openComposerAttachment(sessionId, name) {
        var conv = (ctx && typeof ctx.get === 'function') ? ctx.get('conversation') : null
        if (!conv || !conv.fileUploads || typeof conv.fileUploads.getSnapshot !== 'function') {
          window.alert(LABELS.attachmentNotFound)
          return
        }
        var uploads = null
        try { uploads = conv.fileUploads.getSnapshot() } catch (err) { uploads = null }
        if (!uploads) { window.alert(LABELS.attachmentNotFound); return }
        // fileUploads: { draftId -> { status:'ready', receiptId, file: FileAttachmentRef } }
        var found = null
        var keys = Object.keys(uploads)
        for (var i = 0; i < keys.length; i++) {
          var u = uploads[keys[i]]
          if (u && u.status === 'ready' && u.file && u.file.name === name) { found = u.file; break }
        }
        if (!found) {
          // 兜底：可能在消息区已索引（发送后），或还未完成上传。
          var bucket0 = attachmentRefsBySession[sessionId]
          var ref0 = bucket0 ? bucket0[name] : null
          if (ref0) { openAttachmentByName(sessionId, name); return }
          window.alert(LABELS.attachmentNotFound)
          return
        }
        var objectPath = attachmentObjectPath(found)
        if (!objectPath) { window.alert(LABELS.attachmentOpenFailed + 'missing attachmentsRoot'); return }
        var address = 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' +
          objectPath.split('/').map(function (seg) { return encodeURIComponent(seg).replace(/%3A/gi, ':') }).join('/')
        var sidebarRight = (ctx && typeof ctx.get === 'function') ? ctx.get('sidebarRight') : null
        if (sidebarRight && typeof sidebarRight.openResource === 'function') {
          sidebarRight.openResource(address)
        } else {
          window.alert(LABELS.attachmentOpenFailed + 'sidebarRight unavailable')
        }
      }


      // 统一 DOM observer：一次遍历分流菜单注入 / composer 卡片 / 气泡折叠，
      // 替代原来 3 个各自挂 document.body 全量的 observer（性能收敛）。
      var domObserver = new MutationObserver(function (mutations) {
        // 菜单关闭（DOM 移除）= 该次菜单交互结束。清空 pendingWorkspace，
        // 但带 100ms 时间窗：只清「自己打开的那个」菜单。快速切换场景
        // （A 菜单开着 → 直接点 B 按钮）B 的 pending 是刚设的（setAt 新），
        // 不被 A 的关闭误清。
        for (var mi = 0; mi < mutations.length; mi++) {
          var removed = mutations[mi].removedNodes
          for (var ri = 0; ri < removed.length; ri++) {
            var rn = removed[ri]
            if (rn.nodeType === 1 && ((rn.getAttribute && rn.getAttribute('role') === 'menu') ||
              (rn.querySelector && rn.querySelector('[role="menu"]')))) {
              if (pendingWorkspace && (Date.now() - (pendingWorkspace.setAt || 0)) > 100) {
                pendingWorkspace = null
              }
            }
          }
        }
        var needMenu = false
        var needComposer = false
        var needBubble = false
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes
          for (var j = 0; j < added.length; j++) {
            var node = added[j]
            if (node.nodeType !== 1) continue
            if (!needMenu && ((node.getAttribute && node.getAttribute('role') === 'menu') ||
              (node.querySelector && node.querySelector('[role="menu"]')))) needMenu = true
            if (!needComposer && ((node.getAttribute && node.getAttribute('data-composer-card')) ||
              (node.querySelector && node.querySelector('[data-composer-card] div[title]')))) needComposer = true
            if (!needBubble && ((node.getAttribute && node.getAttribute('data-chat-flow-kind') === 'user') ||
              (node.querySelector && node.querySelector('[data-chat-flow-kind="user"]')))) needBubble = true
          }
        }
        if (needMenu) handleMenuMutations(mutations)
        if (needComposer) ensureComposerRestoreButtons()
        if (needBubble) scheduleBubbleScan()
      })
      domObserver.observe(document.body, { childList: true, subtree: true })
    }

    exports.apply = apply
    // 刻意不注入 sidebarRight/conversation：它们属于可选增强服务，缺失时本插件
    // 的既有功能（复制路径/批量归档）也必须照常工作。增强逻辑在 apply 内用
    // ctx.get() 运行时探测，拿不到就静默退化。
    exports.inject = ['workspaces', 'sessions', 'uiWorkspace']
    return module.exports
  }
})
