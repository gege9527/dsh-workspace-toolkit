// Browser half of dsh-workspace-toolkit.
// Workspace utility toolkit: open workspace path in file explorer, batch archive
// sessions, and future file/session operations.
// Injects items into each workspace row's ellipsis menu using DOM observation.

window.__ModuleLoader__.load({
  id: 'dsh-workspace-toolkit',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var NS = 'dsh-workspace-toolkit'

    // ---- Lightweight locale (DSH locale switching is not reachable from an external plugin). ----
    function isZh() {
      var lang = (typeof navigator !== 'undefined' && navigator.language) || 'en'
      return lang.indexOf('zh') === 0
    }
    var LABELS = {
      openInExplorer: isZh() ? '在文件资源管理器中打开' : 'Open in File Explorer',
      pathNotFound: isZh() ? '未找到工作区路径，请先将鼠标悬停在该工作区上。' : 'Workspace path not found. Please hover over the workspace first.',
      openFailed: isZh() ? '打开失败：' : 'Failed to open: ',
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
      workspaceNotFound: isZh() ? '未找到该工作区，请重试。' : 'Workspace not found. Please try again.'
    }

    // ---- Workspace row / path tracking ----
    var lastMouseX = 0
    var lastMouseY = 0
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

    function looksLikePath(text) {
      return /^([/~]|[a-zA-Z]:\\)/.test(text.trim())
    }

    function extractPathFromHoverCard(card) {
      var ariaLabel = card.getAttribute('aria-label')
      if (ariaLabel) {
        var idx = ariaLabel.indexOf(': ')
        if (idx !== -1) {
          var realPath = ariaLabel.slice(idx + 2).trim()
          if (looksLikePath(realPath)) return realPath
        }
      }
      var pathEl = card.querySelector('[class*="hoverPath"]')
      if (pathEl) return (pathEl.textContent || '').trim()
      var divs = card.querySelectorAll('div')
      for (var i = 0; i < divs.length; i++) {
        var text = (divs[i].textContent || '').trim()
        if (looksLikePath(text)) return text
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

    // Pre-fetch the workspace path whenever a hover card appears.
    var hoverObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes
        for (var j = 0; j < added.length; j++) {
          var node = added[j]
          if (node.nodeType !== 1) continue
          var style = window.getComputedStyle(node)
          if (style.position !== 'fixed') continue
          var className = typeof node.className === 'string' ? node.className : ''
          var hasHoverPath = node.querySelector('[class*="hoverPath"]') !== null
          if (className.indexOf('card') === -1 && !hasHoverPath) continue
          var path = extractPathFromHoverCard(node)
          if (!path) continue
          var target = document.elementFromPoint(lastMouseX, lastMouseY)
          var row = target ? findWorkspaceRow(target) : null
          if (row) {
            row.setAttribute('data-dsh-open-workspace-path', path)
            var item = null
            for (var k = 0; k < workspaceItems.length; k++) {
              if (workspaceItems[k].path === path) { item = workspaceItems[k]; break }
            }
            if (item) row.setAttribute('data-dsh-open-workspace-id', item.workspaceId)
          }
        }
      }
    })

    document.addEventListener('mousemove', function (e) {
      lastMouseX = e.clientX
      lastMouseY = e.clientY
    }, true)

    document.addEventListener('pointerdown', function (e) {
      var target = e.target
      if (!(target instanceof Element)) return
      var btn = target.closest('button[aria-label]')
      if (!btn) return
      var label = btn.getAttribute('aria-label') || ''
      var isSessionMenu = label.indexOf('Session actions') !== -1 ||
        (label.indexOf('会话') !== -1 && label.indexOf('的操作') !== -1)
      if (isSessionMenu) {
        pendingWorkspace = null
        return
      }
      if (!isWorkspaceMenuButton(btn)) return
      var row = findWorkspaceRow(btn)
      if (!row) return
      var title = extractTitleFromAria(label)
      var item = title ? findWorkspaceItemByTitle(title) : null
      var path = (item && item.path)
        || row.getAttribute('data-dsh-open-workspace-path')
        || null
      var workspaceId = (item && item.workspaceId)
        || row.getAttribute('data-dsh-open-workspace-id')
        || null
      // 只在真正的单个工作区行菜单注入；跳过会话菜单和最顶层工作区菜单。
      if (!workspaceId) return
      pendingWorkspace = {
        workspaceId: workspaceId,
        path: path,
        title: title || (item && item.title) || '',
        expires: Date.now() + 10000
      }
    }, true)

    // ---- Open path via Typert RPC over HTTP ----
    function makeRpcId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2)
    }
    function callOpenWorkspacePath(path) {
      var token = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('token') : null
      var url = '/api/session/openWorkspacePath' + (token ? '?token=' + encodeURIComponent(token) : '')
      var rpcId = makeRpcId()
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: rpcId,
          method: 'session/openWorkspacePath',
          payload: { args: { request: { path } } }
        })
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
        return res.json()
      })
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
            console.error('[' + NS + '] batch archive error at ' + selectedIds[i] + ':', err)
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
    var EXPLORER_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><polyline points="2 12 12 12 16 8"></polyline></svg>'
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
      if (menu.querySelector('[data-dsh-open-workspace-item]') && menu.querySelector('[data-dsh-batch-archive-item]')) return
      var ref = menu.querySelector('[role="menuitem"]')
      if (!ref) return

      if (!menu.querySelector('[data-dsh-open-workspace-item]')) {
        var explorerItem = makeMenuItem(ref, LABELS.openInExplorer, EXPLORER_ICON_SVG, 'data-dsh-open-workspace-item', function () {
          console.log('[' + NS + '] open in explorer clicked, pendingWorkspace=', pendingWorkspace)
          if (!pendingWorkspace || !pendingWorkspace.path) {
            window.alert(LABELS.pathNotFound)
            return
          }
          console.log('[' + NS + '] calling openWorkspacePath with path:', pendingWorkspace.path)
          callOpenWorkspacePath(pendingWorkspace.path)
            .then(function (result) {
              console.log('[' + NS + '] openWorkspacePath result:', result)
              var ok = result.ok !== false || result.opened === true
              if (!ok) {
                console.error('[' + NS + '] openWorkspacePath failed:', result.error)
                window.alert(LABELS.openFailed + (result.error ? result.error.message : ''))
              }
            })
            .catch(function (err) {
              console.error('[' + NS + '] openWorkspacePath error:', err)
              window.alert(LABELS.openFailed + (err && err.message ? err.message : String(err)))
            })
        })
        if (ref.parentElement) ref.parentElement.insertBefore(explorerItem, ref)
        else menu.appendChild(explorerItem)
      }

      if (!menu.querySelector('[data-dsh-batch-archive-item]')) {
        var archiveItem = makeMenuItem(ref, LABELS.batchArchive, ARCHIVE_ICON_SVG, 'data-dsh-batch-archive-item', function () {
          openArchiveDialog()
        })
        if (ref.parentElement) {
          var sibling = menu.querySelector('[data-dsh-open-workspace-item]') || ref
          if (sibling.nextSibling) ref.parentElement.insertBefore(archiveItem, sibling.nextSibling)
          else ref.parentElement.appendChild(archiveItem)
        } else {
          menu.appendChild(archiveItem)
        }
      }
    }

    var menuObserver = new MutationObserver(function (mutations) {
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
    })

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
        '.dsh-batch-archive-secondary:hover { background: var(--dsw-alias-interactive-bg-hover, #f3f4f6); }'
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
              console.warn('[' + NS + '] failed to read workspaces snapshot:', err)
            }
          }
          refreshWorkspaces()
          ctx.workspaces.list.subscribe(refreshWorkspaces)
        } catch (err) {
          console.warn('[' + NS + '] workspaces service not usable:', err)
        }
      } else {
        console.warn('[' + NS + '] ctx.workspaces not available')
      }

      // sessions/uiWorkspace 只在批量归档弹窗中使用；快照延迟到打开弹窗时读取，
      // 避免在 inactive context 中反复订阅、刷屏报错。

      hoverObserver.observe(document.body, { childList: true, subtree: true })
      menuObserver.observe(document.body, { childList: true, subtree: true })
      console.log('[' + NS + '] initialized, workspaces:', workspaceItems.length, 'sessions:', sessionIds.length)
    }

    exports.apply = apply
    exports.inject = ['workspaces', 'sessions', 'uiWorkspace']
    return module.exports
  }
})
