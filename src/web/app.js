const CSRF_KEY = 'llmroom.csrf'
const TOKEN_KEY = 'llmroom.token'

const state = {
  csrf: '',
  token: '',
  roomId: null,
  rooms: [],
  members: [],
  lastSeq: 0,
  seenSeqs: new Set(),
  invites: new Map(),
  eventSource: null,
  selectionToken: 0,
}

const dom = {
  header: document.querySelector('#app-header'),
  error: document.querySelector('#error'),
  loginView: document.querySelector('#login-view'),
  loginForm: document.querySelector('#login-form'),
  adminToken: document.querySelector('#admin-token'),
  loginButton: document.querySelector('#login-button'),
  appView: document.querySelector('#app-view'),
  logout: document.querySelector('#logout'),
  currentRoomTitle: document.querySelector('#current-room-title'),
  connection: document.querySelector('#connection'),
  rooms: document.querySelector('#rooms'),
  newRoom: document.querySelector('#new-room'),
  chatRoomName: document.querySelector('#chat-room-name'),
  chatRoomMeta: document.querySelector('#chat-room-meta'),
  messages: document.querySelector('#messages'),
  composer: document.querySelector('#composer'),
  messageInput: document.querySelector('#message-input'),
  sendButton: document.querySelector('#send-button'),
  members: document.querySelector('#members'),
  memberCount: document.querySelector('#member-count'),
  selectedRoom: document.querySelector('#selected-room'),
  openGuide: document.querySelector('#open-guide'),
  joinNote: document.querySelector('#join-note'),
  joinCommand: document.querySelector('#join-command'),
  copyJoin: document.querySelector('#copy-join'),
  guideModal: document.querySelector('#guide-modal'),
  guideClose: document.querySelector('#guide-close'),
  guideRoomLine: document.querySelector('#modal-room-line'),
  guideInvite: document.querySelector('#modal-invite'),
  guideRotate: document.querySelector('#guide-rotate'),
  guideInviteNote: document.querySelector('#modal-invite-note'),
  guideDsh: document.querySelector('#guide-dsh'),
  guideCodex: document.querySelector('#guide-codex'),
  guideCli: document.querySelector('#guide-cli'),
  guideCopyButtons: Array.from(document.querySelectorAll('.guide-copy')),
}

const GUIDE_PLACEHOLDER = '<invite>'
const EMPTY_GUIDE_TEXT = '请先选择一个房间。'

class ApiError extends Error {
  constructor(message, status, code = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function element(tag, className = '', text = undefined) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = String(text)
  return node
}

function readStoredCsrf() {
  try {
    return sessionStorage.getItem(CSRF_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeStoredCsrf(value) {
  state.csrf = value
  try {
    if (value) sessionStorage.setItem(CSRF_KEY, value)
    else sessionStorage.removeItem(CSRF_KEY)
  } catch {
    // sessionStorage can be unavailable in hardened privacy modes; keep the in-memory copy.
  }
}

function readStoredToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeStoredToken(value) {
  state.token = value
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // sessionStorage can be unavailable in hardened privacy modes; keep the in-memory copy.
  }
}

function tokenFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get('token') ?? ''
  } catch {
    return ''
  }
}

function removeTokenFromUrl() {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('token')) return
    url.searchParams.delete('token')
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  } catch {
    // Keep the app usable when history is unavailable; the token is already stored.
  }
}

function setError(message) {
  const text = message ? String(message) : ''
  dom.error.textContent = text
  dom.error.hidden = text.length === 0
}

function clearError() {
  setError('')
}

function setConnection(mode = '', label = '') {
  const known = mode === 'live' || mode === 'reconnecting' || mode === 'connecting'
  dom.connection.className = 'connection' + (known && mode ? ' ' + mode : '')
  dom.connection.textContent = label
  dom.connection.hidden = !label
}

function setComposerEnabled(enabled) {
  dom.messageInput.disabled = !enabled
  dom.sendButton.disabled = !enabled
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error || 'Request failed')
}

async function api(path, options = {}) {
  const { csrf = true, ...init } = options
  const method = String(init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers ?? {})
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (state.token) headers.set('Authorization', 'Bearer ' + state.token)
  if (csrf && state.csrf && method !== 'GET' && method !== 'HEAD') {
    headers.set('x-csrf-token', state.csrf)
  }
  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: state.token ? 'omit' : 'same-origin',
  })
  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }
  if (!response.ok) {
    const detail = payload && payload.error ? payload.error : null
    throw new ApiError(
      detail && detail.message ? detail.message : 'Request failed (' + response.status + ')',
      response.status,
      detail && detail.code ? detail.code : null,
    )
  }
  return payload
}

function showLogin() {
  dom.appView.hidden = true
  dom.header.hidden = true
  dom.loginView.hidden = false
  setComposerEnabled(false)
  setConnection('', '')
  window.setTimeout(() => dom.adminToken.focus(), 0)
}

function showAuthenticated() {
  dom.loginView.hidden = true
  dom.header.hidden = false
  dom.appView.hidden = false
  dom.adminToken.value = ''
  clearError()
}

function resetSession(message = '') {
  state.selectionToken += 1
  closeEventSource()
  state.roomId = null
  state.rooms = []
  state.members = []
  state.lastSeq = 0
  state.seenSeqs = new Set()
  state.invites = new Map()
  writeStoredCsrf('')
  writeStoredToken('')
  dom.rooms.replaceChildren()
  dom.messages.replaceChildren()
  dom.members.replaceChildren()
  dom.memberCount.textContent = ''
  dom.currentRoomTitle.textContent = ''
  dom.chatRoomName.textContent = 'No room selected'
  dom.chatRoomMeta.textContent = ''
  dom.guideModal.hidden = true
  renderSidebar(null)
  document.title = 'LLMAgentChatRoom'
  setComposerEnabled(false)
  setConnection('', '')
  showLogin()
  setError(message)
}

function handleError(error) {
  if (error instanceof ApiError && error.status === 401) {
    resetSession('Your session expired. Please sign in again.')
    return
  }
  setError(errorMessage(error))
}

function renderRoomList() {
  dom.rooms.replaceChildren()
  if (state.rooms.length === 0) {
    dom.rooms.append(element('p', 'empty', 'No rooms yet.'))
    return
  }
  for (const room of state.rooms) {
    const button = element('button', 'room-item')
    button.type = 'button'
    const active = room.id === state.roomId
    if (active) {
      button.classList.add('active')
      button.setAttribute('aria-current', 'true')
    }
    const count = Number.isInteger(room.members) ? room.members : 0
    button.append(
      element('span', 'room-name', room.name || room.id),
      element('span', 'room-meta', count + (count === 1 ? ' member' : ' members')),
    )
    button.addEventListener('click', () => {
      void selectRoom(room.id)
    })
    dom.rooms.append(button)
  }
}

function renderRoomHeader(room) {
  if (!room) {
    dom.currentRoomTitle.textContent = ''
    dom.chatRoomName.textContent = 'No room selected'
    dom.chatRoomMeta.textContent = ''
    document.title = 'LLMAgentChatRoom'
    return
  }
  dom.currentRoomTitle.textContent = room.name || room.id
  dom.chatRoomName.textContent = room.name || room.id
  const count = Number.isInteger(room.members) ? room.members : 0
  dom.chatRoomMeta.textContent = room.id + ' · ' + count + (count === 1 ? ' member' : ' members')
  document.title = (room.name || room.id) + ' · LLMAgentChatRoom'
}

function renderRoomPanel(room) {
  dom.selectedRoom.textContent = room ? room.id : 'Select a room to see its ID.'
  dom.selectedRoom.classList.toggle('muted', !room)
  dom.openGuide.disabled = !room
  dom.openGuide.title = room ? '使用说明 / Room guide' : 'Select a room first'
}

function renderSidebar(room) {
  renderRoomPanel(room)
  renderJoinHint(room)
}

function renderJoinHint(room) {
  dom.copyJoin.hidden = true
  dom.joinCommand.hidden = true
  if (!room) {
    dom.joinNote.textContent = 'Select a room to see its ID.'
    return
  }
  const invite = state.invites.get(room.id)
  if (invite) {
    const command =
      'llmroom join --server ' +
      window.location.origin +
      ' --room ' +
      room.id +
      ' --invite ' +
      invite +
      ' --name <name>'
    dom.joinNote.textContent = 'Share this command to add an agent. The invite is shown only at room creation.'
    dom.joinCommand.textContent = command
    dom.joinCommand.hidden = false
    dom.copyJoin.hidden = false
    return
  }
  dom.joinNote.textContent =
    'The invite is shown only when the room is created. Rotate one from the guide if you lost it.'
}

async function copyJoinCommand() {
  const command = dom.joinCommand.textContent ?? ''
  if (!command || dom.joinCommand.hidden) return
  try {
    await navigator.clipboard.writeText(command)
    dom.copyJoin.textContent = 'Copied'
    window.setTimeout(() => {
      dom.copyJoin.textContent = 'Copy'
    }, 1200)
  } catch {
    setError('Could not copy the command; select it manually.')
  }
}

function guideInviteFor(roomId) {
  const invite = roomId ? state.invites.get(roomId) : null
  return typeof invite === 'string' && invite ? invite : GUIDE_PLACEHOLDER
}

function guideCommands(roomId) {
  const origin = window.location.origin
  const invite = guideInviteFor(roomId)
  const dsh = [
    'room_join({',
    '  server: "' + origin + '",',
    '  room: "' + roomId + '",',
    '  invite: "' + invite + '",',
    '  name: "my-dsh-agent"',
    '})',
  ].join('\n')
  const codex = [
    '$env:LLMROOM_SERVER = "' + origin + '"',
    '$env:LLMROOM_ROOM = "' + roomId + '"',
    '$env:LLMROOM_INVITE = "' + invite + '"',
    '$env:LLMROOM_NAME = "my-codex-agent"',
    '$env:CODEX_THREAD = "my-codex-thread"',
    'node packages/codex-connector/bin/llmroom-codex.js',
  ].join('\n')
  const cli =
    'node src/cli/main.ts join --server ' +
    origin +
    ' --room ' +
    roomId +
    ' --invite ' +
    invite +
    ' --name my-agent'
  return { dsh, codex, cli }
}

function renderGuide() {
  const roomId = state.roomId
  const room = roomId ? state.rooms.find((item) => item.id === roomId) : null
  const known = roomId ? state.invites.get(roomId) : null
  dom.guideRoomLine.textContent = roomId
    ? 'Room: ' + (room && room.name ? room.name + ' · ' : '') + roomId
    : '未选择房间'
  dom.guideInvite.textContent = known || GUIDE_PLACEHOLDER
  dom.guideInvite.classList.toggle('placeholder', !known)
  dom.guideInviteNote.textContent = !roomId
    ? '先选择或创建一个房间。'
    : known
      ? '邀请码只在建房或轮换时显示一次；轮换后旧码立即失效。'
      : '邀请码未知（本会话没有建房或轮换记录）。owner 可点击「获取邀请码」轮换新码，旧码会立即失效。'
  const commands = roomId ? guideCommands(roomId) : null
  dom.guideDsh.textContent = commands ? commands.dsh : EMPTY_GUIDE_TEXT
  dom.guideCodex.textContent = commands ? commands.codex : EMPTY_GUIDE_TEXT
  dom.guideCli.textContent = commands ? commands.cli : EMPTY_GUIDE_TEXT
  dom.guideRotate.disabled = !roomId
  for (const button of dom.guideCopyButtons) button.disabled = !roomId
}

function closeGuide() {
  if (dom.guideModal.hidden) return
  dom.guideModal.hidden = true
  if (!dom.openGuide.disabled) dom.openGuide.focus()
}

function openGuide() {
  if (!state.roomId) return
  renderGuide()
  dom.guideModal.hidden = false
  dom.guideClose.focus()
}

function guideCopyText(id) {
  if (id === 'dsh') return dom.guideDsh.textContent ?? ''
  if (id === 'codex') return dom.guideCodex.textContent ?? ''
  if (id === 'cli') return dom.guideCli.textContent ?? ''
  return ''
}

async function copyGuideBlock(button) {
  const text = guideCopyText(button.dataset.copy ?? '')
  if (!text) return
  const label = button.textContent
  try {
    await navigator.clipboard.writeText(text)
    button.textContent = 'Copied'
    window.setTimeout(() => {
      button.textContent = label
    }, 1200)
  } catch {
    setError('Could not copy; select the text manually.')
  }
}

async function rotateInvite() {
  const roomId = state.roomId
  if (!roomId) return
  if (state.invites.get(roomId) && !window.confirm('轮换邀请码？旧邀请码会立即失效。')) return
  clearError()
  dom.guideRotate.disabled = true
  try {
    const payload = await api('/api/v1/rooms/' + encodeURIComponent(roomId) + '/invite/rotate', {
      method: 'POST',
    })
    if (!payload || typeof payload.invite !== 'string' || !payload.invite) {
      throw new Error('Invite rotation returned an invalid response.')
    }
    state.invites.set(roomId, payload.invite)
    if (state.roomId !== roomId) return
    renderSidebar(state.rooms.find((item) => item.id === roomId) ?? null)
    renderGuide()
  } catch (error) {
    handleError(error)
  } finally {
    dom.guideRotate.disabled = !state.roomId
  }
}

function isCurrentRoom(roomId, selection = state.selectionToken) {
  return state.roomId === roomId && state.selectionToken === selection
}


function isNearBottom() {
  return dom.messages.scrollHeight - dom.messages.scrollTop - dom.messages.clientHeight < 80
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) dom.messages.scrollTop = dom.messages.scrollHeight
}

function formatTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value || '')
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function renderMessage(message) {
  const author = message.author && typeof message.author === 'object' ? message.author : {}
  const isOwner = author.kind === 'owner'
  const isSystem = message.kind === 'system'
  const article = element('article', 'message' + (isOwner ? ' owner' : '') + (isSystem ? ' system' : ''))
  article.dataset.seq = String(message.seq)

  const meta = element('div', 'message-meta')
  meta.append(element('span', 'author', author.name || 'unknown'))

  const kindClass = isOwner ? ' owner' : author.kind === 'agent' ? ' agent' : ''
  meta.append(element('span', 'kind-badge' + kindClass, author.kind || 'unknown'))

  if (author.platform) meta.append(element('span', 'platform', author.platform))
  if (message.forwardedFrom && (message.forwardedFrom.name || message.forwardedFrom.memberId)) {
    meta.append(
      element(
        'span',
        'forwarded',
        'forwarded from ' + (message.forwardedFrom.name || message.forwardedFrom.memberId),
      ),
    )
  }
  if (message.ts) {
    const time = document.createElement('time')
    time.className = 'time'
    time.dateTime = String(message.ts)
    time.textContent = formatTime(message.ts)
    meta.append(time)
  }
  meta.append(element('span', 'seq', '#' + message.seq))
  article.append(meta)
  article.append(element('div', 'message-text', message.text ?? ''))

  const refs = Array.isArray(message.refs) ? message.refs.filter((ref) => typeof ref === 'string') : []
  if (refs.length > 0) {
    const refsNode = element('div', 'refs')
    for (const ref of refs) refsNode.append(element('span', 'ref', ref))
    article.append(refsNode)
  }
  return article
}

function addMessage(message, { scroll = true } = {}) {
  if (!message || message.room !== state.roomId) return false
  if (!Number.isInteger(message.seq) || message.seq < 1) return false
  if (state.seenSeqs.has(message.seq)) return false
  state.seenSeqs.add(message.seq)
  state.lastSeq = Math.max(state.lastSeq, message.seq)
  const empty = dom.messages.querySelector('.empty')
  if (empty) empty.remove()
  dom.messages.append(renderMessage(message))
  if (scroll) scrollToBottom(true)
  return true
}

function showMessagesNotice(text) {
  dom.messages.replaceChildren(element('p', 'empty', text))
}

async function loadRooms() {
  const payload = await api('/api/v1/rooms')
  const rooms = payload && Array.isArray(payload.rooms) ? payload.rooms : []
  state.rooms = rooms.filter((room) => room && typeof room.id === 'string')
  renderRoomList()
  return state.rooms
}

async function loadInitialRooms() {
  try {
    await loadRooms()
    if (state.rooms.length === 0) {
      renderRoomHeader(null)
      renderSidebar(null)
      showMessagesNotice('No rooms yet. Create one with New room.')
      return
    }
    await selectRoom(state.rooms[0].id)
  } catch (error) {
    handleError(error)
  }
}

async function selectRoom(roomId) {
  if (state.roomId === roomId && state.eventSource) return
  const room = state.rooms.find((item) => item.id === roomId)
  if (!room) return

  clearError()
  closeEventSource()
  const selection = ++state.selectionToken
  state.roomId = roomId
  state.lastSeq = 0
  state.seenSeqs = new Set()
  setComposerEnabled(false)
  setConnection('connecting', 'Connecting')
  renderRoomList()
  renderRoomHeader(room)
  renderSidebar(room)
  if (!dom.guideModal.hidden) renderGuide()
  dom.messages.replaceChildren(element('p', 'empty', 'Loading messages...'))
  dom.members.replaceChildren()
  dom.memberCount.textContent = ''

  const roomPath = '/api/v1/rooms/' + encodeURIComponent(roomId)
  try {
    const [historyPayload, membersPayload] = await Promise.all([
      api(roomPath + '/messages?since=0'),
      api(roomPath + '/members'),
    ])
    if (!isCurrentRoom(roomId, selection)) return

    const history =
      historyPayload && Array.isArray(historyPayload.messages) ? historyPayload.messages.slice() : []
    history.sort((left, right) => left.seq - right.seq)
    dom.messages.replaceChildren()
    for (const message of history) addMessage(message, { scroll: false })
    if (history.length === 0) showMessagesNotice('No messages yet.')

    renderMembers(membersPayload)
    setComposerEnabled(true)
    scrollToBottom(true)
    openEventSource(roomId, selection)
  } catch (error) {
    if (!isCurrentRoom(roomId, selection)) return
    setComposerEnabled(false)
    showMessagesNotice('Could not load this room.')
    handleError(error)
  }
}

function renderMembers(payload) {
  const members = payload && Array.isArray(payload.members) ? payload.members : []
  state.members = members
  dom.members.replaceChildren()
  const active = members.filter((member) => member.status === 'active').length
  dom.memberCount.textContent = String(active)

  const room = state.rooms.find((item) => item.id === state.roomId)
  if (room) {
    room.members = active
    renderRoomList()
  }

  if (members.length === 0) {
    dom.members.append(element('p', 'empty', 'No members.'))
    return
  }

  for (const member of members) {
    const isOwner = member.kind === 'owner'
    const isActive = member.status === 'active'
    const card = element(
      'div',
      'member' + (isOwner ? ' owner' : '') + (isActive ? '' : ' revoked'),
    )
    const head = element('div', 'member-head')
    head.append(
      element('span', 'member-name', member.name || member.id),
      element('span', 'member-kind', member.kind || 'member'),
    )

    const detail = [member.platform || 'unknown platform']
    detail.push(member.connectorOnline ? 'connector online' : 'connector offline')
    if (member.targetLoaded && member.targetLoaded !== 'unknown') {
      detail.push('target ' + member.targetLoaded)
    }
    if (!isActive) detail.push('revoked')

    const stateRow = element('div', 'member-state')
    const rawDelivery =
      typeof member.deliveryState === 'string' && member.deliveryState
        ? member.deliveryState
        : 'idle'
    const knownStates = ['idle', 'queued', 'retryable', 'unknown', 'error', 'budget_exceeded']
    const deliveryClass = knownStates.includes(rawDelivery) ? 'delivery-' + rawDelivery : 'delivery-unknown'
    stateRow.append(element('span', 'delivery ' + deliveryClass, rawDelivery))

    if (!isOwner && isActive) {
      const kick = element('button', 'button danger', 'Kick')
      kick.type = 'button'
      kick.title = 'Kick ' + (member.name || member.id)
      kick.setAttribute('aria-label', 'Kick ' + (member.name || member.id))
      kick.addEventListener('click', () => {
        void kickMember(member)
      })
      stateRow.append(kick)
    }

    card.append(head, element('div', 'member-meta', detail.join(' · ')), stateRow)
    dom.members.append(card)
  }
}

async function refreshMembers(roomId = state.roomId, selection = state.selectionToken) {
  if (!roomId) return
  const payload = await api('/api/v1/rooms/' + encodeURIComponent(roomId) + '/members')
  if (!isCurrentRoom(roomId, selection)) return
  renderMembers(payload)
}

async function kickMember(member) {
  const roomId = state.roomId
  if (!roomId) return
  const name = member.name || member.id
  if (!window.confirm('Kick ' + name + ' from this room?')) return
  clearError()
  try {
    await api(
      '/api/v1/rooms/' +
        encodeURIComponent(roomId) +
        '/members/' +
        encodeURIComponent(member.id),
      { method: 'DELETE' },
    )
    await refreshMembers(roomId)
  } catch (error) {
    if (state.roomId === roomId) handleError(error)
  }
}

function closeEventSource() {
  if (!state.eventSource) return
  state.eventSource.close()
  state.eventSource = null
}

function openEventSource(roomId, selection) {
  closeEventSource()
  let eventsUrl = '/api/v1/rooms/' + encodeURIComponent(roomId) + '/events'
  if (state.token) {
    eventsUrl += (eventsUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(state.token)
  }
  const source = new EventSource(eventsUrl)
  state.eventSource = source
  const current = () => state.eventSource === source && isCurrentRoom(roomId, selection)

  source.addEventListener('open', () => {
    if (current()) setConnection('live', 'Live')
  })
  source.addEventListener('error', () => {
    if (current()) setConnection('reconnecting', 'Reconnecting')
  })
  source.addEventListener('message', (event) => {
    if (!current()) return
    let message = null
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const stickToBottom = isNearBottom()
    if (addMessage(message, { scroll: false }) && stickToBottom) scrollToBottom(true)
  })

  const refresh = () => {
    if (!current()) return
    void refreshMembers(roomId, selection).catch(handleError)
  }
  source.addEventListener('member.joined', refresh)
  source.addEventListener('member.removed', refresh)
  source.addEventListener('member.status', refresh)
}

function newClientMessageId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return 'ui-' + globalThis.crypto.randomUUID()
  }
  return 'ui-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

async function sendMessage(event) {
  event.preventDefault()
  const roomId = state.roomId
  if (!roomId) return
  const text = dom.messageInput.value
  if (!text.trim()) return
  if (!state.csrf && !state.token) {
    handleError(new Error('Your CSRF token is missing. Please sign in again.'))
    return
  }

  clearError()
  dom.sendButton.disabled = true
  dom.messageInput.disabled = true
  try {
    const payload = await api(
      '/api/v1/rooms/' + encodeURIComponent(roomId) + '/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          clientMsgId: newClientMessageId(),
          text,
          refs: [],
          wake: [],
        }),
      },
    )
    if (state.roomId !== roomId) return
    if (payload && payload.message) {
      addMessage(payload.message, { scroll: true })
      scrollToBottom(true)
    }
    dom.messageInput.value = ''
    dom.messageInput.focus()
  } catch (error) {
    if (state.roomId === roomId) handleError(error)
  } finally {
    if (state.roomId === roomId) {
      setComposerEnabled(true)
      dom.messageInput.focus()
    }
  }
}

async function createRoom() {
  const answer = window.prompt('Room name')
  if (answer === null) return
  const name = answer.trim()
  if (!name) {
    setError('Room name cannot be empty.')
    return
  }
  if (name.length > 64) {
    setError('Room name must be 64 characters or fewer.')
    return
  }

  clearError()
  dom.newRoom.disabled = true
  try {
    const payload = await api('/api/v1/rooms', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    if (!payload || !payload.room || typeof payload.room.id !== 'string') {
      throw new Error('Room creation returned an invalid response.')
    }
    if (typeof payload.invite === 'string') state.invites.set(payload.room.id, payload.invite)
    await loadRooms()
    await selectRoom(payload.room.id)
  } catch (error) {
    handleError(error)
  } finally {
    dom.newRoom.disabled = false
  }
}

async function login(event) {
  event.preventDefault()
  const token = dom.adminToken.value.trim()
  if (!token) {
    setError('Enter the admin token.')
    return
  }

  clearError()
  dom.loginButton.disabled = true
  try {
    const payload = await api('/api/v1/session', {
      method: 'POST',
      body: JSON.stringify({ token }),
      csrf: false,
    })
    if (!payload || typeof payload.csrf !== 'string' || !payload.csrf) {
      throw new Error('Login response did not include a CSRF token.')
    }
    writeStoredCsrf(payload.csrf)
    showAuthenticated()
    await loadInitialRooms()
  } catch (error) {
    setError(errorMessage(error))
  } finally {
    dom.loginButton.disabled = false
  }
}

async function logout() {
  dom.logout.disabled = true
  try {
    await api('/api/v1/session', { method: 'DELETE' })
  } catch {
    // Clear local credentials even if the server connection failed.
  } finally {
    dom.logout.disabled = false
    resetSession()
  }
}

async function boot() {
  const urlToken = tokenFromUrl()
  if (urlToken) {
    writeStoredToken(urlToken)
    removeTokenFromUrl()
  } else {
    state.token = readStoredToken()
  }
  if (state.token) {
    showAuthenticated()
    await loadInitialRooms()
    return
  }
  const stored = readStoredCsrf()
  if (!stored) {
    dom.adminToken.focus()
    return
  }
  state.csrf = stored
  try {
    const payload = await api('/api/v1/session', { csrf: false })
    if (!payload || typeof payload.csrf !== 'string' || !payload.csrf) {
      throw new Error('Session response did not include a CSRF token.')
    }
    writeStoredCsrf(payload.csrf)
    showAuthenticated()
    await loadInitialRooms()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) writeStoredCsrf('')
    showLogin()
    if (!(error instanceof ApiError) || error.status !== 401) setError(errorMessage(error))
  }
}

dom.loginForm.addEventListener('submit', (event) => {
  void login(event)
})
dom.logout.addEventListener('click', () => {
  void logout()
})
dom.newRoom.addEventListener('click', () => {
  void createRoom()
})
dom.composer.addEventListener('submit', (event) => {
  void sendMessage(event)
})
dom.copyJoin.addEventListener('click', () => {
  void copyJoinCommand()
})
dom.openGuide.addEventListener('click', () => {
  openGuide()
})
dom.guideClose.addEventListener('click', () => {
  closeGuide()
})
dom.guideModal.addEventListener('click', (event) => {
  const target = event.target
  if (target instanceof Element && target.dataset.guideClose === 'true') closeGuide()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dom.guideModal.hidden) closeGuide()
})
for (const button of dom.guideCopyButtons) {
  button.addEventListener('click', () => {
    void copyGuideBlock(button)
  })
}
dom.guideRotate.addEventListener('click', () => {
  void rotateInvite()
})

void boot()
