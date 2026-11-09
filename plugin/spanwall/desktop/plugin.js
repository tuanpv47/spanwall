// SpanWall — a Kanban view over live Hermes sessions.
//
// Columns are states, cards are sessions:
//   Needs you   open server→client requests (approval · clarify · sudo · secret)
//   Running     a turn is in flight (tool activity + elapsed)
//   Idle        live session, nothing happening
//   Done (24h)  last turn finished in the past 24h
//   Failed      last turn ended in an error
//
// Every profile route (host.profileRoutes) is polled, so one board covers all Hermes profiles;
// each session's RPCs go back through the route that owns it.
//
// Disk plugin: plain ESM, no JSX, imports only @hermes/plugin-sdk / react.
// Install at $HERMES_HOME/desktop-plugins/spanwall/plugin.js.

import * as React from 'react'
// Namespace import: a named import missing from an older desktop build would fail the whole module.
import * as sdk from '@hermes/plugin-sdk'

const { host, useValue } = sdk
const { createElement: h, Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = React

const PLUGIN_ID = 'spanwall'
const ROUTE = '/spanwall'
const POLL_MS = 3000
const USAGE_EVERY_MS = 15000
const IDLE_REQUEST_POLL_EVERY = 5 // ticks: idle sessions rarely hold an open request
const ROUTES_EVERY_MS = 30000
const STORED_EVERY_MS = 30000
const STORED_LIST_LIMIT = 50 // per profile: enough to name the owner of every live session
const STORED_SHOWN = 8 // per profile: recent not-loaded sessions shown as cards
const VIEWER_DEFAULT_WIDTH = 960
const VIEWER_MIN_WIDTH = 560
const TRANSCRIPT_LIMIT = 300 // rows kept in the session viewer
const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVITY_LIMIT = 40
const STREAM_LIMIT = 4000
const RUNNING_GRACE_MS = 8000
const TOMBSTONE_MS = 120000 // upper bound: a deleted card stays hidden at most this long

const COLUMNS = [
  { key: 'needs', label: 'Needs you', hint: 'approval · clarify · sudo / secret' },
  { key: 'running', label: 'Running', hint: 'tool in flight + elapsed' },
  { key: 'idle', label: 'Idle', hint: 'open, nothing happening' },
  { key: 'done', label: 'Done (24h)', hint: 'turn finished' },
  { key: 'failed', label: 'Failed', hint: 'error' }
]

const RUNNING_STATUSES = new Set(['working', 'streaming', 'starting', 'resuming'])
// Window-owned bridges (preview.read, terminal.read, tour, theme.*) are answered by the
// desktop window itself — only questions meant for a human land in "Needs you".
const HUMAN_REQUEST = /^(approval|clarify|sudo|secret|vault\.|setup_beat)/

// ── helpers ───────────────────────────────────────────────────────────────────────────────

const toMs = ts => (typeof ts === 'number' && ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : 0)

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const hr = Math.floor(m / 60)
  return `${hr}h ${String(m % 60).padStart(2, '0')}m`
}

function fmtAgo(ts, now) {
  if (!ts) return ''
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}


const clip = (text, n) => {
  const s = typeof text === 'string' ? text : text == null ? '' : JSON.stringify(text)
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

const oneLine = text => clip(text, 400).replace(/\s+/g, ' ').trim()

const errorText = err => (err && (err.message || err.error?.message)) || String(err || 'Unknown error')

function profileHue(name) {
  if (typeof sdk.profileColor === 'function') {
    try {
      const c = sdk.profileColor(name)
      if (typeof c === 'string' && c) return c
    } catch {}
  }
  let hash = 0
  for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return `hsl(${Math.abs(hash) % 12 * 30} 62% 55%)`
}

function toolLabel(p) {
  const name = String(p.name || 'tool').replace(/^mcp__([^_]+)__/, '$1·')
  const detail = p.context || p.preview || p.args_text || ''
  return detail ? `${name} — ${oneLine(detail)}` : name
}

function requestSummary(req) {
  const p = req.params || {}
  switch (req.method) {
    case 'approval': return `Approve ${p.tool_name || 'command'}: ${oneLine(p.command || p.description || '')}`
    case 'clarify': return oneLine((p.questions || []).map(q => q.question).join(' · ')) || 'Agent has a question'
    case 'sudo': return `Sudo password for: ${oneLine(p.command || '')}`
    case 'secret': return oneLine(p.prompt || `Value for ${p.env_var}`)
    default: return `${req.method} — answer in Hermes`
  }
}

// ── store ─────────────────────────────────────────────────────────────────────────────────
//
// Sessions are keyed by a board-wide uid `${routeKey}|${runtimeId}`: runtime ids are only unique
// per backend process, and every profile may run its own.

function createBoard(ctx) {
  const state = {
    routes: [], // [{ key, route, profile, label, active, error }]
    hidden: new Set(readStored(ctx, 'hiddenProfiles', [])), // route keys the user stopped watching
    showStored: readStored(ctx, 'showStored', true), // recent not-loaded sessions as cards
    stored: new Map(), // route key → { at, rows: session.list rows, error }
    owner: new Map(), // stored session id → route key (from each profile's session.list)
    pinnedOwner: new Map(), // session id → route key for sessions this board created (before their DB row exists)
    models: new Map(), // route key → model.options summary for the new-task form
    compose: null, // { routeKey } while the new-task form is open
    draft: null, // the new-task form's fields when it was closed without creating (restored on reopen)
    viewing: null, // item id shown in the session viewer modal
    viewingKey: null, // its stored key (follows the session when a resume makes it live)
    transcript: new Map(), // item id → { messages, loading, error, stale, loadedAt } for the viewer and the card chat
    mounted: new Map(), // session key → { at, mountedAt, stored } for sessions the viewer lazy-resumed (sort keeps `at`)
    sessions: new Map(), // uid → session.active_list row + { _uid, _rawId, _routeKey, _profile }
    requests: new Map(), // uid → [{ id, method, params, receivedAt, via? }]
    turns: new Map(), // uid → turn tracker (event stream + status transitions)
    usage: new Map(), // uid → session.usage result
    seq: new Map(), // uid → events watermark for session.events.since
    rawIndex: new Map(), // runtime id → uid (gateway events carry only the runtime id)
    archive: readArchive(), // uid → finished turn summary (survives reloads, 24h)
    deleted: new Map(), // session id (stored or runtime) → { at, routeKey }: keeps an in-flight poll from bringing it back
    connected: true,
    lastError: null
  }

  let version = 0
  const listeners = new Set()
  const emit = () => {
    version++
    listeners.forEach(fn => fn())
  }
  let emitTimer = null
  const emitSoon = () => {
    if (emitTimer) return
    emitTimer = ctx.setTimeout(() => {
      emitTimer = null
      emit()
    }, 120)
  }

  function readArchive() {
    const raw = readStored(ctx, 'archive', {}) || {}
    const cutoff = Date.now() - DAY_MS
    const out = new Map()
    for (const [id, rec] of Object.entries(raw)) if (rec && rec.endedAt > cutoff && rec.routeKey) out.set(id, rec)
    return out
  }

  let saveTimer = null
  function saveArchive() {
    if (saveTimer) return
    saveTimer = ctx.setTimeout(() => {
      saveTimer = null
      const cutoff = Date.now() - DAY_MS
      for (const [id, rec] of state.archive) if (rec.endedAt <= cutoff) state.archive.delete(id)
      writeStored(ctx, 'archive', Object.fromEntries(state.archive))
    }, 500)
  }

  // ── routing ──

  const activeProfile = () => {
    try {
      return host.state.profile?.get?.() || 'default'
    } catch {
      return 'default'
    }
  }

  function rpc(route, method, params, foreground = false) {
    if (route && typeof host.requestProfile === 'function') {
      return host.requestProfile(route, method, params, undefined, { spawnPriority: foreground ? 'foreground' : 'background' })
    }
    return host.request(method, params)
  }

  const routeOf = key => state.routes.find(r => r.key === key)

  // An RPC addressed at one session, through the route that owns it.
  function sessionRpc(uid, method, params = {}, foreground = true) {
    const s = state.sessions.get(uid)
    const rec = s || state.archive.get(uid)
    const route = routeOf(rec?._routeKey || rec?.routeKey)
    return rpc(route?.route, method, { session_id: s?._rawId ?? uid.split('|').pop(), ...params }, foreground)
  }

  async function loadRoutes() {
    let raw = []
    try {
      if (typeof host.profileRoutes === 'function') raw = (await host.profileRoutes()) || []
    } catch {}
    const active = activeProfile()
    if (!Array.isArray(raw) || !raw.length) {
      return [{ key: 'active', route: null, profile: active, label: active, active: true }]
    }
    const counts = {}
    for (const r of raw) counts[r.profile] = (counts[r.profile] || 0) + 1
    return raw.map(r => {
      const profile = r.profile || r.targetProfile || 'default'
      const conn = String(r.connectionId ?? '')
      return {
        key: `${conn}:${profile}`,
        route: r,
        profile,
        // Same profile name on two sources (local + SSH): disambiguate with the connection.
        label: counts[r.profile] > 1 && conn ? `${profile} @${conn.slice(0, 8)}` : profile,
        active: profile === active,
        error: null
      }
    })
  }

  function setHidden(key, hide) {
    hide ? state.hidden.add(key) : state.hidden.delete(key)
    writeStored(ctx, 'hiddenProfiles', [...state.hidden])
    if (hide) {
      for (const uid of [...state.sessions.keys()]) if (state.sessions.get(uid)._routeKey === key) dropSession(uid)
    }
    emit()
    void refresh()
  }

  // Forget a session that left the live list. Its turn stays only if it is archived (Done / Failed 24h).
  function dropSession(uid) {
    state.sessions.delete(uid)
    state.requests.delete(uid)
    state.seq.delete(uid)
    state.usage.delete(uid)
    state.transcript.delete(uid)
    if (!state.archive.has(uid)) state.turns.delete(uid)
  }

  // ── turns ──

  function turn(uid) {
    let t = state.turns.get(uid)
    if (!t) {
      const rec = state.archive.get(uid)
      t = rec
        ? { status: rec.status, startedAt: rec.startedAt || 0, endedAt: rec.endedAt, tools: rec.tools || 0, activity: [], stream: '', text: rec.text || '', error: rec.error || null, statusText: '', dismissedAt: rec.dismissedAt || 0 }
        : { status: 'none', startedAt: 0, endedAt: 0, tools: 0, activity: [], stream: '', text: '', error: null, statusText: '', dismissedAt: 0 }
      state.turns.set(uid, t)
    }
    return t
  }

  function startTurn(uid, turnId, startedAt = Date.now()) {
    const t = turn(uid)
    if (t.status === 'running' && (!turnId || t.turnId === turnId)) return t
    Object.assign(t, { status: 'running', turnId: turnId || null, startedAt, endedAt: 0, tools: 0, stream: '', text: '', error: null, statusText: '' })
    t.activity = t.activity.filter(a => a.kind === 'user' && Date.now() - a.at < 5000) // keep the prompt we just sent
    return t
  }

  function pushActivity(t, entry) {
    t.activity.push({ at: Date.now(), ...entry })
    if (t.activity.length > ACTIVITY_LIMIT) t.activity.splice(0, t.activity.length - ACTIVITY_LIMIT)
  }

  function endTurn(uid, status, fields) {
    const t = turn(uid)
    Object.assign(t, { status, endedAt: Date.now(), ...fields })
    if (!t.startedAt) t.startedAt = t.endedAt
    const s = state.sessions.get(uid)
    const prev = state.archive.get(uid)
    if (status === 'complete' || status === 'error') {
      state.archive.set(uid, {
        id: uid,
        key: s?.session_key || prev?.key || uid,
        routeKey: s?._routeKey || prev?.routeKey,
        profile: s?._profile || prev?.profile || '',
        title: s?.title || prev?.title || 'Untitled session',
        model: s?.model || prev?.model || '',
        status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        tools: t.tools,
        text: clip(t.text || t.stream, 600),
        error: t.error
      })
      saveArchive()
    }
    markTranscriptStale(uid) // refetched by whoever shows it
    markTranscriptStale(uid)
  }

  function mergeUsage(uid, usage) {
    if (!usage || typeof usage !== 'object') return
    state.usage.set(uid, { ...(state.usage.get(uid) || {}), ...usage })
  }

  function setRequests(uid, list) {
    const prev = new Map((state.requests.get(uid) || []).map(r => [r.id, r]))
    const next = list
      .filter(r => r && r.id && HUMAN_REQUEST.test(r.method || ''))
      .map(r => ({ ...r, receivedAt: prev.get(r.id)?.receivedAt || Date.now() }))
    if (next.length) state.requests.set(uid, next)
    else state.requests.delete(uid)
  }

  function removeRequest(predicate) {
    for (const [uid, list] of state.requests) {
      const left = list.filter(r => !predicate(r, uid))
      if (left.length !== list.length) left.length ? state.requests.set(uid, left) : state.requests.delete(uid)
    }
  }

  // ── gateway events ──

  let pollSoonTimer = null
  function pollSoon(ms = 250) {
    if (pollSoonTimer) return
    pollSoonTimer = ctx.setTimeout(() => {
      pollSoonTimer = null
      void poll()
    }, ms)
  }

  function handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    const type = ev.type || ev.event || ev.method
    const p = ev.payload || ev.params || {}
    const sid = ev.session_id || p.session_id
    if (!type) return

    if (type === 'sessions.changed' || type === 'gateway.ready') return pollSoon()
    if (type === 'request.cancel') {
      removeRequest(r => r.id === p.id)
      return emitSoon()
    }
    if (!sid) return
    const uid = state.rawIndex.get(sid)
    if (!uid) {
      // A session we haven't listed yet. Only a turn start or session change is worth a full poll:
      // a hidden profile's tool/status chatter would otherwise poll every route constantly.
      if (type === 'message.start' || type.startsWith('session.')) pollSoon(600)
      return
    }

    switch (type) {
      case 'message.start': {
        startTurn(uid, p.turn_id)
        break
      }
      case 'message.delta': {
        const t = turn(uid)
        if (t.status !== 'running') startTurn(uid, p.turn_id)
        if (typeof p.text === 'string') t.stream = (t.stream + p.text).slice(-STREAM_LIMIT)
        break
      }
      case 'tool.start': {
        const t = turn(uid)
        if (t.status !== 'running') startTurn(uid)
        t.tools++
        pushActivity(t, { kind: 'tool', id: p.tool_id, label: toolLabel(p), done: false })
        break
      }
      case 'tool.progress': {
        const a = turn(uid).activity.find(x => x.id === p.tool_id)
        if (a) a.percent = p.percent
        break
      }
      case 'tool.complete': {
        const t = turn(uid)
        const a = t.activity.find(x => x.id === p.tool_id)
        if (a) Object.assign(a, { done: true, duration: p.duration_s, summary: p.summary ? oneLine(p.summary) : '' })
        else pushActivity(t, { kind: 'tool', id: p.tool_id, label: toolLabel(p), done: true, duration: p.duration_s })
        break
      }
      case 'status.update': {
        if (p.text) turn(uid).statusText = oneLine(p.text)
        break
      }
      case 'message.complete': {
        const t = turn(uid)
        const status = p.status === 'error' ? 'error' : p.status === 'interrupted' ? 'interrupted' : 'complete'
        if (p.usage) mergeUsage(uid, p.usage)
        endTurn(uid, status, {
          text: typeof p.text === 'string' && p.text ? p.text : t.stream,
          error: status === 'error' ? p.error || p.failure_reason || 'Turn failed' : null
        })
        pushActivity(turn(uid), { kind: status === 'error' ? 'error' : 'done', label: status === 'error' ? `Failed — ${oneLine(p.error || p.failure_reason || '')}` : status === 'interrupted' ? 'Interrupted' : 'Turn complete', done: true })
        removeRequest((_, u) => u === uid)
        break
      }
      case 'error': {
        endTurn(uid, 'error', { error: p.message || 'Session error' })
        pushActivity(turn(uid), { kind: 'error', label: oneLine(p.message || 'Session error'), done: true })
        break
      }
      case 'session.usage': {
        // The real view is `p.usage`; the top-level counters are deprecated raw stats.
        if (p.usage) mergeUsage(uid, p.usage)
        break
      }
      case 'session.title': {
        const s = state.sessions.get(uid)
        if (s && p.title) s.title = p.title
        break
      }
      case 'approval.cancelled': {
        // request_ids omits entries without an id: an empty list still means "approvals", never clarify/secret.
        const ids = new Set(p.request_ids || [])
        removeRequest((r, u) => u === uid && r.method === 'approval' && (ids.has(r.params?.request_id) || ids.size === 0))
        break
      }
      default:
        return
    }
    emitSoon()
  }

  // ── polling ──

  let polling = false
  let tick = 0
  let lastUsageAt = 0

  async function syncRequests(uid) {
    try {
      const params = state.seq.has(uid) ? { last_seen: state.seq.get(uid) } : {}
      const r = await sessionRpc(uid, 'session.events.since', params, false)
      if (typeof r?.latest_seq === 'number') state.seq.set(uid, r.latest_seq)
      setRequests(uid, r?.open_requests || [])
    } catch {
      // Older gateways / remote routes without the replay door: approvals at least.
      try {
        const r = await sessionRpc(uid, 'approval.pending', {}, false)
        const list = (r?.approvals || []).map(a => ({ id: `approval:${a.request_id || a.id}`, method: 'approval', params: a, via: 'approval.respond' }))
        setRequests(uid, list)
      } catch {}
    }
  }

  async function fetchUsage(uid) {
    try {
      mergeUsage(uid, await sessionRpc(uid, 'session.usage', {}, false))
    } catch {}
  }

  // Profiles whose events never reach this window still move between columns: infer turn
  // start / end from the polled status when no event already did.
  function reconcileStatus(uid, prev, row) {
    const wasRunning = prev && RUNNING_STATUSES.has(prev.status)
    const nowRunning = RUNNING_STATUSES.has(row.status)
    const t = state.turns.get(uid)
    if (nowRunning && t?.status !== 'running') {
      startTurn(uid, null, prev ? Date.now() : toMs(row.last_active) || Date.now())
    } else if (wasRunning && row.status === 'idle' && t?.status === 'running') {
      endTurn(uid, 'complete', { text: t.stream || row.preview || '' })
    }
  }

  async function pollRoute(r) {
    const res = await rpc(r.route, 'session.active_list', {}, false)
    return (res?.sessions || []).filter(row => row && row.id)
  }

  // Each profile's stored sessions (session.list is profile-scoped on every topology). They name the
  // owner of a live row — a backend shared by several profiles returns the SAME active_list to every
  // route, with no profile on the rows — and fill the board for profiles with nothing loaded.
  let storedAt = 0
  let storedStartedAt = 0 // when the last completed refresh started
  let storedRefreshing = null
  function refreshStored(watched, force = false) {
    if (storedRefreshing) return storedRefreshing
    if (!force && Date.now() - storedAt < STORED_EVERY_MS) return Promise.resolve()
    const startedAt = Date.now()
    storedRefreshing = (async () => {
      const results = await Promise.allSettled(watched.map(r => rpc(r.route, 'session.list', { limit: STORED_LIST_LIMIT, profile: backendProfile(r) }, false)))
      const owner = new Map()
      results.forEach((res, i) => {
        const r = watched[i]
        if (res.status !== 'fulfilled') {
          state.stored.set(r.key, { at: Date.now(), rows: state.stored.get(r.key)?.rows || [], error: errorText(res.reason) })
          return
        }
        const rows = (res.value?.sessions || []).filter(s => s && s.id)
        state.stored.set(r.key, { at: Date.now(), rows, error: null })
        for (const s of rows) for (const id of [s.id, s.resolved_id, s._lineage_root_id]) if (id && !owner.has(id)) owner.set(id, r.key)
      })
      state.owner = owner
      storedAt = Date.now()
      storedStartedAt = startedAt
    })().finally(() => {
      storedRefreshing = null
    })
    return storedRefreshing
  }

  let routesAt = 0
  let lastOwnerRefresh = 0

  async function poll() {
    if (polling) return
    polling = true
    const startedAt = Date.now()
    try {
      if (!state.routes.length || Date.now() - routesAt > ROUTES_EVERY_MS) {
        const next = await loadRoutes()
        for (const r of next) r.error = routeOf(r.key)?.error ?? null
        state.routes = next
        routesAt = Date.now()
      }
      const watched = state.routes.filter(r => !state.hidden.has(r.key))
      const [results] = await Promise.all([Promise.allSettled(watched.map(pollRoute)), refreshStored(watched)])

      // Gather every route's view of each live session, then hand each one to a single owner.
      const candidates = new Map() // session key → [{ route, row }]
      const okRoutes = new Set()
      results.forEach((res, i) => {
        const r = watched[i]
        if (res.status !== 'fulfilled') {
          r.error = errorText(res.reason)
          return
        }
        r.error = null
        okRoutes.add(r.key)
        for (const row of res.value) {
          const key = row.session_key || row.id
          if (!candidates.has(key)) candidates.set(key, [])
          candidates.get(key).push({ route: r, row })
        }
      })

      let unknownOwner = false
      const seen = new Set()
      for (const [key, list] of candidates) {
        const stored = state.owner.get(key) || state.pinnedOwner.get(key)
        const pick = list.find(c => c.route.key === stored)
          || (list.length === 1 ? list[0] : null)
          || list.find(c => c.route.active)
          || list[0]
        if (!stored && list.length > 1) unknownOwner = true // shared backend, row not persisted yet
        const { route: r, row } = pick
        const uid = `${r.key}|${row.id}`
        const prev = state.sessions.get(uid)
        seen.add(uid)
        state.sessions.set(uid, { ...row, _uid: uid, _rawId: row.id, _routeKey: r.key, _profile: r.label })
        reconcileStatus(uid, prev, row)
      }
      if (unknownOwner && Date.now() - lastOwnerRefresh > 10000) {
        lastOwnerRefresh = Date.now()
        void refreshStored(watched, true).then(emitSoon)
      }
      // Forget sessions that closed — but keep the last rows of a route that just failed (reconnecting).
      for (const [uid, s] of state.sessions) if (!seen.has(uid) && okRoutes.has(s._routeKey)) dropSession(uid)
      for (const uid of [...state.sessions.keys()]) if (!state.routes.some(r => r.key === state.sessions.get(uid)._routeKey)) dropSession(uid)

      state.rawIndex = new Map()
      for (const [uid, s] of state.sessions) if (!state.rawIndex.has(s._rawId)) state.rawIndex.set(s._rawId, uid)

      tick++
      const rows = [...state.sessions.values()].filter(s => okRoutes.has(s._routeKey))
      const due = rows.filter(s => s.status !== 'idle' || state.requests.has(s._uid) || !state.seq.has(s._uid) || tick % IDLE_REQUEST_POLL_EVERY === 0)
      const usageDue = Date.now() - lastUsageAt > USAGE_EVERY_MS
      if (usageDue) lastUsageAt = Date.now()
      await Promise.all([...due.map(s => syncRequests(s._uid)), ...(usageDue ? rows.map(s => fetchUsage(s._uid)) : [])])

      if (state.deleted.size) pruneDeleted(startedAt, okRoutes)
      state.connected = okRoutes.size > 0 || watched.length === 0
      state.lastError = state.connected ? null : watched[0]?.error || 'gateway unavailable'
    } catch (err) {
      state.connected = false
      state.lastError = errorText(err)
    } finally {
      polling = false
      emit()
    }
  }

  // ── actions ──

  async function answer(uid, req, result) {
    try {
      let r
      if (req.via === 'approval.respond') {
        r = await sessionRpc(uid, 'approval.respond', { choice: result.choice, all: Boolean(result.all), request_id: req.params?.request_id })
      } else {
        const route = routeOf(state.sessions.get(uid)?._routeKey)
        r = await rpc(route?.route, 'request.answer', { id: req.id, result }, true)
      }
      removeRequest(x => x.id === req.id)
      emit()
      if (r?.status === 'expired') host.notify({ kind: 'warning', message: 'The request expired or was answered elsewhere.' })
    } catch (err) {
      host.notifyError(err, 'Could not send the answer')
    } finally {
      pollSoon(400)
    }
  }

  async function send(uid, text) {
    const body = text.trim()
    if (!body) return false
    const running = isRunning(uid)
    try {
      await sessionRpc(uid, running ? 'session.steer' : 'prompt.submit', { text: body })
      const t = running ? turn(uid) : startTurn(uid)
      pushActivity(t, { kind: 'user', label: running ? `Steer: ${oneLine(body)}` : `You: ${oneLine(body)}`, done: true })
      markTranscriptStale(uid)
      emit()
      pollSoon(600)
      return true
    } catch (err) {
      host.notifyError(err, 'Could not send the message')
      return false
    }
  }

  async function interrupt(uid) {
    try {
      await sessionRpc(uid, 'session.interrupt')
    } catch (err) {
      host.notifyError(err, 'Could not stop the session')
    } finally {
      pollSoon(400)
    }
  }

  function markTranscriptStale(uid) {
    const t = state.transcript.get(uid)
    if (t) t.stale = true
  }

  const textOf = v => {
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.map(p => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n')
    if (v == null) return ''
    return JSON.stringify(v, null, 2)
  }

  // The display transcript (without tool rows) for the viewer. A live session reads through
  // its owner route; a closed / stored one is tried by its stored id and may not be readable.
  async function loadTranscript(item) {
    const cur = state.transcript.get(item.id)
    if (cur?.loading) return
    state.transcript.set(item.id, { messages: [], ...(cur || {}), loading: true, stale: false })
    emitSoon()
    try {
      // session.history only reads sessions loaded in a backend (by runtime id). A stored or closed
      // session — or a live id the backend has since released — is mounted read-only with a lazy
      // resume, exactly what "open in Hermes" does; the first prompt upgrades it to a full session.
      let r = null
      if (item.live) {
        try {
          r = await sessionRpc(item.id, 'session.history', {}, false)
        } catch (err) {
          if (!/not found|unknown session|4001/i.test(`${errorText(err)} ${err?.code ?? ''}`)) throw err
        }
      }
      if (!r) {
        const route = routeOf(item.routeKey)
        // Resume stamps last_active = now; remember the real time so just viewing doesn't move the card.
        if (!state.mounted.has(item.key)) state.mounted.set(item.key, { at: item.lastActive || 0, mountedAt: Date.now(), stored: Boolean(item.stored) })
        const res = await rpc(route?.route, 'session.resume', { session_id: item.key, profile: backendProfile(route), lazy: true, inline_images: false }, true)
        r = res
        if (res?.session_id) {
          // The resumed session is live now: keep its owner and show its transcript under the live id too.
          state.pinnedOwner.set(item.key, item.routeKey)
          if (res.stored_session_id) state.pinnedOwner.set(res.stored_session_id, item.routeKey)
          pollSoon(200)
        }
      }
      const messages = (r?.messages || [])
        .filter(m => m && m.display_kind !== 'hidden')
        .map(m => ({
          role: m.role,
          kind: m.display_kind || '',
          text: textOf(m.text != null ? m.text : m.content),
          name: m.name || '',
          context: typeof m.context === 'string' ? m.context : '',
          at: toMs(m.timestamp),
          id: m.row_id ?? null
        }))
        .filter(m => m.role !== 'tool' && m.text.trim()) // tool calls: open the session in Hermes
        .slice(-TRANSCRIPT_LIMIT)
      state.transcript.set(item.id, { messages, loading: false, error: null, stale: false, loadedAt: Date.now() })
      if (!item.live && r?.session_id && item.routeKey) {
        state.transcript.set(`${item.routeKey}|${r.session_id}`, { messages, loading: false, error: null, stale: false, loadedAt: Date.now() })
      }
    } catch (err) {
      state.transcript.set(item.id, { ...(state.transcript.get(item.id) || { messages: [] }), loading: false, error: errorText(err), stale: false, loadedAt: Date.now() })
    }
    emit()
  }

  // The viewer keeps the stored key too: after a lazy resume the same session reappears as a live
  // card under a new id, and the modal follows it there.
  function openViewer(item) {
    state.viewing = item.id
    state.viewingKey = item.key
    state.compose = null
    emit()
  }

  function closeViewer() {
    state.viewing = null
    state.viewingKey = null
    emit()
  }

  // Delete a session for good (its stored row + transcripts). The backend refuses a session that is
  // live in it, so a live one is stopped (releasing any approval / clarify wait) and closed first —
  // the order Hermes' own sidebar uses. Throws; the caller shows the error.
  // Resolves to 'deleted', 'already' (Hermes no longer lists it) or 'local' (it never had a stored
  // row: only the card goes).
  async function remove(item) {
    const route = routeOf(item.routeKey)
    if (!route) throw new Error('The profile that owns this session is not connected')
    const gone = err => /not found|unknown session|4001|4007/i.test(`${errorText(err)} ${err?.code ?? ''}`)
    // The stored id is the only thing session.delete knows. A live session has one once it wrote a
    // row; a closed card's archive record falls back to its uid when it never had one.
    const storedId = item.stored ? item.key
      : item.live ? state.sessions.get(item.id)?.session_key || (state.owner.has(item.rawId) ? item.rawId : null)
      : item.key && item.key !== item.id ? item.key : null
    if (item.live) {
      if (item.column === 'running' || item.requests.length) {
        await sessionRpc(item.id, 'session.interrupt').catch(err => {
          if (!gone(err)) throw err
        })
      }
      await sessionRpc(item.id, 'session.close').catch(() => {})
    }
    const target = storedId || (item.live ? item.rawId : null)
    let outcome = target ? 'deleted' : 'local'
    if (target) {
      try {
        await rpc(route.route, 'session.delete', { session_id: target, profile: backendProfile(route) }, true)
      } catch (err) {
        if (!gone(err)) throw err
        // A live session that never wrote a row has nothing to delete. A known stored id that comes
        // back "not found" is only taken as deleted once the session lists agree.
        outcome = storedId ? await confirmGone(storedId, route) : 'local'
      }
    }
    forget(item)
    return outcome
  }

  async function confirmGone(id, route) {
    const watched = state.routes.filter(r => !state.hidden.has(r.key))
    await refreshStored(watched) // let a list already in flight (from before the delete) finish
    await refreshStored(watched, true)
    const owner = state.owner.get(id)
    if (owner) {
      const where = owner === route.key ? '' : ` (it is listed under ${routeOf(owner)?.label || owner})`
      throw new Error(`Hermes could not find it on ${route.label}, but it is still stored${where}. Nothing was deleted.`)
    }
    if (state.stored.get(route.key)?.error) {
      throw new Error(`Hermes could not find it on ${route.label} and the session list could not be checked. It may not have been deleted.`)
    }
    return 'already'
  }

  // Tombstones keep an in-flight poll from bringing a deleted card back. A runtime id is only unique
  // within its backend, so it is scoped to the route; a stored id is not.
  function tombstoned(id, routeKey, now) {
    const d = id && state.deleted.get(id)
    return Boolean(d) && now - d.at < TOMBSTONE_MS && (!d.routeKey || d.routeKey === routeKey)
  }

  // A poll that started after the delete no longer lists the session, and a session.list that
  // started after it no longer has the row: past that point the tombstone only hides id reuse.
  function pruneDeleted(pollStartedAt, okRoutes) {
    const now = Date.now()
    for (const [id, d] of state.deleted) {
      const settled = d.routeKey ? d.at < pollStartedAt && okRoutes.has(d.routeKey) : d.at < storedStartedAt
      if (settled || now - d.at >= TOMBSTONE_MS) state.deleted.delete(id)
    }
  }

  function forget(item) {
    const at = Date.now()
    if (item.rawId) state.deleted.set(item.rawId, { at, routeKey: item.stored ? null : item.routeKey })
    if (item.key && item.key !== item.rawId && item.key !== item.id) state.deleted.set(item.key, { at, routeKey: null })
    for (const [uid, s] of state.sessions) if (uid === item.id || s.session_key === item.key) dropSession(uid)
    for (const [uid, rec] of state.archive) {
      if (uid !== item.id && rec.key !== item.key) continue
      state.archive.delete(uid)
      state.turns.delete(uid)
    }
    saveArchive()
    for (const st of state.stored.values()) {
      if (st?.rows) st.rows = st.rows.filter(r => r.id !== item.key && r.id !== item.rawId && r.resolved_id !== item.key)
    }
    state.transcript.delete(item.id)
    state.mounted.delete(item.key)
    if (state.viewing === item.id || state.viewingKey === item.key) closeViewer()
    emit()
    pollSoon(400)
  }

  function dismiss(uid) {
    const t = turn(uid)
    t.dismissedAt = Date.now()
    const rec = state.archive.get(uid)
    if (rec) {
      if (state.sessions.has(uid)) rec.dismissedAt = t.dismissedAt
      else state.archive.delete(uid)
      saveArchive()
    }
    emit()
  }

  async function open(item) {
    // Leaving for the Hermes chat: don't leave the viewer up for when the board is shown again.
    if (state.viewing) closeViewer()
    try {
      await host.openSession(item.key || item.rawId, item.profile && !item.activeProfile ? { profile: item.profile } : undefined)
    } catch (err) {
      host.notifyError(err, 'Could not open the session')
    }
  }

  function isRunning(uid, busyBySession) {
    const s = state.sessions.get(uid)
    const route = routeOf(s?._routeKey)
    // busyBySession is keyed by runtime id of the window's own gateway — only meaningful for the active profile.
    if (route?.active && s && busyBySession?.[s._rawId]) return true
    if (s && RUNNING_STATUSES.has(s.status)) return true
    // The event stream leads the 3s poll: trust a fresh turn even while the last poll still says idle,
    // but let a stale one (missed message.complete) fall back to the gateway's status.
    const t = state.turns.get(uid)
    return t?.status === 'running' && (s?.status !== 'idle' || Date.now() - t.startedAt < RUNNING_GRACE_MS)
  }

  // ── derivation ──

  function items(busyBySession) {
    const out = []
    const cutoff = Date.now() - DAY_MS
    const classify = (uid, live) => {
      const t = state.turns.get(uid) || (state.archive.has(uid) ? turn(uid) : null)
      if (state.requests.get(uid)?.length) return 'needs'
      if (live && isRunning(uid, busyBySession)) return 'running'
      if (t && t.dismissedAt < t.endedAt) {
        if (t.status === 'error') return 'failed'
        if (t.status === 'complete' && t.endedAt > cutoff) return 'done'
      }
      return live ? 'idle' : null
    }

    for (const [uid, s] of state.sessions) {
      const route = routeOf(s._routeKey)
      // Mounted only by the viewer and untouched since: keep its pre-resume time and place.
      const key = s.session_key || s._rawId
      const mount = state.mounted.get(key)
      const t = state.turns.get(uid)
      const quiet = Boolean(mount) && toMs(s.last_active) <= mount.mountedAt + 5000
        && !((t?.startedAt || 0) > mount.mountedAt) && !(state.requests.get(uid) || []).length
      if (mount && !quiet) state.mounted.delete(key)
      out.push({
        id: uid,
        rawId: s._rawId,
        key,
        live: true,
        quietMount: quiet && mount.stored,
        profile: route?.profile || s._profile,
        profileLabel: s._profile,
        routeKey: s._routeKey,
        activeProfile: Boolean(route?.active),
        title: s.title || 'Untitled session',
        preview: s.preview || '',
        model: s.model || '',
        source: s.source || '',
        messageCount: s.message_count || 0,
        lastActive: quiet ? mount.at : toMs(s.last_active),
        startedAt: toMs(s.started_at),
        sessionStatus: s.status,
        column: classify(uid, true),
        turn: state.turns.get(uid) || null,
        requests: state.requests.get(uid) || [],
        usage: state.usage.get(uid) || null
      })
    }
    // Sessions that closed after finishing: still show for 24h in Done / Failed.
    const liveKeys = new Set(out.map(i => i.key))
    for (const [uid, rec] of state.archive) {
      // Same session under an older uid (its owner route changed): the live card already shows it.
      if (state.sessions.has(uid) || liveKeys.has(rec.key)) continue
      const route = routeOf(rec.routeKey) || state.routes.find(r => r.label === rec.profile || r.profile === rec.profile)
      const routeKey = route?.key || rec.routeKey
      if (state.hidden.has(routeKey)) continue
      const column = classify(uid, false)
      if (!column) continue
      out.push({
        id: uid,
        rawId: uid.split('|').pop(),
        key: rec.key,
        live: false,
        profile: route?.profile || rec.profile,
        profileLabel: rec.profile,
        routeKey,
        activeProfile: Boolean(route?.active),
        title: rec.title,
        preview: rec.text,
        model: rec.model,
        messageCount: 0,
        lastActive: rec.endedAt,
        startedAt: rec.startedAt,
        sessionStatus: 'closed',
        column,
        turn: turn(uid),
        requests: [],
        usage: null
      })
    }
    // Recent sessions that aren't loaded in any backend: every profile shows up, not only the open one.
    if (state.showStored) {
      const shownKeys = new Set(out.map(i => i.key))
      for (const r of state.routes) {
        if (state.hidden.has(r.key)) continue
        let n = 0
        for (const row of state.stored.get(r.key)?.rows || []) {
          if (n >= STORED_SHOWN) break
          if (shownKeys.has(row.id) || (row.resolved_id && shownKeys.has(row.resolved_id))) continue
          if (state.owner.get(row.id) && state.owner.get(row.id) !== r.key) continue
          shownKeys.add(row.id)
          n++
          out.push({
            id: `${r.key}|stored:${row.id}`,
            rawId: row.id,
            key: row.resolved_id || row.id,
            live: false,
            stored: true,
            profile: r.profile,
            profileLabel: r.label,
            routeKey: r.key,
            activeProfile: r.active,
            title: row.title || 'Untitled session',
            preview: row.preview || '',
            model: '',
            source: row.source || '',
            messageCount: row.message_count || 0,
            lastActive: toMs(row.started_at),
            startedAt: toMs(row.started_at),
            sessionStatus: 'stored',
            column: 'idle',
            turn: null,
            requests: [],
            usage: null
          })
        }
      }
    }
    if (!state.deleted.size) return out
    const now = Date.now()
    return out.filter(i => !tombstoned(i.key, i.routeKey, now) && !tombstoned(i.rawId, i.routeKey, now))
  }

  function refresh() {
    routesAt = 0
    storedAt = 0
    return poll()
  }

  // ── new task: session.create (+ first prompt) on a chosen profile ──

  // The backend profile a route serves (an SSH route may map to another remote profile name).
  const backendProfile = r => r?.route?.targetProfile || r?.profile

  function openComposer(routeKey = null) {
    state.viewing = null
    state.compose = { routeKey, at: Date.now() }
    emit()
    host.navigate?.(ROUTE)
  }

  function closeComposer() {
    state.compose = null
    emit()
  }

  async function loadModels(routeKey, force = false) {
    const cur = state.models.get(routeKey)
    if (cur?.loading || (cur?.providers && !force)) return
    state.models.set(routeKey, { ...(cur || {}), loading: true, error: null })
    emit()
    const r = routeOf(routeKey)
    try {
      const res = await rpc(r?.route, 'model.options', { profile: backendProfile(r), refresh: force }, true)
      const providers = (res?.providers || [])
        .filter(p => p && p.slug && p.authenticated !== false && (p.models || []).length)
        .map(p => {
          const featured = (p.featured_models || []).filter(m => p.models.includes(m))
          const unavailable = new Set(p.unavailable_models || [])
          const models = [...new Set([...featured, ...p.models])].filter(m => !unavailable.has(m))
          return { slug: p.slug, name: p.name || p.slug, models, capabilities: p.capabilities || {} }
        })
      state.models.set(routeKey, { loading: false, providers, model: res?.model || '', provider: res?.provider || '', error: null })
    } catch (err) {
      state.models.set(routeKey, { loading: false, providers: [], error: errorText(err) })
    }
    emit()
  }

  // Throws on failure. An error with `created: true` means the session exists but its first prompt
  // failed: retry with the same idempotency key so session.create returns that session, not a new one.
  async function createSession(routeKey, opts) {
    const r = routeOf(routeKey)
    if (!r) throw new Error('That profile is no longer available')
    const prompt = opts.prompt?.trim()
    if (!prompt) throw new Error('The task prompt cannot be empty')
    const params = {
      profile: backendProfile(r),
      title: opts.title?.trim() || undefined,
      model: opts.model || undefined,
      provider: opts.provider || undefined,
      reasoning_effort: opts.reasoningEffort || undefined,
      // Presence is the contract: omitted inherits, true pins priority, false pins normal.
      fast: opts.fast === 'on' ? true : opts.fast === 'off' ? false : undefined,
      cwd: opts.cwd?.trim() || undefined,
      cwd_explicit: opts.cwd?.trim() ? true : undefined,
      idempotency_key: opts.idempotencyKey
    }
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k]

    const res = await rpc(r.route, 'session.create', params, true)
    const sid = res?.session_id
    if (!sid) throw new Error('session.create returned no session_id')
    // The DB row only appears with the first prompt: pin the owner so a shared backend's row
    // lands under the chosen profile before session.list knows it.
    for (const id of [res.stored_session_id, sid]) if (id) state.pinnedOwner.set(id, r.key)

    try {
      await rpc(r.route, 'prompt.submit', { session_id: sid, text: prompt }, true)
    } catch (err) {
      pollSoon(300)
      throw Object.assign(err instanceof Error ? err : new Error(errorText(err)), { created: true })
    }

    pushActivity(startTurn(`${r.key}|${sid}`), { kind: 'user', label: `You: ${oneLine(prompt)}`, done: true })
    pollSoon(300)
    if (opts.openAfter) {
      try {
        await host.openSession(res.stored_session_id || sid, r.active ? undefined : { profile: r.profile })
      } catch {}
    }
    return res
  }

  function setShowStored(on) {
    state.showStored = on
    writeStored(ctx, 'showStored', on)
    emit()
  }

  return {
    refresh,
    setShowStored,
    openComposer,
    openViewer,
    closeViewer,
    loadTranscript,
    closeComposer,
    loadModels,
    createSession,
    state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getVersion: () => version,
    handleEvent,
    poll,
    answer,
    send,
    interrupt,
    dismiss,
    remove,
    open,
    setHidden,
    items
  }
}

// ── styles ────────────────────────────────────────────────────────────────────────────────

const CSS = `
.hb-root{--hb-fg:var(--ui-text-primary,currentColor);--hb-fg2:var(--ui-text-secondary,color-mix(in srgb,currentColor 78%,transparent));--hb-fg3:var(--ui-text-tertiary,color-mix(in srgb,currentColor 58%,transparent));--hb-fg4:var(--ui-text-quaternary,color-mix(in srgb,currentColor 40%,transparent));--hb-line:var(--ui-stroke-secondary,color-mix(in srgb,currentColor 14%,transparent));--hb-accent:var(--ui-accent,#3b82f6);--hb-col:color-mix(in srgb,currentColor 4%,transparent);--hb-card:var(--ui-bg-elevated,var(--ui-surface,color-mix(in srgb,currentColor 2%,Canvas)));--hb-needs:#e8a317;--hb-run:var(--hb-accent);--hb-done:#22a06b;--hb-fail:#e5484d;--hb-idle:var(--hb-fg4);
  display:flex;flex-direction:column;height:100%;min-height:0;color:var(--hb-fg);font-size:13px;line-height:1.4}
.hb-head{display:flex;align-items:center;gap:12px;padding:14px 18px 10px;flex-wrap:wrap}
.hb-crumb{display:flex;align-items:center;gap:8px;font-size:15px}
.hb-crumb span:first-child{color:var(--hb-fg3)}
.hb-crumb .hb-sep{color:var(--hb-fg4)}
.hb-crumb b{font-weight:600}
.hb-stats{display:flex;gap:6px;flex-wrap:wrap;margin-left:4px}
.hb-stat{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;border:1px solid var(--hb-line);color:var(--hb-fg2);font-size:11.5px;white-space:nowrap}
.hb-stat.hb-warn{color:var(--hb-fail);border-color:color-mix(in srgb,var(--hb-fail) 40%,transparent)}
.hb-spacer{flex:1}
.hb-search{height:28px;border-radius:7px;border:1px solid var(--hb-line);background:transparent;color:inherit;padding:0 9px;font:inherit;width:180px;outline:none}
.hb-search:focus{border-color:var(--hb-accent)}
.hb-searchbox{position:relative;display:inline-flex;align-items:center}
.hb-searchbox .hb-search{padding-right:26px}
.hb-search-clear{position:absolute;right:5px;width:18px;height:18px;border-radius:50%;border:0;padding:0;background:color-mix(in srgb,currentColor 10%,transparent);color:var(--hb-fg3);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.hb-search-clear:hover{color:var(--hb-fg);background:color-mix(in srgb,currentColor 18%,transparent)}
.hb-seg{display:inline-flex;padding:2px;border-radius:8px;background:var(--hb-col);border:1px solid var(--hb-line)}
.hb-seg button{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--hb-fg3);font:inherit;padding:4px 10px;border-radius:6px;cursor:pointer}
.hb-seg button[aria-pressed=true]{background:var(--hb-card);color:var(--hb-fg);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.hb-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;border:1px solid var(--hb-line);background:transparent;color:var(--hb-fg3);cursor:pointer}
.hb-iconbtn:hover{color:var(--hb-fg)}
.hb-banner{margin:0 18px 8px;padding:7px 10px;border-radius:8px;border:1px solid color-mix(in srgb,var(--hb-fail) 40%,transparent);color:var(--hb-fail);font-size:12px}
.hb-board{flex:1;min-height:0;display:flex;gap:12px;padding:4px 18px 18px;overflow-x:auto;align-items:flex-start}
.hb-col{flex:1 0 248px;min-width:248px;max-width:340px;display:flex;flex-direction:column;max-height:100%;min-height:0;border-radius:12px;background:var(--hb-col)}
.hb-colhead{display:flex;align-items:center;gap:8px;padding:10px 12px 8px}
.hb-colhead .hb-collabel{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--hb-fg3);flex:1;text-align:center}
.hb-count{min-width:20px;padding:0 6px;border-radius:6px;background:color-mix(in srgb,currentColor 9%,transparent);color:var(--hb-fg3);font-size:11px;text-align:center;line-height:18px}
.hb-colbody{display:flex;flex-direction:column;gap:8px;padding:0 8px 10px;overflow-y:auto;min-height:40px}
.hb-empty{padding:14px 8px 18px;text-align:center;color:var(--hb-fg4);font-size:12px}
.hb-card{border-radius:10px;border:1px solid var(--hb-line);background:var(--hb-card);padding:11px 12px;display:flex;flex-direction:column;gap:7px;box-shadow:0 1px 2px rgba(0,0,0,.06);transition:border-color .12s}
.hb-card:hover{border-color:color-mix(in srgb,var(--hb-fg) 22%,transparent)}
.hb-card.hb-sel{border-color:color-mix(in srgb,var(--hb-accent) 55%,transparent)}
@property --hb-angle{syntax:"<angle>";inherits:false;initial-value:0deg}
.hb-card.hb-running{border-color:transparent;background:linear-gradient(var(--hb-card),var(--hb-card)) padding-box,conic-gradient(from var(--hb-angle),transparent 0 52%,color-mix(in srgb,var(--hb-run) 25%,transparent) 68%,var(--hb-run) 86%,color-mix(in srgb,var(--hb-run) 60%,#fff) 90%,transparent 100%) border-box,linear-gradient(color-mix(in srgb,var(--hb-run) 22%,var(--hb-line)),color-mix(in srgb,var(--hb-run) 22%,var(--hb-line))) border-box;animation:hb-orbit 2.6s linear infinite;box-shadow:0 0 0 1px color-mix(in srgb,var(--hb-run) 6%,transparent),0 4px 16px -6px color-mix(in srgb,var(--hb-run) 35%,transparent)}
@keyframes hb-orbit{to{--hb-angle:360deg}}
.hb-card[data-col=needs]{--hb-arrive:var(--hb-needs)}.hb-card[data-col=running]{--hb-arrive:var(--hb-run)}.hb-card[data-col=done]{--hb-arrive:var(--hb-done)}.hb-card[data-col=failed]{--hb-arrive:var(--hb-fail)}.hb-card[data-col=idle]{--hb-arrive:var(--hb-fg3)}
.hb-card.hb-arrived{animation:hb-arrive 1s ease-out}
.hb-card.hb-running.hb-arrived{animation:hb-arrive 1s ease-out,hb-orbit 2.6s linear infinite}
@keyframes hb-arrive{0%{box-shadow:0 0 0 3px color-mix(in srgb,var(--hb-arrive) 60%,transparent),0 8px 24px -6px color-mix(in srgb,var(--hb-arrive) 45%,transparent)}100%{box-shadow:0 0 0 0 transparent,0 1px 2px rgba(0,0,0,.06)}}
.hb-ghost-card{position:fixed!important;margin:0!important;z-index:900;pointer-events:none;box-sizing:border-box;overflow:hidden;box-shadow:0 22px 48px -12px rgba(0,0,0,.35)!important}
@media (prefers-reduced-motion:reduce){.hb-card.hb-running,.hb-card.hb-arrived{animation:none}}
.hb-cardhead{position:relative;display:flex;align-items:flex-start;gap:8px;cursor:pointer;user-select:none}
.hb-title{flex:1;min-width:0;font-weight:600;font-size:13.5px;line-height:1.3;word-break:break-word}
.hb-title-btn{all:unset;cursor:pointer;border-radius:4px;display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hb-title-btn:focus-visible{outline:2px solid var(--hb-accent);outline-offset:2px}
.hb-card-actions{position:absolute;top:-3px;right:-4px;display:flex;gap:1px;padding:2px;border-radius:7px;background:var(--hb-card);box-shadow:-10px 0 10px -4px var(--hb-card),0 1px 3px rgba(0,0,0,.12);opacity:0;pointer-events:none;transition:opacity .12s}
.hb-card:hover .hb-card-actions,.hb-card:focus-within .hb-card-actions{opacity:1;pointer-events:auto}
.hb-ext{border:0;background:transparent;color:var(--hb-fg3);cursor:pointer;padding:3px 4px;border-radius:5px;display:inline-flex}
.hb-ext:hover{color:var(--hb-fg);background:color-mix(in srgb,currentColor 8%,transparent)}
.hb-meta-end{margin-left:auto;display:inline-flex;justify-content:flex-end;min-width:0;max-width:48%}
.hb-meta-end .hb-ptag{max-width:100%}
.hb-preview{color:var(--hb-fg2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.hb-preview .hb-who{font-weight:600;color:var(--hb-fg)}
.hb-card.hb-running .hb-preview{line-height:1.45;height:2.9em} /* live tool text changes length; keep the card height fixed */
.hb-meta{display:flex;align-items:center;gap:8px;color:var(--hb-fg3);font-size:12px;flex-wrap:nowrap;min-width:0}
.hb-meta>.hb-state{flex:none;white-space:nowrap}
.hb-meta>.hb-meta-end{flex:0 1 auto;min-width:22px}
.hb-meta .hb-m{flex:none;display:inline-flex;align-items:center;gap:4px;color:var(--hb-fg4);font-size:11.5px}
.hb-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--hb-fg2)}
.hb-dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block}
.hb-spin{width:11px;height:11px;border-radius:50%;border:1.6px solid color-mix(in srgb,var(--hb-run) 30%,transparent);border-top-color:var(--hb-run);animation:hb-spin .9s linear infinite;display:inline-block}
@keyframes hb-spin{to{transform:rotate(360deg)}}
.hb-c-needs{color:var(--hb-needs)}.hb-c-running{color:var(--hb-run)}.hb-c-done{color:var(--hb-done)}.hb-c-failed{color:var(--hb-fail)}.hb-c-idle{color:var(--hb-idle)}
.hb-body{border-top:1px solid var(--hb-line);margin-top:2px;padding-top:9px;display:flex;flex-direction:column;gap:10px}
.hb-sub{font-size:11.5px;color:var(--hb-fg3);display:flex;gap:8px;align-items:center}
.hb-tl{list-style:none;margin:0;padding:0 0 0 2px;display:flex;flex-direction:column}
.hb-tl li{position:relative;display:flex;gap:8px;padding:2px 0 6px 14px;color:var(--hb-fg2);font-size:12.5px}
.hb-tl li:before{content:"";position:absolute;left:2px;top:8px;width:5px;height:5px;border-radius:50%;background:var(--hb-fg4)}
.hb-tl li:after{content:"";position:absolute;left:4px;top:15px;bottom:-2px;width:1px;background:var(--hb-line)}
.hb-tl li:last-child:after{display:none}
.hb-tl li.hb-live{color:var(--hb-fg)}
.hb-tl li.hb-live:before{background:var(--hb-run)}
.hb-tl li.hb-err{color:var(--hb-fail)}
.hb-tl li.hb-user:before{background:var(--hb-fg)}
.hb-tl .hb-tltext{flex:1;word-break:break-word}
.hb-tl .hb-tltime{color:var(--hb-fg4);white-space:nowrap;font-size:11.5px}
.hb-req{border-radius:8px;border:1px solid color-mix(in srgb,var(--hb-needs) 45%,transparent);background:color-mix(in srgb,var(--hb-needs) 7%,transparent);padding:9px 10px;display:flex;flex-direction:column;gap:8px}
.hb-reqkind{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--hb-needs)}
.hb-pre{margin:0;padding:7px 8px;border-radius:6px;background:color-mix(in srgb,currentColor 7%,transparent);font:12px/1.45 var(--ui-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto}
.hb-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.hb-row.hb-end{justify-content:flex-end}
.hb-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 12px;border-radius:7px;border:1px solid var(--hb-line);background:transparent;color:var(--hb-fg);font:inherit;font-weight:500;cursor:pointer;white-space:nowrap}
.hb-btn:hover{background:color-mix(in srgb,currentColor 6%,transparent)}
.hb-btn:disabled{opacity:.45;cursor:default}
.hb-btn.hb-primary{background:var(--hb-fg);color:var(--hb-card);border-color:var(--hb-fg)}
.hb-btn.hb-primary:hover{opacity:.88;background:var(--hb-fg)}
.hb-btn.hb-small{height:24px;padding:0 9px;font-size:12px}
.hb-btn.hb-danger{background:var(--hb-fail);border-color:var(--hb-fail);color:#fff}
.hb-btn.hb-danger:hover{background:color-mix(in srgb,var(--hb-fail) 88%,#000)}
.hb-ext.hb-ext-danger:hover{color:var(--hb-fail);background:color-mix(in srgb,var(--hb-fail) 10%,transparent)}
.hb-modal.hb-confirm{max-width:440px}
.hb-confirm-text{margin:0;font-size:13.5px;line-height:1.55;color:var(--hb-fg2);word-break:break-word}
.hb-confirm-text b{color:var(--hb-fg);font-weight:600}
.hb-confirm-warn{display:flex;align-items:center;gap:6px;color:var(--hb-needs)}
.hb-input,.hb-textarea{width:100%;box-sizing:border-box;border-radius:7px;border:1px solid var(--hb-line);background:transparent;color:inherit;font:inherit;padding:6px 8px;outline:none}
.hb-input:focus,.hb-textarea:focus{border-color:var(--hb-accent)}
.hb-textarea{resize:vertical;min-height:34px;max-height:160px}
.hb-composer{display:flex;gap:6px;align-items:flex-end}
.hb-composer .hb-textarea{flex:1;min-width:0}
.hb-chips{display:flex;flex-wrap:wrap;gap:5px}
.hb-chip{border:1px solid var(--hb-line);background:transparent;color:var(--hb-fg2);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
.hb-chip[aria-pressed=true]{border-color:var(--hb-accent);color:var(--hb-fg);background:color-mix(in srgb,var(--hb-accent) 12%,transparent)}
.hb-q{display:flex;flex-direction:column;gap:6px}
.hb-qtext{font-weight:500}
.hb-chat{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto;padding-right:2px}
.hb-msg{padding:6px 9px;border-radius:9px;max-width:92%;white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.hb-msg.hb-user{align-self:flex-end;background:color-mix(in srgb,var(--hb-accent) 14%,transparent)}
.hb-msg.hb-assistant{align-self:flex-start;background:color-mix(in srgb,currentColor 6%,transparent)}
.hb-msg.hb-streaming{border:1px dashed var(--hb-line)}
.hb-modal-backdrop.hb-viewer-backdrop{padding:12px;align-items:stretch;justify-content:center}
.hb-viewer{position:relative;flex:none;max-width:100%;height:100%;display:flex;flex-direction:column;border-radius:14px;background:var(--hb-card);color:var(--hb-fg);border:1px solid var(--hb-line);box-shadow:0 30px 80px -20px rgba(0,0,0,.45);overflow:hidden;animation:hb-rise .16s ease-out}
.hb-vresize{position:absolute;top:0;bottom:0;width:10px;z-index:2;cursor:ew-resize;touch-action:none}
.hb-vresize-left{left:-5px}.hb-vresize-right{right:-5px}
.hb-vresize:after{content:"";position:absolute;top:50%;left:3px;width:4px;height:44px;margin-top:-22px;border-radius:4px;background:var(--hb-fg4);opacity:0;transition:opacity .15s}
.hb-vresize:hover:after,.hb-resizing .hb-vresize:after{opacity:.7}
.hb-viewer.hb-resizing{user-select:none;animation:none}
.hb-viewer[data-slot]{-webkit-backdrop-filter:none;backdrop-filter:none}
.hb-viewer .hb-transcript,.hb-viewer .hb-vside{-webkit-user-select:text;user-select:text}
.hb-viewer button,.hb-viewer.hb-resizing *{-webkit-user-select:none;user-select:none}
.hb-ctxmenu{position:fixed;z-index:1001;min-width:180px;padding:4px;display:flex;flex-direction:column;border-radius:10px;background:var(--hb-card);color:var(--hb-fg);border:1px solid var(--hb-line);box-shadow:0 12px 32px -8px rgba(0,0,0,.35);font-size:13px;animation:hb-fade .08s ease-out}
.hb-ctxitem{display:flex;align-items:center;gap:16px;border:0;background:transparent;color:inherit;font:inherit;padding:6px 10px;border-radius:6px;cursor:pointer;text-align:left}
.hb-ctxitem:hover:not(:disabled),.hb-ctxitem:focus-visible{outline:none;background:color-mix(in srgb,var(--hb-accent) 14%,transparent)}
.hb-ctxitem:disabled{color:var(--hb-fg4);cursor:default}
.hb-ctxkey{margin-left:auto;color:var(--hb-fg4);font-size:11.5px}
.hb-vbar{display:flex;align-items:center;gap:10px;height:52px;padding:0 10px 0 8px;border-bottom:1px solid var(--hb-line);flex:none;min-width:0}
.hb-vbar-title{font-size:14.5px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:60px;max-width:40%}
.hb-ghost.hb-on{color:var(--hb-fg);background:color-mix(in srgb,currentColor 8%,transparent)}
.hb-vmain{flex:1;min-height:0;display:flex}
.hb-vchat{flex:1;min-width:0;display:flex;flex-direction:column}
.hb-transcript{flex:1;min-height:0;overflow-y:auto;padding:28px 24px 12px}
.hb-tcol{max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:22px}
.hb-tempty{display:flex;align-items:center;justify-content:center;gap:8px;padding:60px 0;color:var(--hb-fg4)}
.hb-trow{display:flex;flex-direction:column;gap:6px;min-width:0}
.hb-tmeta{font-size:11px;color:var(--hb-fg4);font-weight:400}
.hb-trow-user{align-items:flex-end}
.hb-ububble{max-width:78%;padding:10px 14px;border-radius:18px 18px 4px 18px;background:color-mix(in srgb,var(--hb-fg) 7%,transparent);white-space:pre-wrap;word-break:break-word;font-size:14.5px;line-height:1.55}
.hb-aname{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--hb-fg2)}
.hb-avatar{width:22px;height:22px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;color:var(--hb-accent);background:color-mix(in srgb,var(--hb-accent) 14%,transparent)}
.hb-avatar-live{animation:hb-pulse 1.4s ease-in-out infinite}
@keyframes hb-pulse{50%{box-shadow:0 0 0 5px color-mix(in srgb,var(--hb-accent) 12%,transparent)}}
.hb-abody{padding-left:30px;font-size:14.5px;line-height:1.68;word-break:break-word}
.hb-hostmd{min-width:0;overflow-wrap:anywhere}
.hb-hostmd pre{max-width:100%;overflow-x:auto}
.hb-md{display:flex;flex-direction:column;gap:10px;min-width:0}
.hb-md>*{margin:0}
.hb-md p{margin:0}
.hb-md .hb-mdh{margin:6px 0 0;font-weight:650;line-height:1.35}
.hb-md .hb-mdh1{font-size:20px}.hb-md .hb-mdh2{font-size:17px}.hb-md .hb-mdh3{font-size:15.5px}.hb-md .hb-mdh4,.hb-md .hb-mdh5,.hb-md .hb-mdh6{font-size:14.5px}
.hb-md ul,.hb-md ol{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:4px}
.hb-md li>ul,.hb-md li>ol{margin-top:4px}
.hb-md li>.hb-codeblock,.hb-md li>p,.hb-md li>blockquote,.hb-md li>.hb-tablewrap{margin-top:6px}
.hb-md li::marker{color:var(--hb-fg3)}
.hb-md ul.hb-tasklist{list-style:none;padding-left:4px}
.hb-md li.hb-task input{margin:0 8px 0 0;vertical-align:-1px;accent-color:var(--hb-accent)}
.hb-md blockquote{margin:0;padding:2px 0 2px 14px;border-left:3px solid color-mix(in srgb,var(--hb-fg) 18%,transparent);color:var(--hb-fg2);display:flex;flex-direction:column;gap:8px}
.hb-md hr{border:0;border-top:1px solid var(--hb-line);margin:6px 0}
.hb-md strong{font-weight:650}
.hb-md del{color:var(--hb-fg3)}
.hb-link{color:var(--hb-accent);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--hb-accent) 40%,transparent);text-underline-offset:2px;cursor:pointer;word-break:break-word}
.hb-link:hover{text-decoration-color:var(--hb-accent)}
.hb-tablewrap{overflow-x:auto;border:1px solid var(--hb-line);border-radius:10px}
.hb-md table{border-collapse:collapse;width:100%;font-size:13.5px}
.hb-md th,.hb-md td{padding:7px 12px;border-bottom:1px solid var(--hb-line);text-align:left;vertical-align:top}
.hb-md th{font-weight:600;background:color-mix(in srgb,currentColor 4%,transparent);white-space:nowrap}
.hb-md tr:last-child td{border-bottom:0}
.hb-md tbody tr:nth-child(even) td{background:color-mix(in srgb,currentColor 2%,transparent)}
.hb-directive{font:12px var(--ui-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--hb-fg3);padding:6px 10px;border-radius:8px;border:1px dashed var(--hb-line)}
.hb-sys-head{width:100%}
.hb-sys-preview{flex:1}
.hb-sys-body{margin-top:6px;padding:12px 14px;border-radius:10px;border:1px solid var(--hb-line);background:color-mix(in srgb,currentColor 3%,transparent);font-size:13.5px}
.hb-trow-system{padding-left:30px}
.hb-icode{font-family:var(--ui-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:.88em;padding:1px 5px;border-radius:5px;background:color-mix(in srgb,currentColor 9%,transparent)}
.hb-codeblock{margin:0;border-radius:10px;border:1px solid var(--hb-line);overflow:hidden;background:color-mix(in srgb,currentColor 4%,transparent)}
.hb-codehead{display:flex;align-items:center;justify-content:space-between;padding:5px 10px;font-size:11.5px;color:var(--hb-fg3);border-bottom:1px solid var(--hb-line)}
.hb-codecopy{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--hb-fg3);font:inherit;cursor:pointer;padding:2px 4px;border-radius:5px}
.hb-codecopy:hover{color:var(--hb-fg);background:color-mix(in srgb,currentColor 8%,transparent)}
.hb-codeblock pre{margin:0;padding:10px 12px;overflow-x:auto;font:12.5px/1.55 var(--ui-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:pre}
.hb-tool-head{display:flex;align-items:center;gap:8px;max-width:100%;align-self:flex-start;border:1px solid var(--hb-line);background:transparent;color:var(--hb-fg2);font:inherit;font-size:12.5px;padding:5px 10px;border-radius:9px;cursor:pointer;text-align:left}
.hb-tool-head:hover{color:var(--hb-fg);background:color-mix(in srgb,currentColor 4%,transparent)}
.hb-tool-ico{color:var(--hb-fg3);display:inline-flex}
.hb-tool-name{font-weight:600;white-space:nowrap}
.hb-tool-ctx{color:var(--hb-fg3);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ui-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px}
.hb-trow-req{padding-left:30px}
.hb-caret-blink{display:inline-block;width:8px;height:16px;margin-left:2px;vertical-align:-3px;border-radius:1px;background:var(--hb-accent);animation:hb-blink 1s steps(1) infinite}
@keyframes hb-blink{50%{opacity:0}}
.hb-vcompose{flex:none;padding:8px 24px 18px}
.hb-cbox{max-width:820px;margin:0 auto;border-radius:18px;border:1px solid var(--hb-line);background:var(--hb-card);box-shadow:0 6px 24px -10px rgba(0,0,0,.25);padding:12px 12px 10px 16px;display:flex;flex-direction:column;gap:8px;transition:border-color .12s,box-shadow .12s}
.hb-cbox:focus-within{border-color:color-mix(in srgb,var(--hb-accent) 55%,var(--hb-line));box-shadow:0 6px 24px -10px rgba(0,0,0,.25),0 0 0 3px color-mix(in srgb,var(--hb-accent) 14%,transparent)}
.hb-cbox-off{flex-direction:row;align-items:center}
.hb-cbox-input{border:0;outline:none;resize:none;background:transparent;color:inherit;font:inherit;font-size:14.5px;line-height:1.5;min-height:24px;max-height:220px;padding:2px 0}
.hb-cbox-input::placeholder{color:var(--hb-fg4)}
.hb-cbox-bar{display:flex;align-items:center;gap:8px}
.hb-cbox-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:8px;border:1px solid var(--hb-line);font-size:12px;color:var(--hb-fg2);white-space:nowrap}
.hb-cbox-model{border-color:transparent;color:var(--hb-fg3)}
.hb-cbox-hint{font-size:11.5px}
.hb-cbox-stop,.hb-cbox-send{flex:none;width:34px;height:34px;border-radius:11px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid var(--hb-line);background:transparent;color:var(--hb-fg)}
.hb-cbox-stop:hover{background:color-mix(in srgb,currentColor 7%,transparent)}
.hb-cbox-send{background:var(--hb-fg);color:var(--hb-card);border-color:var(--hb-fg)}
.hb-cbox-send:disabled{background:color-mix(in srgb,var(--hb-fg) 12%,transparent);border-color:transparent;color:var(--hb-fg4);cursor:default}
.hb-vside{flex:none;width:300px;border-left:1px solid var(--hb-line);overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:20px;background:color-mix(in srgb,currentColor 2%,transparent)}
.hb-vblock{display:flex;flex-direction:column;gap:7px}
.hb-kv{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--hb-fg3)}
.hb-kv b{font-weight:550;color:var(--hb-fg);text-align:right;word-break:break-word}
.hb-idbtn{display:inline-flex;align-items:center;gap:5px;max-width:170px;border:0;background:transparent;color:var(--hb-fg2);cursor:pointer;padding:0}
.hb-idbtn code{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:900px){.hb-vside{display:none}.hb-cbox-hint,.hb-cbox-model{display:none}.hb-vbar .hb-ptag{display:none}}
@media (max-width:640px){.hb-modal-backdrop.hb-viewer-backdrop{padding:0}.hb-viewer{border-radius:0;width:100%!important}.hb-vresize{display:none}.hb-transcript{padding:18px 14px 8px}.hb-vcompose{padding:6px 10px 12px}.hb-abody,.hb-trow-req{padding-left:0}}
@media (prefers-reduced-motion:reduce){.hb-caret-blink,.hb-avatar-live{animation:none}}
.hb-modal-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:9vh 16px 16px;background:rgba(10,10,14,.42);backdrop-filter:blur(3px);animation:hb-fade .12s ease-out}
@keyframes hb-fade{from{opacity:0}}
@keyframes hb-rise{from{opacity:0;transform:translateY(8px) scale(.985)}}
.hb-modal{width:100%;max-width:600px;max-height:82vh;display:flex;flex-direction:column;border-radius:16px;background:var(--hb-card);color:var(--hb-fg);border:1px solid var(--hb-line);box-shadow:0 24px 70px -12px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.08);animation:hb-rise .16s ease-out}
.hb-modal-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 6px}
.hb-modal-head>div{flex:1}
.hb-modal-title{font-size:16px;font-weight:650}
.hb-modal-body{padding:10px 20px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:16px}
.hb-modal-err{padding:8px 10px;border-radius:8px;border:1px solid color-mix(in srgb,var(--hb-fail) 40%,transparent);background:color-mix(in srgb,var(--hb-fail) 8%,transparent);color:var(--hb-fail);font-size:12.5px}
.hb-section{display:flex;flex-direction:column;gap:7px;min-width:0}
.hb-flabel{font-size:12px;font-weight:600;color:var(--hb-fg2)}
.hb-flabel-note{font-weight:400;color:var(--hb-fg4);font-size:11.5px}
.hb-field-err{color:var(--hb-fail);font-size:12px}
.hb-field-input:focus{border-color:var(--hb-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--hb-accent) 18%,transparent)}
.hb-field-input::placeholder{color:var(--hb-fg4)}
.hb-field-input{height:34px;box-sizing:border-box;border-radius:9px;border:1px solid var(--hb-line);background:transparent;color:inherit;font:inherit;font-size:13px;padding:0 10px;outline:none;width:100%}
.hb-mono{font-family:var(--ui-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12.5px}
.hb-caret{display:inline-flex;transform:rotate(-90deg);transition:transform .15s}
.hb-caret.hb-on{transform:none}
.hb-adv{display:flex;flex-direction:column;gap:14px;padding:14px;border-radius:12px;background:color-mix(in srgb,currentColor 3%,transparent);border:1px solid var(--hb-line)}
.hb-adv-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:560px){.hb-adv-grid{grid-template-columns:1fr}.hb-modal-backdrop{padding-top:4vh}}
.hb-seg2{display:inline-flex;flex-wrap:wrap;gap:2px;padding:2px;border-radius:9px;border:1px solid var(--hb-line);background:color-mix(in srgb,currentColor 3%,transparent);align-self:flex-start;max-width:100%}
.hb-seg2 button{border:0;background:transparent;color:var(--hb-fg3);font:inherit;font-size:12.5px;height:26px;padding:0 10px;border-radius:7px;cursor:pointer}
.hb-seg2 button:hover{color:var(--hb-fg)}
.hb-seg2 button.hb-on{background:var(--hb-card);color:var(--hb-fg);box-shadow:0 1px 2px rgba(0,0,0,.14),0 0 0 1px var(--hb-line)}
.hb-seg2.hb-disabled{opacity:.5}
.hb-seg2 button:disabled{cursor:default}
.hb-switch-row{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--hb-fg2);cursor:pointer}
.hb-switch{position:relative;flex:none;width:32px;height:18px;border-radius:999px;background:color-mix(in srgb,currentColor 22%,transparent);transition:background .15s}
.hb-switch:after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
.hb-switch.hb-on{background:var(--hb-accent)}
.hb-switch.hb-on:after{transform:translateX(14px)}
.hb-switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.hb-combo{position:relative;min-width:0}
.hb-taskmodal{max-width:680px}
.hb-taskmodal .hb-modal-head{align-items:center;padding:16px 20px 4px}
.hb-taskmodal .hb-modal-body{padding:10px 20px 20px;gap:10px}
.hb-tbox{border:1px solid var(--hb-line);border-radius:18px;background:var(--hb-card);padding:14px 12px 10px 16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 28px -14px rgba(0,0,0,.25);transition:border-color .12s,box-shadow .12s}
.hb-tbox:focus-within{border-color:color-mix(in srgb,var(--hb-accent) 50%,var(--hb-line));box-shadow:0 8px 28px -14px rgba(0,0,0,.25),0 0 0 3px color-mix(in srgb,var(--hb-accent) 13%,transparent)}
/* Gradient border on both composers (new task, session viewer): soft at rest, a slow orbit while typing. */
.hb-tbox,.hb-cbox{border-width:1.5px;border-color:transparent;background:linear-gradient(var(--hb-card),var(--hb-card)) padding-box,linear-gradient(120deg,color-mix(in srgb,#7c5cff 38%,var(--hb-line)),color-mix(in srgb,#22c3ee 32%,var(--hb-line)) 50%,color-mix(in srgb,#f472b6 32%,var(--hb-line))) border-box}
.hb-tbox:focus-within,.hb-cbox:focus-within{border-color:transparent;background:linear-gradient(var(--hb-card),var(--hb-card)) padding-box,conic-gradient(from var(--hb-angle),#7c5cff,#4f8cff,#22c3ee,#34d399,#f5b84c,#f472b6,#7c5cff) border-box;animation:hb-orbit 5s linear infinite;box-shadow:0 8px 28px -14px rgba(0,0,0,.25),0 0 0 3px color-mix(in srgb,#7c5cff 10%,transparent),0 8px 30px -10px color-mix(in srgb,#4f8cff 40%,transparent)}
.hb-tbox.hb-invalid,.hb-tbox.hb-invalid:focus-within{border-color:var(--hb-fail);background:var(--hb-card);animation:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--hb-fail) 14%,transparent)}
@media (prefers-reduced-motion:reduce){.hb-tbox:focus-within,.hb-cbox:focus-within{animation:none}}
.hb-tbox.hb-busy{opacity:.7}
.hb-tbox-input{border:0;outline:none;resize:none;background:transparent;color:inherit;font:inherit;font-size:15px;line-height:1.55;min-height:72px;max-height:260px;padding:0}
.hb-tbox-input::placeholder{color:var(--hb-fg4)}
.hb-tbox-bar{display:flex;align-items:center;gap:6px;min-width:0}
.hb-tbox-plus{flex:none;width:32px;height:32px;border-radius:50%;border:1px solid var(--hb-line);background:transparent;color:var(--hb-fg3);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.hb-tbox-plus:hover{color:var(--hb-fg);background:color-mix(in srgb,currentColor 6%,transparent)}
.hb-tbox-plus svg{transition:transform .15s}
.hb-tbox-plus.hb-on{color:var(--hb-fg);background:color-mix(in srgb,currentColor 7%,transparent)}
.hb-tbox-plus.hb-on svg{transform:rotate(45deg)}
.hb-tbox-send{flex:none;width:36px;height:36px;border-radius:50%;border:0;background:var(--hb-accent);color:#fff;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 6px -1px color-mix(in srgb,var(--hb-accent) 55%,transparent);transition:opacity .12s,transform .1s}
.hb-tbox-send:hover{transform:translateY(-1px)}
.hb-tbox-send:disabled{opacity:.4;cursor:default;transform:none;box-shadow:none}
.hb-tbox-hint{font-size:11.5px;color:var(--hb-fg4);padding:0 6px}
.hb-combo-pill{flex:0 1 auto}
.hb-combo-pill .hb-combo-btn{width:auto;max-width:220px;height:32px;padding:0 10px;gap:6px;border-radius:999px;font-size:13px;color:var(--hb-fg2)}
.hb-combo-pill .hb-combo-btn:hover{color:var(--hb-fg)}
.hb-combo-bare .hb-combo-btn{border-color:transparent}
.hb-combo-bare .hb-combo-btn:hover,.hb-combo-bare .hb-combo-btn.hb-open{border-color:var(--hb-line)}
.hb-combo-pill .hb-combo-btn .hb-pdot{flex:none}
.hb-combo-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hb-pop:focus{outline:none}
.hb-pop-opt .hb-pdot{flex:none}
.hb-pop-warn .hb-pop-hint{color:var(--hb-fail);border-color:color-mix(in srgb,var(--hb-fail) 40%,transparent)}
@media (max-width:520px){.hb-combo-pill .hb-combo-btn{max-width:130px}}
.hb-combo-btn{width:100%;display:flex;align-items:center;gap:8px;height:38px;padding:0 12px;border-radius:10px;border:1px solid var(--hb-line);background:transparent;color:var(--hb-fg);font:inherit;font-size:13.5px;cursor:pointer;text-align:left}
.hb-combo-btn:hover{border-color:color-mix(in srgb,var(--hb-fg) 25%,transparent)}
.hb-combo-btn.hb-open,.hb-combo-btn:focus-visible{border-color:var(--hb-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--hb-accent) 18%,transparent);outline:none}
.hb-combo-btn:disabled{opacity:.6;cursor:default}
.hb-combo-btn svg{color:var(--hb-fg3)}
.hb-combo-val{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.hb-combo-sub{font-size:11.5px;color:var(--hb-fg4)}
.hb-pop{position:fixed;z-index:1001;border-radius:12px;border:1px solid var(--hb-line);background:var(--hb-card);box-shadow:0 16px 40px -8px rgba(0,0,0,.3);overflow:hidden;animation:hb-rise .12s ease-out}
.hb-pop-search{padding:8px;border-bottom:1px solid var(--hb-line)}
.hb-pop-search input{width:100%;box-sizing:border-box;height:32px;border-radius:8px;border:1px solid var(--hb-line);background:transparent;color:inherit;font:inherit;font-size:13px;padding:0 10px;outline:none}
.hb-pop-search input:focus{border-color:var(--hb-accent)}
.hb-pop-list{max-height:260px;overflow-y:auto;padding:4px}
.hb-pop-group{padding:8px 10px 4px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--hb-fg4)}
.hb-pop-opt{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;font-size:13px;cursor:pointer;color:var(--hb-fg2)}
.hb-pop-opt.hb-active{background:color-mix(in srgb,var(--hb-accent) 12%,transparent);color:var(--hb-fg)}
.hb-pop-opt[aria-selected=true]{color:var(--hb-fg);font-weight:550}
.hb-pop-check{width:14px;color:var(--hb-accent);font-size:12px}
.hb-pop-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hb-pop-hint{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--hb-line);color:var(--hb-fg4)}
.hb-pop-empty{padding:14px;text-align:center;color:var(--hb-fg4);font-size:12.5px}
.hb-spin-light{border-color:rgba(255,255,255,.35);border-top-color:#fff}
.hb-note{font-size:12px;color:var(--hb-fg3)}
.hb-list{flex:1;min-height:0;overflow-y:auto;padding:4px 18px 18px;display:flex;flex-direction:column;gap:14px}
.hb-listgroup{display:flex;flex-direction:column;gap:6px}
.hb-listhead{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--hb-fg3);padding:0 2px}
.hb-list .hb-card{padding:9px 12px}
.hb-list .hb-preview{-webkit-line-clamp:1}
.hb-profiles{display:flex;gap:6px;flex-wrap:wrap;padding:0 18px 10px}
.hb-pchip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--hb-line);background:transparent;color:var(--hb-fg2);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.hb-pchip:hover{color:var(--hb-fg)}
.hb-pchip[aria-pressed=true]{border-color:var(--hb-accent);color:var(--hb-fg);background:color-mix(in srgb,var(--hb-accent) 10%,transparent)}
.hb-pchip.hb-perr{border-style:dashed}
.hb-pdot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.hb-pcount{color:var(--hb-fg4);font-size:11px}
.hb-pneeds{min-width:16px;padding:0 5px;border-radius:999px;background:var(--hb-needs);color:#1d1d1f;font-size:10.5px;font-weight:600;line-height:16px;text-align:center}
.hb-pactive{color:var(--hb-accent);font-size:8px}
.hb-ptag{display:inline-flex;align-items:center;gap:4px;max-width:140px;min-width:0;padding:1px 7px;border-radius:999px;border:1px solid var(--hb-line);color:var(--hb-fg3);font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;flex:none;box-sizing:border-box}
.hb-ptag .hb-pdot{flex:none}
.hb-ptag-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.hb-pchip-label{min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.hb-vbar .hb-ptag{max-width:200px}
.hb-ghost{flex:none;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--hb-fg2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.hb-ghost:hover{background:color-mix(in srgb,currentColor 7%,transparent);color:var(--hb-fg)}
.hb-settings{display:flex;flex-direction:column;gap:12px;padding:4px 0;font-size:13px}
.hb-settings label{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--hb-line);border-radius:8px;cursor:pointer}
.hb-sb{display:inline-flex;align-items:center;gap:5px;padding:0 6px;border:0;background:transparent;color:var(--ui-text-tertiary,inherit);font:inherit;font-size:11px;cursor:pointer}
.hb-sb.hb-hot{color:var(--hb-needs,#e8a317)}
`

function injectStyles(ctx) {
  if (typeof document === 'undefined') return
  const el = document.createElement('style')
  el.id = `${PLUGIN_ID}-styles`
  el.textContent = CSS
  document.head.appendChild(el)
  ctx.onDispose(() => el.remove())
}

// ── icons ─────────────────────────────────────────────────────────────────────────────────

const ICONS = {
  sparkle: 'M8 1.5l1.4 4.1L13.5 7 9.4 8.4 8 12.5 6.6 8.4 2.5 7l4.1-1.4z',
  warn: 'M8 2l6.5 11.5h-13zM8 6.5v3.2M8 11.6v.2',
  chat: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z',
  ext: 'M9.5 2.5h4v4M13.5 2.5L7.5 8.5M11.5 9.5v3.5h-9v-9H6',
  board: 'M2.5 3h3v10h-3zM6.5 3h3v6h-3zM10.5 3h3v8h-3z',
  list: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  refresh: 'M13 4.5V2m0 2.5h-2.5M13 4.5A5.5 5.5 0 102.8 9.5',
  stop: 'M4.5 4.5h7v7h-7z',
  send: 'M2.5 8l11-5.5-4 11-2-4.5z',
  x: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  chevron: 'M4.5 6.5L8 10l3.5-3.5',
  arrowUp: 'M8 13V3.5M3.5 8L8 3.5 12.5 8',
  expand: 'M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  trash: 'M2.5 4.5h11M6.5 4.5V2.5h3v2M4 4.5l.7 9h6.6l.7-9M6.7 7v4.5M9.3 7v4.5',
  panel: 'M2.5 3.5h11v9h-11zM10 3.5v9'
}

function Icon({ name, size = 13, fill = false }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, style: { flex: 'none' } },
    h('path', { d: ICONS[name], fill: fill ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: fill ? 0 : 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

// ── react glue ────────────────────────────────────────────────────────────────────────────

function useBoard(board) {
  useSyncExternalStore(board.subscribe, board.getVersion, board.getVersion)
}

// ── card motion ──
//
// After every render, compare each card's column / slot with the previous render:
//   column changed → a clone flies from the old rect to the new one on top of everything (the
//                    columns scroll, so the card itself would be clipped mid-flight), then the
//                    card lands with a ring in its new column's colour;
//   slot changed   → FLIP: the card slides from its old position within the column;
//   new card       → fades in.
// Rects come from the previous render, so nothing is measured on a timer.
const FLY_MS = 560
const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function useCardMotion(rootRef, layoutKey) {
  const prev = useRef(null)
  const prevLayout = useRef(layoutKey)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const next = new Map()
    const slot = {}
    for (const el of root.querySelectorAll('[data-card-id]')) {
      const col = el.dataset.col
      slot[col] = (slot[col] ?? -1) + 1
      next.set(el.dataset.cardId, { el, col, idx: slot[col], rect: el.getBoundingClientRect() })
    }
    const before = prev.current
    prev.current = new Map([...next].map(([id, v]) => [id, { col: v.col, idx: v.idx, rect: v.rect }]))
    // First paint, a Board/List switch or reduced motion: just remember where things are.
    if (!before || prevLayout.current !== layoutKey || reducedMotion() || typeof root.animate !== 'function') {
      prevLayout.current = layoutKey
      return
    }
    for (const [id, cur] of next) {
      const old = before.get(id)
      if (!old) {
        cur.el.animate([{ opacity: 0, transform: 'translateY(6px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' })
      } else if (old.col !== cur.col) {
        flyCard(root, cur.el, old.rect, cur.rect)
      } else if (old.idx !== cur.idx) {
        const dx = old.rect.left - cur.rect.left
        const dy = old.rect.top - cur.rect.top
        if (Math.abs(dx) + Math.abs(dy) > 2) {
          cur.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' })
        }
      }
    }
  })
}

function flyCard(root, el, from, to) {
  const ghost = el.cloneNode(true)
  ghost.removeAttribute('data-card-id')
  ghost.classList.add('hb-ghost-card')
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` })
  root.appendChild(ghost)
  el.style.visibility = 'hidden'
  const dx = to.left - from.left
  const dy = to.top - from.top
  const anim = ghost.animate([
    { transform: 'translate(0, 0) scale(1) rotate(0deg)', width: `${from.width}px`, height: `${from.height}px` },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 24}px) scale(1.04) rotate(${dx > 0 ? 1.5 : -1.5}deg)`, offset: 0.45 },
    { transform: `translate(${dx}px, ${dy}px) scale(1) rotate(0deg)`, width: `${to.width}px`, height: `${to.height}px` }
  ], { duration: FLY_MS, easing: 'cubic-bezier(.3,.7,.2,1)' })
  const land = () => {
    ghost.remove()
    el.style.visibility = ''
    el.classList.remove('hb-arrived')
    void el.offsetWidth // restart the landing ring if it was already playing
    el.classList.add('hb-arrived')
    setTimeout(() => el.classList.remove('hb-arrived'), 1100)
  }
  anim.onfinish = land
  anim.oncancel = land
}

function useNow(active, ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return active ? now : Date.now()
}

const safeValue = atom => {
  try {
    return useValue(atom)
  } catch {
    return undefined
  }
}

function readStored(ctx, key, fallback) {
  try {
    return ctx.storage.get(key, fallback) ?? fallback
  } catch {
    return fallback
  }
}

function writeStored(ctx, key, value) {
  try {
    ctx.storage.set(key, value)
  } catch {}
}

// ── components ────────────────────────────────────────────────────────────────────────────

function BoardPage({ board, ctx }) {
  useBoard(board)
  const busyBySession = safeValue(host.state.busyBySession) || {}
  const [view, setView] = useState(() => readStored(ctx, 'view', 'board'))
  const [query, setQuery] = useState('')
  const [profileFilter, setProfileFilter] = useState(() => readStored(ctx, 'profileFilter', null))
  const [expanded, setExpanded] = useState({})
  const now = useNow(true, 1000)
  const rootRef = useRef(null)
  useCardMotion(rootRef, view)

  // The viewer belongs to this page: navigating away (sidebar, "open in Hermes") closes it, so coming
  // back shows the board, not a stale modal.
  useEffect(() => () => {
    if (board.state.viewing) board.closeViewer()
  }, [])

  useEffect(() => {
    void board.poll()
  }, [board])

  const all = board.items(busyBySession)
  const routes = board.state.routes.filter(r => !board.state.hidden.has(r.key))
  const filterKey = routes.some(r => r.key === profileFilter) ? profileFilter : null
  const pickProfile = key => {
    const next = key === filterKey ? null : key
    setProfileFilter(next)
    writeStored(ctx, 'profileFilter', next)
  }
  const q = query.trim().toLowerCase()
  const matching = q ? all.filter(i => `${i.title} ${i.preview} ${i.model} ${i.profileLabel}`.toLowerCase().includes(q)) : all
  const visible = filterKey ? matching.filter(i => i.routeKey === filterKey) : matching

  const byCol = Object.fromEntries(COLUMNS.map(c => [c.key, []]))
  for (const it of visible) if (byCol[it.column]) byCol[it.column].push(it)
  // Not-loaded (stored) sessions sink below live ones in the same column.
  const activityAt = it => Math.max(
    it.lastActive || 0,
    it.turn?.endedAt || 0,
    it.turn?.startedAt || 0,
    it.turn?.activity?.length ? it.turn.activity[it.turn.activity.length - 1].at : 0,
    ...it.requests.map(r => r.receivedAt || 0))
  // Columns whose cards update every second keep a stable key: Running by when the turn started
  // (tool events would reshuffle it constantly), Needs you by when the request arrived.
  const sortAt = it => it.column === 'running' ? (it.turn?.startedAt || it.lastActive || 0)
    : it.column === 'needs' && it.requests.length ? Math.max(...it.requests.map(r => r.receivedAt || 0))
    : activityAt(it)
  const recency = it => -sortAt(it) + (it.stored || it.quietMount ? 1e13 : 0)
  for (const list of Object.values(byCol)) list.sort((a, b) => recency(a) - recency(b) || a.title.localeCompare(b.title))

  const isOpen = it => (it.id in expanded ? expanded[it.id] : it.column === 'needs')
  const toggle = it => setExpanded(e => ({ ...e, [it.id]: !isOpen(it) }))
  const pickView = v => {
    setView(v)
    writeStored(ctx, 'view', v)
  }

  const [doomed, setDoomed] = useState(null) // card waiting on the delete confirmation
  const renderCard = it => h(Card, { key: it.id, item: it, board, now, multiProfile: routes.length > 1, open: isOpen(it), onToggle: () => toggle(it), onDelete: () => setDoomed(it) })

  return h('div', { className: 'hb-root', ref: rootRef },
    h('div', { className: 'hb-head' },
      h('div', { className: 'hb-crumb' }, h('span', null, 'Agents'), h('span', { className: 'hb-sep' }, '/'), h('b', null, 'SpanWall')),
      h('div', { className: 'hb-stats' },
        byCol.needs.length > 0 && h('span', { className: 'hb-stat hb-c-needs' }, h(Icon, { name: 'warn', size: 11 }), `${byCol.needs.length} need you`),
        !board.state.connected && h('span', { className: 'hb-stat hb-warn' }, 'offline')),
      h('div', { className: 'hb-spacer' }),
      h('button', { className: 'hb-btn hb-primary', onClick: () => (board.state.compose ? board.closeComposer() : board.openComposer(filterKey)) }, '+ New task'),
      h('div', { className: 'hb-searchbox' },
        h('input', { className: 'hb-search', placeholder: 'Filter sessions…', value: query, onChange: e => setQuery(e.target.value),
          onKeyDown: e => e.key === 'Escape' && query && (e.stopPropagation(), setQuery('')) }),
        query && h('button', { type: 'button', className: 'hb-search-clear', title: 'Clear search (Esc)', 'aria-label': 'Clear search',
          onMouseDown: e => e.preventDefault(), // keep focus in the input
          onClick: () => setQuery('') }, h(Icon, { name: 'x', size: 11 }))),
      h('button', { className: 'hb-iconbtn', title: 'Refresh (reload profiles + saved sessions)', onClick: () => void board.refresh() }, h(Icon, { name: 'refresh' })),
      h('div', { className: 'hb-seg', role: 'group' },
        h('button', { 'aria-pressed': view === 'board', onClick: () => pickView('board') }, h(Icon, { name: 'board' }), 'Board'),
        h('button', { 'aria-pressed': view === 'list', onClick: () => pickView('list') }, h(Icon, { name: 'list' }), 'List'))),
    board.state.lastError && h('div', { className: 'hb-banner' }, `Could not read sessions from the gateway: ${board.state.lastError}`),
    routes.length > 1 && h(ProfileBar, { items: matching, routes, filterKey, onPick: pickProfile }),
    board.state.viewing && h(SessionModal, { key: board.state.viewing, board, ctx,
      item: all.find(i => i.live && i.key === board.state.viewingKey) || all.find(i => i.id === board.state.viewing) || null }),
    doomed && h(DeleteDialog, { key: doomed.id, board, item: all.find(i => i.id === doomed.id) || doomed, onClose: () => setDoomed(null) }),
    board.state.compose && h(NewTaskPanel, { key: board.state.compose.at, board, ctx, initialRouteKey: board.state.compose.routeKey || filterKey }),
    view === 'board'
      ? h('div', { className: 'hb-board' },
          COLUMNS.map(col => h('section', { key: col.key, className: 'hb-col', 'aria-label': col.label },
            h('div', { className: 'hb-colhead', title: col.hint },
              h('span', { className: `hb-c-${col.key}` }, h(Icon, { name: 'sparkle', size: 12, fill: true })),
              h('span', { className: 'hb-collabel' }, col.label),
              h('span', { className: 'hb-count' }, byCol[col.key].length)),
            h('div', { className: 'hb-colbody' },
              byCol[col.key].length ? byCol[col.key].map(renderCard) : h('div', { className: 'hb-empty' }, col.hint)))))
      : h('div', { className: 'hb-list' },
          COLUMNS.filter(col => byCol[col.key].length).map(col => h('div', { key: col.key, className: 'hb-listgroup' },
            h('div', { className: 'hb-listhead' }, h('span', { className: `hb-c-${col.key}` }, h(Icon, { name: 'sparkle', size: 11, fill: true })), col.label, h('span', { className: 'hb-count' }, byCol[col.key].length)),
            byCol[col.key].map(renderCard))),
          !visible.length && h('div', { className: 'hb-empty' }, q ? 'No sessions match.' : 'No open sessions yet.')))
}

// ── new task ──

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const randomKey = () => (globalThis.crypto?.randomUUID?.() || `hb-${Date.now()}-${Math.random().toString(16).slice(2)}`)

// Create a session on a chosen profile, optionally with its first prompt. "Advanced" carries the
// knobs Hermes offers when opening a session (session.create params): model/provider, reasoning
// effort, fast tier, working directory, title.
function NewTaskPanel({ board, ctx, initialRouteKey }) {
  const routes = board.state.routes.filter(r => !board.state.hidden.has(r.key))
  const pickDefault = () => {
    const remembered = readStored(ctx, 'lastTaskProfile', null)
    return [initialRouteKey, remembered].find(k => k && routes.some(r => r.key === k)) || routes.find(r => r.active)?.key || routes[0]?.key || ''
  }
  // Every way of closing (Esc, backdrop, ×, the toolbar button) keeps an unsent draft for next time.
  const [draft] = useState(() => {
    const d = board.state.draft
    return d && routes.some(r => r.key === d.routeKey) ? d : null
  })
  const [routeKey, setRouteKey] = useState(() => draft?.routeKey || pickDefault())
  const [prompt, setPrompt] = useState(draft?.prompt || '')
  const [title, setTitle] = useState(draft?.title || '')
  const [advanced, setAdvanced] = useState(() => readStored(ctx, 'taskAdvancedOpen', false))
  const [modelSel, setModelSel] = useState(draft?.modelSel || '')
  const [effort, setEffort] = useState(draft?.effort || '')
  const [fast, setFast] = useState(draft?.fast || '')
  const [cwd, setCwd] = useState(draft?.cwd || '')
  const [openAfter, setOpenAfter] = useState(() => readStored(ctx, 'taskOpenAfter', false))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const idem = useRef(randomKey())
  const promptRef = useRef(null)

  const route = routes.find(r => r.key === routeKey)
  const models = board.state.models.get(routeKey)
  useEffect(() => {
    if (routeKey) void board.loadModels(routeKey)
  }, [routeKey, board])
  // A restored draft opens with the caret at its end (typing continues it) and the box sized to fit.
  useEffect(() => {
    const el = promptRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
    if (end) {
      el.style.height = `${Math.min(el.scrollHeight, 260)}px`
      el.scrollTop = el.scrollHeight
    }
  }, [])
  // A model list belongs to one profile: switching profile resets the pick.
  const pickRoute = k => {
    if (k !== routeKey) setModelSel('')
    setRouteKey(k)
  }

  const [provider, model] = modelSel ? modelSel.split('\u0000') : ['', '']
  const caps = model ? models?.providers?.find(p => p.slug === provider)?.capabilities?.[model] : null
  // A model without the knob gets the default, not what was picked for the previous model.
  const noReasoning = Boolean(caps && caps.reasoning === false)
  const noFast = Boolean(caps && !caps.fast)
  useEffect(() => {
    if (noReasoning) setEffort('')
  }, [noReasoning])
  useEffect(() => {
    if (noFast) setFast('')
  }, [noFast])

  const created = useRef(false)
  const fieldsRef = useRef(null)
  fieldsRef.current = { routeKey, prompt, title, modelSel, effort, fast, cwd }
  useEffect(() => () => {
    const f = fieldsRef.current
    board.state.draft = created.current || !(f.prompt.trim() || f.title.trim() || f.cwd.trim()) ? null : f
  }, [board])
  const close = () => !busy && board.closeComposer()
  const empty = !prompt.trim()
  const [attempted, setAttempted] = useState(false)
  const comboEscape = useRef(null) // set by the model list while it is open
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    const onKey = e => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      if (comboEscape.current) comboEscape.current()
      else closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const toggleAdvanced = () => {
    setAdvanced(v => !v)
    writeStored(ctx, 'taskAdvancedOpen', !advanced)
  }

  const submit = async () => {
    if (busy || !routeKey) return
    if (empty) {
      setAttempted(true)
      setError(null)
      promptRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await board.createSession(routeKey, {
        prompt, title, model, provider, cwd, openAfter, idempotencyKey: idem.current,
        reasoningEffort: noReasoning ? '' : effort,
        fast: noFast ? '' : fast
      })
      created.current = true
      writeStored(ctx, 'lastTaskProfile', routeKey)
      writeStored(ctx, 'taskOpenAfter', openAfter)
      host.notify({ kind: 'success', message: `Session created on profile ${route?.label || routeKey}` })
      board.closeComposer()
    } catch (err) {
      setError(errorText(err))
      // Only a failed create makes the retry a new request; if the session exists, reuse the key.
      if (!err?.created) idem.current = randomKey()
    } finally {
      setBusy(false)
    }
  }

  const modelGroups = (models?.providers || []).map(p => ({
    label: p.name,
    options: p.models.map(m => ({ value: `${p.slug}\u0000${m}`, label: m, hint: p.capabilities?.[m]?.fast ? 'fast' : '' }))
  }))
  const profileGroups = [{
    label: null,
    options: routes.map(r => ({
      value: r.key,
      label: r.label,
      icon: h('span', { className: 'hb-pdot', style: { background: profileHue(r.profile) } }),
      hint: r.error ? 'unreachable' : r.active ? 'current' : '',
      warn: Boolean(r.error),
      title: r.error ? `Unreachable: ${r.error}` : r.label
    }))
  }]

  return h('div', { className: 'hb-modal-backdrop', onMouseDown: e => e.target === e.currentTarget && close() },
    h('div', { className: 'hb-modal hb-taskmodal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'hb-modal-title' },
      h('div', { className: 'hb-modal-head' },
        h('div', { id: 'hb-modal-title', className: 'hb-modal-title' }, 'New task'),
        h('button', { className: 'hb-ghost', title: 'Close (Esc)', onClick: close }, h(Icon, { name: 'x', size: 15 }))),

      h('div', { className: 'hb-modal-body' },
        // The composer: one box — the task text, then profile + model + send on its bottom row.
        h('div', { className: `hb-tbox${attempted && empty ? ' hb-invalid' : ''}${busy ? ' hb-busy' : ''}` },
          h('textarea', {
            ref: promptRef, className: 'hb-tbox-input', rows: 3, value: prompt, disabled: busy,
            required: true, 'aria-label': 'Task prompt', 'aria-required': true, 'aria-invalid': attempted && empty,
            'aria-describedby': attempted && empty ? 'hb-prompt-err' : undefined,
            placeholder: 'What should the agent do?',
            onChange: e => {
              setPrompt(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 260)}px`
            },
            onKeyDown: e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
                e.preventDefault()
                void submit()
              }
            }
          }),
          h('div', { className: 'hb-tbox-bar' },
            h('button', { type: 'button', className: `hb-tbox-plus${advanced ? ' hb-on' : ''}`, title: advanced ? 'Hide advanced options' : 'Advanced options', 'aria-expanded': advanced, onClick: toggleAdvanced },
              h(Icon, { name: 'plus', size: 15 })),
            h(Combo, {
              variant: 'pill', searchable: routes.length > 6, minPopWidth: 220,
              escapeRef: comboEscape,
              value: routeKey, onChange: pickRoute, disabled: busy,
              groups: profileGroups, placeholder: 'Search profiles…', title: 'Profile to run the task'
            }),
            h(Combo, {
              variant: 'pill', minPopWidth: 300, className: 'hb-combo-bare',
              escapeRef: comboEscape,
              value: modelSel, onChange: setModelSel, disabled: busy,
              loading: models?.loading, loadingLabel: 'Loading models…',
              error: models?.error ? `Could not load models: ${models.error}` : null,
              defaultLabel: models?.model ? `Default · ${models.model}` : 'Default model',
              groups: modelGroups, placeholder: 'Search models…', emptyLabel: 'No models match', title: 'Model'
            }),
            h('span', { className: 'hb-spacer' }),
            h('button', { type: 'button', className: 'hb-tbox-send', disabled: busy || !routeKey || empty,
              title: empty ? 'Enter a task prompt first' : 'Create & run (Enter)', 'aria-label': 'Create & run', onClick: () => void submit() },
              busy ? h('span', { className: 'hb-spin hb-spin-light' }) : h(Icon, { name: 'arrowUp', size: 16 })))),
        attempted && empty
          ? h('div', { id: 'hb-prompt-err', className: 'hb-field-err', role: 'alert' }, 'Enter a task prompt before creating it.')
          : h('div', { className: 'hb-tbox-hint' }, 'Enter to create · Shift+Enter for a new line · Esc to close (the draft is kept)'),

        advanced && h('div', { className: 'hb-adv' },
          h('div', { className: 'hb-adv-grid' },
            h('label', { className: 'hb-section' },
              h('span', { className: 'hb-flabel' }, 'Title'),
              h('input', { className: 'hb-field-input', value: title, disabled: busy, placeholder: 'Derived from the prompt if empty', onChange: e => setTitle(e.target.value) })),
            h('label', { className: 'hb-section' },
              h('span', { className: 'hb-flabel' }, 'Working directory'),
              h('input', { className: 'hb-field-input hb-mono', value: cwd, disabled: busy, placeholder: "profile's terminal.cwd", onChange: e => setCwd(e.target.value) }))),
          h('div', { className: 'hb-section' },
            h('div', { className: 'hb-flabel' }, 'Reasoning effort', caps && caps.reasoning === false && h('span', { className: 'hb-flabel-note' }, ' · not supported by this model')),
            h(Segmented, { value: noReasoning ? '' : effort, onChange: setEffort, disabled: busy || noReasoning,
              options: [{ value: '', label: 'Default' }, ...EFFORTS.map(x => ({ value: x, label: x }))] })),
          h('div', { className: 'hb-section' },
            h('div', { className: 'hb-flabel' }, 'Fast mode', caps && !caps.fast && h('span', { className: 'hb-flabel-note' }, ' · this model has no fast tier')),
            h(Segmented, { value: noFast ? '' : fast, onChange: setFast, disabled: busy || noFast,
              options: [{ value: '', label: 'Default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] })),
          h('label', { className: 'hb-switch-row' },
            h('span', { className: `hb-switch${openAfter ? ' hb-on' : ''}` },
              h('input', { type: 'checkbox', checked: openAfter, onChange: e => setOpenAfter(e.target.checked) })),
            'Open the session in Hermes after creating it')),

        error && h('div', { className: 'hb-modal-err' }, error))))
}


function Segmented({ value, onChange, options, disabled }) {
  return h('div', { className: `hb-seg2${disabled ? ' hb-disabled' : ''}`, role: 'radiogroup' },
    options.map(o => h('button', {
      key: o.value || 'default', type: 'button', role: 'radio', 'aria-checked': value === o.value, disabled,
      className: value === o.value ? 'hb-on' : '', onClick: () => onChange(o.value)
    }, o.label)))
}

// Grouped listbox in a drawn popover (a native <select>'s OS popup can't be styled and renders badly
// inside Electron). `variant: 'pill'` is the compact trigger the task composer uses; options may carry
// an `icon`; `searchable: false` drops the filter box for short lists; `defaultLabel: null` means
// there is no "default" row.
function Combo({ value, onChange, groups, defaultLabel = null, placeholder = 'Search…', disabled, loading, loadingLabel = 'Loading…', error, escapeRef, variant = 'field', searchable = true, minPopWidth = 260, emptyLabel = 'No matches', title, className = '' }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState(null)
  const rootRef = useRef(null)
  const btnRef = useRef(null)
  const searchRef = useRef(null)
  const popRef = useRef(null)
  const listRef = useRef(null)

  const close = (refocus = true) => {
    setOpen(false)
    setQuery('')
    if (refocus) btnRef.current?.focus()
  }

  useEffect(() => {
    if (!escapeRef || !open) return undefined
    escapeRef.current = () => close()
    return () => {
      escapeRef.current = null
    }
  }, [open, escapeRef])

  // Fixed-position popover anchored to the trigger: the modal body scrolls, and an absolutely
  // positioned list would be clipped by it. Flip above when the space below is short; keep it on screen.
  useEffect(() => {
    if (!open) return undefined
    const measure = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      const width = Math.min(Math.max(r.width, minPopWidth), window.innerWidth - 16)
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      const below = window.innerHeight - r.bottom
      const up = below < 300 && r.top > below
      setPlace({ left, width, ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }), maxList: Math.max(120, Math.min(300, (up ? r.top : below) - (searchable ? 70 : 24))) })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, minPopWidth, searchable])

  const all = groups.flatMap(g => g.options.map(o => ({ ...o, group: g.label || null })))
  const q = query.trim().toLowerCase()
  const flat = []
  if (defaultLabel != null && (!q || defaultLabel.toLowerCase().includes(q))) flat.push({ value: '', label: defaultLabel, group: null })
  for (const o of all) if (!q || `${o.label} ${o.group || ''} ${o.hint || ''}`.toLowerCase().includes(q)) flat.push(o)
  const selected = all.find(o => o.value === value) || null

  useEffect(() => {
    if (!open) return undefined
    const onDown = e => rootRef.current && !rootRef.current.contains(e.target) && !popRef.current?.contains(e.target) && close(false)
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const placed = Boolean(open && place)
  useEffect(() => {
    if (!placed) return
    if (searchable) searchRef.current?.focus()
    else popRef.current?.focus()
  }, [placed, searchable])
  // Open on the current choice; typing restarts from the top.
  useEffect(() => {
    if (open) setActive(Math.max(0, flat.findIndex(o => o.value === value)))
  }, [open])
  useEffect(() => {
    if (query) setActive(0)
  }, [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, placed])

  const choose = v => {
    onChange(v)
    close()
  }
  const onKey = e => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive(i => Math.min(i + 1, flat.length - 1)))
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive(i => Math.max(i - 1, 0)))
    else if (e.key === 'Enter') (e.preventDefault(), flat[active] && choose(flat[active].value))
    else if (e.key === 'Tab') close(false)
  }

  const shown = loading ? loadingLabel : selected ? selected.label : defaultLabel ?? 'Choose…'
  let lastGroup
  return h('div', { className: `hb-combo hb-combo-${variant} ${className}`, ref: rootRef },
    h('button', { ref: btnRef, type: 'button', className: `hb-combo-btn${open ? ' hb-open' : ''}`, disabled: disabled || loading, title: title || shown,
      'aria-haspopup': 'listbox', 'aria-expanded': open,
      onClick: () => (open ? close(false) : setOpen(true)),
      onKeyDown: e => (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !open && (e.preventDefault(), setOpen(true)) },
      selected?.icon,
      h('span', { className: 'hb-combo-val' },
        h('span', { className: 'hb-combo-text' }, shown),
        variant === 'field' && selected?.group && h('span', { className: 'hb-combo-sub' }, selected.group)),
      h(Icon, { name: 'chevron', size: 12 })),
    variant === 'field' && error && h('div', { className: 'hb-flabel-note hb-c-failed' }, error),
    open && place && h('div', { ref: popRef, className: 'hb-pop', tabIndex: -1, onKeyDown: onKey, style: { left: place.left, width: place.width, top: place.top, bottom: place.bottom } },
      searchable && h('div', { className: 'hb-pop-search' },
        h('input', { ref: searchRef, value: query, placeholder, onChange: e => setQuery(e.target.value), 'aria-label': placeholder })),
      error && h('div', { className: 'hb-pop-empty hb-c-failed' }, error),
      h('div', { className: 'hb-pop-list', role: 'listbox', ref: listRef, style: { maxHeight: place.maxList } },
        !flat.length && h('div', { className: 'hb-pop-empty' }, emptyLabel),
        flat.map((o, i) => {
          const head = o.group && o.group !== lastGroup ? h('div', { key: `g-${o.group}`, className: 'hb-pop-group' }, o.group) : null
          lastGroup = o.group
          return h(Fragment, { key: o.value || 'default' },
            head,
            h('div', {
              role: 'option', 'aria-selected': o.value === value, 'data-idx': i,
              className: `hb-pop-opt${i === active ? ' hb-active' : ''}${o.warn ? ' hb-pop-warn' : ''}`,
              title: o.title,
              onMouseEnter: () => setActive(i),
              onMouseDown: e => (e.preventDefault(), choose(o.value))
            },
              h('span', { className: 'hb-pop-check' }, o.value === value ? '✓' : ''),
              o.icon,
              h('span', { className: 'hb-pop-label' }, o.label),
              o.hint && h('span', { className: 'hb-pop-hint' }, o.hint)))
        }))))
}


// One chip per profile route: filter on click, with live / needs counts and reachability.
function ProfileBar({ items, routes, filterKey, onPick }) {
  const stats = list => ({
    cards: list.length,
    live: list.filter(i => i.live).length,
    stored: list.filter(i => i.stored).length,
    needs: list.filter(i => i.column === 'needs').length
  })
  const breakdown = s => `${s.cards} cards: ${s.live} live · ${s.stored} saved · ${s.cards - s.live - s.stored} closed${s.needs ? ` · ${s.needs} need you` : ''}`
  const total = stats(items)
  return h('div', { className: 'hb-profiles', role: 'toolbar', 'aria-label': 'Profiles' },
    h('button', { className: 'hb-pchip', 'aria-pressed': !filterKey, title: breakdown(total), onClick: () => onPick(null) },
      'All profiles', h('span', { className: 'hb-pcount' }, total.cards),
      total.needs > 0 && h('span', { className: 'hb-pneeds' }, total.needs)),
    routes.map(r => {
      const s = stats(items.filter(i => i.routeKey === r.key))
      return h('button', {
        key: r.key,
        className: `hb-pchip${r.error ? ' hb-perr' : ''}`,
        'aria-pressed': filterKey === r.key,
        title: r.error ? `Unreachable: ${r.error}` : `${r.label}${r.active ? ' (current)' : ''} — ${breakdown(s)}`,
        onClick: () => onPick(r.key)
      },
        h('span', { className: 'hb-pdot', style: { background: profileHue(r.profile) } }),
        h('span', { className: 'hb-pchip-label' }, r.label),
        r.active && h('span', { className: 'hb-pactive' }, '●'),
        h('span', { className: 'hb-pcount' }, s.cards),
        s.needs > 0 && h('span', { className: 'hb-pneeds' }, s.needs),
        r.error && h('span', { className: 'hb-c-failed' }, '!'))
    }))
}

function ProfileTag({ item }) {
  if (!item.profileLabel) return null
  return h('span', { className: 'hb-ptag', title: `Profile: ${item.profileLabel}` },
    h('span', { className: 'hb-pdot', style: { background: profileHue(item.profile) } }),
    h('span', { className: 'hb-ptag-label' }, item.profileLabel))
}

function StatusLine({ item, now }) {
  const t = item.turn
  switch (item.column) {
    case 'needs': {
      const since = item.requests[0]?.receivedAt || now
      return h('span', { className: 'hb-state' }, h('span', { className: 'hb-c-needs' }, h(Icon, { name: 'warn', size: 12 })), `Waiting for you · ${fmtElapsed(now - since)}`)
    }
    case 'running':
      return h('span', { className: 'hb-state' }, h('span', { className: 'hb-spin' }), fmtElapsed(now - (t?.startedAt || item.lastActive || now)))
    case 'done':
      return h('span', { className: 'hb-state' }, h('span', { className: 'hb-dot hb-c-done' }), t?.startedAt && t.endedAt - t.startedAt >= 1000 ? fmtElapsed(t.endedAt - t.startedAt) : 'Done', h('span', { style: { color: 'var(--hb-fg4)' } }, `· ${fmtAgo(t?.endedAt, now)}`))
    case 'failed':
      return h('span', { className: 'hb-state' }, h('span', { className: 'hb-dot hb-c-failed' }), h('span', { className: 'hb-c-failed' }, 'Failed'), h('span', { style: { color: 'var(--hb-fg4)' } }, `· ${fmtAgo(t?.endedAt, now)}`))
    default:
      return h('span', { className: 'hb-state' }, h('span', { className: 'hb-dot hb-c-idle' }), item.stored ? 'Saved' : item.sessionStatus === 'idle' ? 'Idle' : item.sessionStatus, item.lastActive ? h('span', { style: { color: 'var(--hb-fg4)' } }, `· ${fmtAgo(item.lastActive, now)}`) : null)
  }
}

function cardPreview(item) {
  const t = item.turn
  if (item.column === 'needs') return requestSummary(item.requests[0])
  if (item.column === 'running') {
    // Who is working and on what — not the raw stream, which churns too fast to read on a card.
    const cur = t?.activity.filter(a => a.kind === 'tool' && !a.done).at(-1)
    const phase = cur ? `Running ${cur.label}` : t?.statusText || (t?.stream ? 'Writing a reply…' : 'Thinking…')
    return h(Fragment, null, h('span', { className: 'hb-who' }, item.profileLabel || 'Hermes'), ` · ${phase}`)
  }
  if (item.column === 'failed') return t?.error || item.preview
  if (item.column === 'done') return oneLine(t?.text || item.preview)
  return item.preview
}

function Card({ item, board, now, multiProfile, open, onToggle, onDelete }) {
  const header = h('div', { className: 'hb-cardhead', onClick: onToggle, role: 'button', 'aria-expanded': open, tabIndex: 0, onKeyDown: e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle()) },
    h('span', { className: `hb-c-${item.column}`, style: { marginTop: 2 } }, h(Icon, { name: 'sparkle', size: 13, fill: true })),
    h('span', { className: 'hb-title' },
      h('button', { type: 'button', className: 'hb-title-btn', title: `${item.title} — xem session`,
        onClick: e => (e.stopPropagation(), board.openViewer(item)),
        onKeyDown: e => e.stopPropagation() // Enter/Space open the session, not the card toggle
      }, item.title)),
    // Actions float over the title's end on hover, so the title keeps the full card width.
    h('span', { className: 'hb-card-actions' },
      h('button', { className: 'hb-ext', title: 'View session', onClick: e => (e.stopPropagation(), board.openViewer(item)) }, h(Icon, { name: 'expand', size: 12 })),
      h('button', { className: 'hb-ext', title: 'Open in Hermes', onClick: e => (e.stopPropagation(), void board.open(item)) }, h(Icon, { name: 'ext', size: 12 })),
      onDelete && h('button', { className: 'hb-ext hb-ext-danger', title: 'Delete session', onClick: e => (e.stopPropagation(), onDelete()) }, h(Icon, { name: 'trash', size: 12 }))))

  return h('article', { className: `hb-card${open ? ' hb-sel' : ''}${item.column === 'running' ? ' hb-running' : ''}`, 'data-card-id': item.id, 'data-col': item.column },
    header,
    h('div', { className: 'hb-preview' }, cardPreview(item) || h('span', { style: { color: 'var(--hb-fg4)' } }, 'No preview')),
    // Footer: one fixed line so every card keeps the same shape whatever the profile name's length.
    h('div', { className: 'hb-meta' },
      h(StatusLine, { item, now }),
      item.messageCount != null && h('span', { className: 'hb-m', title: 'Messages' }, h(Icon, { name: 'chat', size: 12 }), item.messageCount),
      multiProfile && h('span', { className: 'hb-meta-end' }, h(ProfileTag, { item }))),
    open && h(CardBody, { item, board, now }))
}

// ── delete confirmation ──

function DeleteDialog({ board, item, onClose }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const cancelRef = useRef(null)
  const busyRef = useRef(false)
  busyRef.current = busy
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    cancelRef.current?.focus() // the safe choice holds the focus
    const onKey = e => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      if (!busyRef.current) closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await board.remove(item)
      host.notify({ kind: 'info', message: outcome === 'already' ? 'Session was already deleted' : outcome === 'local' ? 'Removed from the board (Hermes had not stored this session)' : 'Session deleted' })
      onClose()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const stops = item.live && (item.column === 'running' || item.requests.length > 0)
  return h('div', { className: 'hb-modal-backdrop', onMouseDown: e => e.target === e.currentTarget && !busy && onClose() },
    h('div', { className: 'hb-modal hb-confirm', role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'hb-del-title', 'aria-describedby': 'hb-del-desc' },
      h('div', { className: 'hb-modal-head' }, h('div', null, h('div', { id: 'hb-del-title', className: 'hb-modal-title' }, 'Delete session?'))),
      h('div', { className: 'hb-modal-body' },
        h('p', { id: 'hb-del-desc', className: 'hb-confirm-text' },
          h('b', null, item.title), ' and its transcript will be permanently deleted',
          item.profileLabel ? h(Fragment, null, ' from ', h('b', null, item.profileLabel)) : null, ". This can't be undone."),
        stops && h('p', { className: 'hb-confirm-text hb-confirm-warn' }, h(Icon, { name: 'warn', size: 12 }),
          item.column === 'running' ? 'The running turn will be stopped first.' : 'Its pending request will be cancelled first.'),
        error && h('div', { className: 'hb-modal-err' }, `Could not delete the session: ${error}`),
        h('div', { className: 'hb-row hb-end' },
          h('button', { ref: cancelRef, className: 'hb-btn', disabled: busy, onClick: onClose }, 'Cancel'),
          h('button', { className: 'hb-btn hb-danger', disabled: busy, onClick: () => void confirm() },
            busy ? h('span', { className: 'hb-spin hb-spin-light' }) : h(Icon, { name: 'trash', size: 12 }), busy ? 'Deleting…' : 'Delete')))))
}

// ── session viewer ──

const fmtDayTime = ms => {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

const copyText = text => {
  try {
    void navigator.clipboard.writeText(text)
    host.notify({ kind: 'info', message: 'Copied' })
  } catch {}
}

// ── markdown (GFM subset, the way Hermes Desktop renders replies) ──
//
// Blocks: paragraphs, ATX headings, fenced code, nested ordered/unordered/task lists, blockquotes,
// tables, rules, `::directive{…}` lines. Inline: code, bold, italic, strikethrough, links, autolinks,
// images (as links). Reasoning blocks (<think>…) are dropped like Hermes does. Everything becomes
// React elements — no HTML from the transcript is ever injected.

const REASONING_TAGS = 'think|thinking|reasoning|thought|reasoning_scratchpad|scratchpad|analysis'
const REASONING_BLOCK_RE = new RegExp(`(?:<(${REASONING_TAGS})>[\\s\\S]*?<\\/\\1>\\s*)+`, 'gi')
const OPEN_REASONING_RE = new RegExp(`(^|\\n)[ \\t]*<(${REASONING_TAGS})>[\\s\\S]*$`, 'i')
const PREVIEW_MARKER_RE = /\[Preview:[^\]]+\]\(#preview[:/][^)]+\)/gi

let openLink = url => {
  try {
    window.open(url, '_blank', 'noopener')
  } catch {}
}
const SAFE_URL = /^(https?:|mailto:)/i

function preprocessMarkdown(src) {
  return String(src || '')
    .replace(/\r\n?/g, '\n')
    .replace(REASONING_BLOCK_RE, '')
    .replace(OPEN_REASONING_RE, '$1')
    .replace(PREVIEW_MARKER_RE, '')
}

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const RE_QUOTE = /^ {0,3}> ?/
const RE_LIST = /^( *)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/
const RE_TABLE_SEP = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/
const RE_DIRECTIVE = /^::[\w-]+(\{.*\})?\s*$/

const splitRow = line => {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

const startsBlock = (line, next) =>
  RE_FENCE.test(line) || RE_HR.test(line) || RE_HEADING.test(line) || RE_QUOTE.test(line) ||
  RE_LIST.test(line) || (line.includes('|') && next != null && RE_TABLE_SEP.test(next) && next.includes('-'))

function parseBlocks(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    let m
    if ((m = line.match(RE_FENCE))) {
      const marker = m[1]
      const body = []
      i++
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++])
      i++ // closing fence (or past the end while streaming)
      out.push({ t: 'code', lang: m[2] || '', text: body.join('\n') })
      continue
    }
    if (RE_HR.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }
    if ((m = line.match(RE_HEADING))) {
      out.push({ t: 'h', level: m[1].length, text: m[2] || '' })
      i++
      continue
    }
    if (RE_DIRECTIVE.test(line.trim())) {
      out.push({ t: 'directive', text: line.trim() })
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null))
      const rows = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]))
      out.push({ t: 'table', head, align, rows })
      continue
    }
    if (RE_QUOTE.test(line)) {
      const body = []
      while (i < lines.length && lines[i].trim() && (RE_QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) body.push(lines[i++].replace(RE_QUOTE, ''))
      out.push({ t: 'quote', children: parseBlocks(body) })
      continue
    }
    if ((m = line.match(RE_LIST))) {
      const baseIndent = m[1].length
      const ordered = /\d/.test(m[2])
      const start = ordered ? parseInt(m[2], 10) : 1
      const items = []
      while (i < lines.length) {
        const lm = lines[i].match(RE_LIST)
        if (!lm || lm[1].length !== baseIndent || /\d/.test(lm[2]) !== ordered) break
        const contentIndent = baseIndent + lm[2].length + (lm[3] ? lm[3].length : 1)
        const body = [lm[4]]
        i++
        // Continuation: indented lines (nested lists, wrapped text) and lazy paragraph lines.
        while (i < lines.length) {
          const l = lines[i]
          if (!l.trim()) {
            const nxt = lines[i + 1]
            if (nxt != null && nxt.trim() && nxt.match(/^ */)[0].length >= contentIndent) {
              body.push('')
              i++
              continue
            }
            break
          }
          const ind = l.match(/^ */)[0].length
          if (ind >= contentIndent) body.push(l.slice(contentIndent))
          else if (ind > baseIndent && RE_LIST.test(l)) body.push(l.slice(Math.min(ind, contentIndent)))
          else if (!RE_LIST.test(l) && !startsBlock(l, lines[i + 1])) body.push(l.trim())
          else break
          i++
        }
        let task = null
        const tm = body[0].match(/^\[([ xX])\]\s+(.*)$/)
        if (tm) {
          task = tm[1] !== ' '
          body[0] = tm[2]
        }
        items.push({ task, children: parseBlocks(body) })
        while (i < lines.length && !lines[i].trim() && lines[i + 1] && (lines[i + 1].match(RE_LIST) || [])[1]?.length === baseIndent) i++
      }
      out.push({ t: 'list', ordered, start, items })
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim())
    out.push({ t: 'p', text: para.join('\n') })
  }
  return out
}

// Inline groups: 1 escape · 2-3 code · 4-5 image · 6-7 link · 8 <autolink> · 9 bare url ·
// 10-11 bold · 12 strike · 13-14 italic
const INLINE_RE = /\\([\\`*_{}\[\]()#+\-.!|~<>])|(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)|!\[([^\]]*)\]\(\s*<?([^()\s>]+(?:\([^)\s]*\)[^()\s>]*)*)>?(?:\s+["'][^"']*["'])?\s*\)|\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^()\s>]*(?:\([^)\s]*\)[^()\s>]*)*)>?(?:\s+["'][^"']*["'])?\s*\)|<((?:https?:\/\/|mailto:)[^>\s]+)>|((?:https?:\/\/|www\.)[^\s<>"'`*]*[^\s<>"'`*.,;:!?)\]])|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__(?!\w)|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([^*]*?[^\s*])\*|(?<![\w])_(?=[^\s_])([^_]*?[^\s_])_(?![\w])/g

function Link({ href, children }) {
  const url = href.startsWith('www.') ? `https://${href}` : href
  if (!SAFE_URL.test(url)) return h('span', null, children)
  return h('a', { className: 'hb-link', href: url, title: url, onClick: e => (e.preventDefault(), openLink(url)) }, children)
}

function renderInline(text, keyBase = 'i') {
  const out = []
  const re = new RegExp(INLINE_RE.source, 'g')
  let last = 0
  let m
  let n = 0
  const lines = (s, k) => s.split('\n').flatMap((part, j) => (j ? [h('br', { key: `${k}b${j}` }), part] : [part]))
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...lines(text.slice(last, m.index), `${keyBase}t${n}`))
    const k = `${keyBase}-${n++}`
    if (m[1] != null) out.push(m[1])
    else if (m[3] != null) out.push(h('code', { key: k, className: 'hb-icode' }, m[3].trim() || m[3]))
    else if (m[5] != null) out.push(h(Link, { key: k, href: m[5] }, `🖼 ${m[4] || 'image'}`))
    else if (m[7] != null) out.push(h(Link, { key: k, href: m[7] }, renderInline(m[6], k)))
    else if (m[8] != null) out.push(h(Link, { key: k, href: m[8] }, m[8]))
    else if (m[9] != null) out.push(h(Link, { key: k, href: m[9] }, m[9]))
    else if (m[10] != null || m[11] != null) out.push(h('strong', { key: k }, renderInline(m[10] ?? m[11], k)))
    else if (m[12] != null) out.push(h('del', { key: k }, renderInline(m[12], k)))
    else if (m[13] != null || m[14] != null) out.push(h('em', { key: k }, renderInline(m[13] ?? m[14], k)))
    last = re.lastIndex
  }
  if (last < text.length) out.push(...lines(text.slice(last), `${keyBase}t${n}`))
  return out
}

function renderBlocks(blocks, keyBase = 'b') {
  return blocks.map((b, i) => {
    const k = `${keyBase}${i}`
    switch (b.t) {
      case 'p':
        return h('p', { key: k }, renderInline(b.text, k))
      case 'h':
        return h(`h${Math.min(b.level + 2, 6)}`, { key: k, className: `hb-mdh hb-mdh${b.level}` }, renderInline(b.text, k))
      case 'hr':
        return h('hr', { key: k })
      case 'code':
        return h('div', { key: k, className: 'hb-codeblock' },
          h('div', { className: 'hb-codehead' }, h('span', null, b.lang || 'code'),
            h('button', { className: 'hb-codecopy', onClick: () => copyText(b.text) }, h(Icon, { name: 'copy', size: 11 }), 'Copy')),
          h('pre', null, b.text))
      case 'quote':
        return h('blockquote', { key: k }, renderBlocks(b.children, k))
      case 'directive':
        return h('div', { key: k, className: 'hb-directive' }, b.text)
      case 'table':
        return h('div', { key: k, className: 'hb-tablewrap' },
          h('table', null,
            h('thead', null, h('tr', null, b.head.map((c, j) => h('th', { key: j, style: b.align[j] ? { textAlign: b.align[j] } : undefined }, renderInline(c, `${k}h${j}`))))),
            h('tbody', null, b.rows.map((r, ri) => h('tr', { key: ri }, b.head.map((_, j) => h('td', { key: j, style: b.align[j] ? { textAlign: b.align[j] } : undefined }, renderInline(r[j] || '', `${k}r${ri}c${j}`))))))))
      case 'list':
        return h(b.ordered ? 'ol' : 'ul', { key: k, start: b.ordered && b.start !== 1 ? b.start : undefined, className: b.items.some(it => it.task != null) ? 'hb-tasklist' : undefined },
          b.items.map((it, j) => {
            // A one-paragraph item renders tight (no <p> margins), like GFM's tight lists.
            const tight = it.children.length && it.children[0].t === 'p'
            const kids = tight
              ? [h(Fragment, { key: 'f' }, renderInline(it.children[0].text, `${k}l${j}`)), ...renderBlocks(it.children.slice(1), `${k}l${j}-`)]
              : renderBlocks(it.children, `${k}l${j}-`)
            return h('li', { key: j, className: it.task != null ? 'hb-task' : undefined },
              it.task != null && h('input', { type: 'checkbox', checked: it.task, readOnly: true, disabled: true }), kids)
          }))
      default:
        return null
    }
  })
}

function Markdown({ text }) {
  const blocks = parseBlocks(preprocessMarkdown(text).split('\n'))
  return h('div', { className: 'hb-md' }, renderBlocks(blocks))
}


// A render error inside the host's markdown pipeline must not take the board down: fall back to
// the built-in renderer for that one message.
class MarkdownBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidUpdate(prev) {
    if (prev.text !== this.props.text && this.state.failed) this.setState({ failed: false })
  }
  render() {
    return this.state.failed ? h(Markdown, { text: this.props.text }) : this.props.children
  }
}

// Message text the way Hermes renders it in chat. `MessageTextContent` is the SDK's canonical
// transcript renderer (streamdown + remark-gfm + Desktop transforms such as <think> stripping and
// MEDIA: players). A session owned by another profile is "foreign" history: its media paths would
// resolve against the active gateway, so it renders previewOnly without media, as the SDK asks.
// Older desktops without that export get sdk.Streamdown, then the built-in GFM renderer.
function RichText({ text, item }) {
  const value = String(text || '')
  const foreign = Boolean(item && !item.activeProfile)
  let body
  if (sdk.MessageTextContent) body = h(sdk.MessageTextContent, { text: value, media: !foreign, previewOnly: foreign })
  else if (sdk.Streamdown) body = h(sdk.Streamdown, null, preprocessMarkdown(value))
  else return h(Markdown, { text: value })
  return h(MarkdownBoundary, { text: value }, h('div', { className: 'hb-hostmd' }, body))
}

function TranscriptRow({ m, item, onExpand }) {
  const [open, setOpen] = useState(false)
  if (m.role === 'user') {
    return h('div', { className: 'hb-trow hb-trow-user' },
      h('div', { className: 'hb-ububble' }, clip(m.text, 20000)),
      m.at ? h('div', { className: 'hb-tmeta' }, fmtDayTime(m.at)) : null)
  }
  if (m.role === 'assistant') {
    return h('div', { className: 'hb-trow hb-trow-assistant' },
      h('div', { className: 'hb-aname' }, h('span', { className: 'hb-avatar' }, h(Icon, { name: 'sparkle', size: 11, fill: true })), 'Hermes', m.at ? h('span', { className: 'hb-tmeta' }, fmtDayTime(m.at)) : null),
      h('div', { className: 'hb-abody' }, h(RichText, { text: clip(m.text, 40000), item })))
  }
  const label = m.kind ? m.kind.replace(/[_-]+/g, ' ') : m.role || 'note'
  return h('div', { className: 'hb-trow hb-trow-system' },
    h('button', { className: 'hb-tool-head hb-sys-head', 'aria-expanded': open, onClick: () => {
      if (!open) onExpand?.()
      setOpen(v => !v)
    } },
      h('span', { className: 'hb-tool-ico' }, h(Icon, { name: 'chat', size: 11 })),
      h('span', { className: 'hb-tool-name' }, label),
      !open && h('span', { className: 'hb-tool-ctx hb-sys-preview' }, oneLine(m.text.replace(/[*_`#>~|]+/g, ''))),
      h('span', { className: `hb-caret${open ? ' hb-on' : ''}` }, h(Icon, { name: 'chevron', size: 11 }))),
    open && h('div', { className: 'hb-sys-body' }, h(RichText, { text: clip(m.text, 40000), item })))
}

// ── right-click Copy / Cut / Paste ──
//
// Hermes Desktop answers every right-click with its own app menu (a window capture listener that
// stops propagation), which portals into the viewer via its data-slot. This menu only runs on hosts
// without that listener.

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? '⌘' : 'Ctrl+'

// A text field the menu can edit: textarea / text-like input that exposes a selection range.
function textFieldOf(el) {
  const f = el?.closest?.('textarea, input')
  return f && typeof f.selectionStart === 'number' ? f : null
}

// Replace [start, end) of a field with `str` the way typing would, so React's onChange and undo see it.
function insertInto(el, start, end, str) {
  el.focus()
  try {
    el.setSelectionRange(start, end)
  } catch {}
  try {
    if (document.execCommand(str ? 'insertText' : 'delete', false, str)) return
  } catch {}
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, el.value.slice(0, start) + str + el.value.slice(end))
  el.setSelectionRange(start + str.length, start + str.length)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// What a right-click at `e` can act on, or null when there is nothing to offer.
function contextMenuAt(e) {
  const field = textFieldOf(e.target)
  if (field) {
    const start = field.selectionStart
    const end = field.selectionEnd
    const secret = field.type === 'password'
    const writable = !field.readOnly && !field.disabled
    const text = secret ? '' : field.value.slice(start, end)
    return { x: e.clientX, y: e.clientY, text, field, start, end, canCut: writable && Boolean(text), canPaste: writable }
  }
  const text = window.getSelection?.()?.toString() || ''
  return text ? { x: e.clientX, y: e.clientY, text, field: null, canCut: false, canPaste: false } : null
}

function ContextMenu({ menu, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({ left: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)) })
  }, [menu])
  useEffect(() => {
    const away = e => !ref.current?.contains(e.target) && onClose()
    const dismiss = () => onClose()
    window.addEventListener('mousedown', away, true)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('mousedown', away, true)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [onClose])

  const run = fn => async () => {
    onClose()
    try {
      await fn()
    } catch (err) {
      host.notifyError(err, 'Clipboard action failed')
    }
  }
  const { field, start, end, text } = menu
  const items = [
    field && { label: 'Cut', key: 'X', enabled: menu.canCut, act: async () => {
      await navigator.clipboard.writeText(text)
      insertInto(field, start, end, '')
    } },
    { label: 'Copy', key: 'C', enabled: Boolean(text), act: async () => {
      await navigator.clipboard.writeText(text)
      field?.focus()
    } },
    field && { label: 'Paste', key: 'V', enabled: menu.canPaste, act: async () => insertInto(field, start, end, await navigator.clipboard.readText()) }
  ].filter(Boolean)

  return h('div', { ref, className: 'hb-ctxmenu', role: 'menu', style: pos,
    onMouseDown: e => e.preventDefault(), // keep the selection and the field's focus
    onContextMenu: e => e.preventDefault() },
    items.map(it => h('button', { key: it.label, className: 'hb-ctxitem', role: 'menuitem', disabled: !it.enabled, onClick: run(it.act) },
      it.label, h('span', { className: 'hb-ctxkey' }, `${MOD_KEY}${it.key}`))))
}

// A session opened in place, laid out like a Hermes chat: full-window, a centred transcript column,
// the composer at the bottom and a collapsible details panel. Esc closes (window-level).
function SessionModal({ board, ctx, item: liveItem }) {
  useBoard(board)
  // The card can vanish for a moment (owner route re-resolved, session closing): keep the last view.
  const lastItem = useRef(liveItem)
  if (liveItem) lastItem.current = liveItem
  const item = liveItem || lastItem.current
  const now = useNow(Boolean(item && (item.column === 'running' || item.column === 'needs')), 1000)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [side, setSide] = useState(() => readStored(ctx, 'viewerSide', false))
  const [width, setWidth] = useState(() => readStored(ctx, 'viewerWidth', VIEWER_DEFAULT_WIDTH))
  const [resizing, setResizing] = useState(false)
  const stopDrag = useRef(null) // detaches an in-progress drag (also on unmount mid-drag)
  useEffect(() => () => stopDrag.current?.(), [])
  const clampWidth = w => Math.round(Math.max(VIEWER_MIN_WIDTH, Math.min(w, window.innerWidth - 24)))
  const startResize = (e, dir) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startW = clampWidth(width)
    let last = startW
    setResizing(true)
    const move = ev => {
      // Centred dialog: an edge moved by d widens it by 2d.
      last = clampWidth(startW + (ev.clientX - startX) * 2 * dir)
      setWidth(last)
    }
    const detach = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      stopDrag.current = null
    }
    const up = () => {
      detach()
      setResizing(false)
      writeStored(ctx, 'viewerWidth', last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    stopDrag.current = detach
  }
  const resetWidth = () => {
    setWidth(VIEWER_DEFAULT_WIDTH)
    writeStored(ctx, 'viewerWidth', VIEWER_DEFAULT_WIDTH)
  }
  const handle = dir => h('div', {
    className: `hb-vresize hb-vresize-${dir > 0 ? 'right' : 'left'}`,
    role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Drag to resize', title: 'Drag to resize · double-click to reset',
    onPointerDown: e => startResize(e, dir),
    onDoubleClick: resetWidth
  })
  const scroller = useRef(null)
  const inputRef = useRef(null)
  const stick = useRef(true)
  const close = () => board.closeViewer()
  const closeRef = useRef(close)
  closeRef.current = close
  const [menu, setMenu] = useState(null) // right-click Copy / Cut / Paste
  const menuOpen = useRef(false)
  menuOpen.current = Boolean(menu)
  const closeMenu = useCallback(() => setMenu(null), [])
  const openMenu = e => {
    const m = contextMenuAt(e)
    setMenu(m)
    if (!m) return
    e.preventDefault()
    e.stopPropagation()
  }

  useEffect(() => {
    const onKey = e => {
      if (e.key !== 'Escape' || e.isComposing) return
      if (document.querySelector('[data-slot="dropdown-menu-content"]')) return // the host's menu closes on its own Esc
      e.preventDefault()
      e.stopPropagation()
      if (menuOpen.current) setMenu(null) // Esc closes the menu first, the viewer next
      else closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    inputRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const tr = item ? board.state.transcript.get(item.id) : null
  const running = item?.column === 'running'
  useEffect(() => {
    if (item && (!tr || tr.stale) && !tr?.loading) void board.loadTranscript(item)
  })
  // Profiles whose events don't reach this window: refresh the transcript while a turn runs.
  useEffect(() => {
    if (!item || !running) return undefined
    const t = setInterval(() => void board.loadTranscript(item), 4000)
    return () => clearInterval(t)
  }, [item?.id, running, board])

  const stream = running ? item?.turn?.stream || '' : ''
  const messages = tr?.messages || []
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages.length, stream.length, tr?.loadedAt, item?.requests?.length])
  // Content can also grow without a render of ours (code blocks wrapping, a request card opening):
  // follow it while the reader is at the bottom.
  const colRef = useRef(null)
  useEffect(() => {
    const el = scroller.current
    const col = colRef.current
    if (!el || !col || typeof ResizeObserver !== 'function') return undefined
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(col)
    return () => ro.disconnect()
  }, [Boolean(item)])

  if (!item) return null
  const u = item.usage || {}
  const t = item.turn
  const liveTool = running ? (t?.activity || []).filter(a => a.kind === 'tool' && !a.done).at(-1) : null

  const toggleSide = () => {
    setSide(v => !v)
    writeStored(ctx, 'viewerSide', !side)
  }

  const submit = async () => {
    if (!text.trim() || sending || !item.live) return
    setSending(true)
    stick.current = true
    if (await board.send(item.id, text)) setText('')
    setSending(false)
  }

  const row = (k, v) => (v || v === 0 ? h('div', { className: 'hb-kv' }, h('span', null, k), h('b', null, v)) : null)

  return h('div', { className: 'hb-modal-backdrop hb-viewer-backdrop', onMouseDown: e => e.target === e.currentTarget && close() },
    h('div', { className: `hb-viewer${side ? ' hb-with-side' : ''}${resizing ? ' hb-resizing' : ''}`, style: { width: clampWidth(width) }, role: 'dialog', 'aria-modal': true, 'aria-label': item.title, onContextMenu: openMenu,
      // Hermes' app-wide right-click menu portals into the enclosing dialog-content, i.e. above this modal.
      'data-slot': 'dialog-content' },
      handle(-1),
      handle(1),
      h('header', { className: 'hb-vbar' },
        h('button', { className: 'hb-ghost', title: 'Close (Esc)', onClick: close }, h(Icon, { name: 'x', size: 15 })),
        h('span', { className: `hb-c-${item.column}` }, h(Icon, { name: 'sparkle', size: 14, fill: true })),
        h('div', { className: 'hb-vbar-title' }, item.title),
        h(StatusLine, { item, now }),
        item.profileLabel && h(ProfileTag, { item }),
        h('span', { className: 'hb-spacer' }),
        running && h('button', { className: 'hb-btn hb-small', onClick: () => void board.interrupt(item.id), title: 'Stop the running turn' }, h(Icon, { name: 'stop', size: 10, fill: true }), 'Stop'),
        h('button', { className: 'hb-btn hb-small', onClick: () => void board.open(item) }, h(Icon, { name: 'ext', size: 11 }), 'Open in Hermes'),
        h('button', { className: `hb-ghost${side ? ' hb-on' : ''}`, title: side ? 'Hide details' : 'Show details', 'aria-pressed': side, onClick: toggleSide }, h(Icon, { name: 'panel', size: 15 }))),

      h('div', { className: 'hb-vmain' },
        h('div', { className: 'hb-vchat' },
          h('div', { className: 'hb-transcript', ref: scroller, onScroll: e => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          } },
            h('div', { className: 'hb-tcol', ref: colRef },
              tr?.loading && !messages.length && h('div', { className: 'hb-tempty' }, h('span', { className: 'hb-spin' }), 'Loading conversation…'),
              tr?.error && h('div', { className: 'hb-modal-err' }, `Could not load the conversation: ${tr.error}`, h('button', { className: 'hb-btn hb-small', style: { marginLeft: 10 }, onClick: () => void board.loadTranscript(item) }, 'Retry')),
              !tr?.loading && !tr?.error && !messages.length && !stream && h('div', { className: 'hb-tempty' }, 'No messages yet.'),
              messages.map((m, i) => h(TranscriptRow, { key: m.id ?? i, m, item, onExpand: () => { stick.current = false } })),
              running && h('div', { className: 'hb-trow hb-trow-assistant' },
                h('div', { className: 'hb-aname' }, h('span', { className: 'hb-avatar hb-avatar-live' }, h(Icon, { name: 'sparkle', size: 11, fill: true })), 'Hermes',
                  h('span', { className: 'hb-tmeta' }, liveTool ? `running ${liveTool.label}` : t?.statusText || 'thinking…')),
                h('div', { className: 'hb-abody' }, stream ? h(RichText, { text: stream, item }) : null, h('span', { className: 'hb-caret-blink' }))),
              item.requests.map(req => h('div', { key: req.id, className: 'hb-trow hb-trow-req' }, h(RequestPanel, { sid: item.id, req, item, board }))))),

          h('div', { className: 'hb-vcompose' },
            item.live
              ? h('div', { className: 'hb-cbox' },
                  h('textarea', { ref: inputRef, className: 'hb-cbox-input', rows: 1, value: text, disabled: sending,
                    placeholder: running ? 'Steer the running agent…' : `Message ${item.profileLabel || 'agent'}…`,
                    onChange: e => {
                      setText(e.target.value)
                      e.target.style.height = 'auto'
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`
                    },
                    onKeyDown: e => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
                        e.preventDefault()
                        void submit()
                      }
                    } }),
                  h('div', { className: 'hb-cbox-bar' },
                    item.profileLabel && h('span', { className: 'hb-cbox-chip' }, h('span', { className: 'hb-pdot', style: { background: profileHue(item.profile) } }), item.profileLabel),
                    item.model && h('span', { className: 'hb-cbox-chip hb-cbox-model' }, item.model),
                    h('span', { className: 'hb-spacer' }),
                    h('span', { className: 'hb-note hb-cbox-hint' }, 'Enter to send · Shift+Enter for a new line'),
                    running && h('button', { className: 'hb-cbox-stop', title: 'Stop turn', onClick: () => void board.interrupt(item.id) }, h(Icon, { name: 'stop', size: 11, fill: true })),
                    h('button', { className: 'hb-cbox-send', title: running ? 'Steer (Enter)' : 'Send (Enter)', disabled: sending || !text.trim(), onClick: () => void submit() },
                      sending ? h('span', { className: 'hb-spin hb-spin-light' }) : h(Icon, { name: 'arrowUp', size: 15 }))))
              : h('div', { className: 'hb-cbox hb-cbox-off' },
                  h('span', { className: 'hb-note', style: { flex: 1 } }, item.stored ? 'Session not loaded — open it in Hermes to chat.' : 'Session closed — reopen it in Hermes to continue.'),
                  h('button', { className: 'hb-btn hb-small', onClick: () => void board.open(item) }, h(Icon, { name: 'ext', size: 11 }), 'Open in Hermes')))),

        side && h('aside', { className: 'hb-vside' },
          h('div', { className: 'hb-vblock' },
            h('div', { className: 'hb-flabel' }, 'Activity'),
            (t?.activity || []).length
              ? h(ActivityList, { activity: t.activity.slice(-30), now })
              : h('div', { className: 'hb-note' }, t?.statusText || 'No activity recorded yet.')),
          h('div', { className: 'hb-vblock' },
            h('div', { className: 'hb-flabel' }, 'Usage'),
            row('Context', u.context_percent != null ? `${u.context_percent}%` : null),
            row('LLM calls', u.calls),
            row('Tool calls', t?.tools)),
          h('div', { className: 'hb-vblock' },
            h('div', { className: 'hb-flabel' }, 'Info'),
            row('Profile', item.profileLabel),
            row('Model', item.model),
            row('Messages', item.messageCount),
            row('Started', item.startedAt ? new Date(item.startedAt).toLocaleString() : null),
            row('Source', item.source),
            h('div', { className: 'hb-kv' }, h('span', null, 'Session id'),
              h('button', { className: 'hb-idbtn', title: 'Copy session id', onClick: () => copyText(item.key) }, h('code', null, item.key), h(Icon, { name: 'copy', size: 11 }))))))),
    // Outside the viewer: its open animation's transform would offset a fixed-position menu.
    menu && h(ContextMenu, { menu, onClose: closeMenu }))
}


// Turn timeline: user messages, tools (live ones with progress), completion / errors.
function ActivityList({ activity, now }) {
  return h('ul', { className: 'hb-tl' },
    activity.map((a, i) => h('li', { key: `${a.at}-${i}`, className: a.kind === 'error' ? 'hb-err' : a.kind === 'user' ? 'hb-user' : !a.done ? 'hb-live' : '' },
      h('span', { className: 'hb-tltext' }, a.label, a.percent != null && !a.done ? ` · ${a.percent}%` : '', a.done && a.duration ? h('span', { style: { color: 'var(--hb-fg4)' } }, ` · ${a.duration.toFixed(1)}s`) : null),
      h('span', { className: 'hb-tltime' }, fmtAgo(a.at, now)))))
}

function CardBody({ item, board, now }) {
  const t = item.turn
  const activity = (t?.activity || []).slice(-6)
  return h('div', { className: 'hb-body' },
    h('div', { className: 'hb-sub' },
      item.model && h('span', null, item.model),
      item.usage?.context_percent != null && h('span', null, `· context ${item.usage.context_percent}%`),
      !item.live && h('span', null, item.stored ? '· not loaded — read only' : '· session closed')),
    activity.length > 0 && h(ActivityList, { activity, now }),
    item.requests.map(req => h(RequestPanel, { key: req.id, sid: item.id, req, item, board })),
    h(ChatPanel, { item, board }),
    (item.column === 'done' || item.column === 'failed') && h('div', { className: 'hb-row hb-end' },
      h('button', { className: 'hb-btn hb-small', onClick: () => board.dismiss(item.id), title: item.live ? 'Move back to Idle' : 'Hide from the board' }, h(Icon, { name: 'x', size: 11 }), 'Dismiss')))
}

// ── server→client requests ──

function RequestPanel({ sid, req, item, board }) {
  const [busy, setBusy] = useState(false)
  const reply = async result => {
    setBusy(true)
    await board.answer(sid, req, result)
    setBusy(false)
  }
  const kind = req.method.startsWith('vault.') ? 'vault' : req.method
  const props = { req, busy, reply, board, item }
  return h('div', { className: 'hb-req' },
    h('div', { className: 'hb-reqkind' }, { approval: 'Approval', clarify: 'Clarify', sudo: 'Sudo password', secret: 'Secret', vault: 'Vault' }[kind] || req.method),
    kind === 'approval' ? h(ApprovalForm, props)
      : kind === 'clarify' ? h(ClarifyForm, props)
      : kind === 'sudo' || kind === 'secret' ? h(MaskedForm, props)
      : h(Fragment, null,
          h('div', { className: 'hb-note' }, 'This kind of request has to be answered in the Hermes chat.'),
          h('div', { className: 'hb-row hb-end' }, h('button', { className: 'hb-btn hb-small', onClick: () => void board.open(item) }, h(Icon, { name: 'ext', size: 11 }), 'Open chat'))))
}

function ApprovalForm({ req, busy, reply }) {
  const p = req.params || {}
  const choices = new Set(p.choices?.length ? p.choices : ['once', 'deny'])
  const allowSession = p.allow_session !== false && (choices.has('session') || p.allow_session)
  const allowAlways = p.allow_permanent !== false && (choices.has('always') || p.allow_permanent)
  return h(Fragment, null,
    p.tool_name && h('div', { className: 'hb-note' }, `Tool: ${p.tool_name}`),
    p.command && h('pre', { className: 'hb-pre' }, clip(p.command, 2000)),
    p.description && h('div', null, p.description),
    p.smart_denied && h('div', { className: 'hb-note hb-c-failed' }, 'Smart approval denied this command — your call.'),
    h('div', { className: 'hb-row hb-end' },
      allowAlways && h('button', { className: 'hb-btn hb-small', disabled: busy, onClick: () => reply({ choice: 'always' }), title: 'Always allow commands like this' }, 'Always'),
      allowSession && h('button', { className: 'hb-btn hb-small', disabled: busy, onClick: () => reply({ choice: 'session' }), title: 'Allow for this session' }, 'Session'),
      h('button', { className: 'hb-btn', disabled: busy, onClick: () => reply({ choice: 'deny' }) }, 'Reject'),
      h('button', { className: 'hb-btn hb-primary', disabled: busy, onClick: () => reply({ choice: 'once' }) }, 'Approve')))
}

function ClarifyForm({ req, busy, reply }) {
  const questions = req.params?.questions || []
  const [answers, setAnswers] = useState(() => ({ ...(req.params?.answers || {}) }))
  const [other, setOther] = useState({})
  const set = (qid, v) => setAnswers(a => ({ ...a, [qid]: v }))

  const valueOf = q => {
    const typed = (other[q.qid] || '').trim()
    if (typed) return typed
    const v = answers[q.qid]
    return Array.isArray(v) ? (v.length ? v.join(', ') : null) : v ?? null
  }
  const ready = questions.every(q => valueOf(q))
  const submit = () => reply({ answers: Object.fromEntries(questions.map(q => [q.qid, valueOf(q)])), outcome: 'submitted' })

  return h(Fragment, null,
    questions.map(q => {
      const cur = answers[q.qid]
      const picked = c => (q.multi_select ? Array.isArray(cur) && cur.includes(c) : cur === c)
      const pick = c => {
        if (!q.multi_select) return set(q.qid, cur === c ? null : c)
        const list = Array.isArray(cur) ? cur : []
        set(q.qid, list.includes(c) ? list.filter(x => x !== c) : [...list, c])
      }
      return h('div', { key: q.qid, className: 'hb-q' },
        h('div', { className: 'hb-qtext' }, q.question),
        q.choices?.length > 0 && h('div', { className: 'hb-chips' },
          q.choices.map(c => h('button', { key: c, className: 'hb-chip', 'aria-pressed': picked(c), disabled: busy, onClick: () => pick(c) }, c))),
        h('input', { className: 'hb-input', placeholder: q.choices?.length ? 'Or type your own answer…' : 'Your answer…', value: other[q.qid] || '', disabled: busy,
          onChange: e => setOther(o => ({ ...o, [q.qid]: e.target.value })),
          onKeyDown: e => e.key === 'Enter' && ready && submit() }))
    }),
    h('div', { className: 'hb-row hb-end' },
      h('button', { className: 'hb-btn', disabled: busy, onClick: () => reply({ outcome: 'cancelled' }) }, 'Skip'),
      h('button', { className: 'hb-btn hb-primary', disabled: busy || !ready, onClick: submit }, 'Answer')))
}

function MaskedForm({ req, busy, reply }) {
  const p = req.params || {}
  const [value, setValue] = useState('')
  const submit = () => value && reply({ value })
  return h(Fragment, null,
    req.method === 'sudo'
      ? h(Fragment, null, h('div', { className: 'hb-note' }, 'Command needs sudo:'), p.command && h('pre', { className: 'hb-pre' }, clip(p.command, 1200)))
      : h(Fragment, null, h('div', null, p.prompt || 'The agent needs a secret value'), p.env_var && h('div', { className: 'hb-note' }, `Environment variable: ${p.env_var}`)),
    h('input', { className: 'hb-input', type: 'password', autoComplete: 'off', placeholder: req.method === 'sudo' ? 'sudo password' : 'Value', value, disabled: busy,
      onChange: e => setValue(e.target.value), onKeyDown: e => e.key === 'Enter' && submit() }),
    h('div', { className: 'hb-row hb-end' },
      h('button', { className: 'hb-btn', disabled: busy, onClick: () => reply({ value: '' }) }, 'Deny'),
      h('button', { className: 'hb-btn hb-primary', disabled: busy || !value, onClick: submit }, 'Submit')))
}

// ── inline chat ──

function ChatPanel({ item, board }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const scroller = useRef(null)
  const tr = board.state.transcript.get(item.id)
  const running = item.column === 'running'
  const stream = running ? item.turn?.stream : ''

  useEffect(() => {
    if (item.live && (!tr || tr.stale) && !tr?.loading) void board.loadTranscript(item)
  }, [item.live, tr, tr?.stale, board, item.id])

  const messages = (tr?.messages || []).filter(m => m.role === 'user' || m.role === 'assistant').slice(-8)
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, stream?.length])

  if (!item.live) {
    return h('div', { className: 'hb-row' },
      h('span', { className: 'hb-note', style: { flex: 1 } }, item.stored ? 'Session not loaded — open it in Hermes to chat / approve.' : 'Session closed — reopen it in Hermes to continue.'),
      h('button', { className: 'hb-btn hb-small', onClick: () => void board.open(item) }, h(Icon, { name: 'ext', size: 11 }), 'Open'))
  }

  const submit = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    if (await board.send(item.id, text)) setText('')
    setSending(false)
  }

  return h(Fragment, null,
    (messages.length > 0 || stream || tr?.loading || tr?.error) && h('div', { className: 'hb-chat', ref: scroller },
      tr?.loading && !messages.length && h('div', { className: 'hb-note' }, 'Loading conversation…'),
      tr?.error && h('div', { className: 'hb-note hb-c-failed' }, tr.error),
      messages.map((m, i) => h('div', { key: i, className: `hb-msg hb-${m.role}` }, clip(m.text, 1200))),
      stream && h('div', { className: 'hb-msg hb-assistant hb-streaming' }, clip(stream.slice(-1200), 1200))),
    h('div', { className: 'hb-composer' },
      h('textarea', { className: 'hb-textarea', rows: 1, value: text, disabled: sending,
        placeholder: running ? 'Steer the running agent… (Enter to send)' : 'Reply to the agent… (Enter to send, Shift+Enter for a new line)',
        onChange: e => setText(e.target.value),
        onKeyDown: e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
            e.preventDefault()
            void submit()
          }
        } }),
      running && h('button', { className: 'hb-iconbtn', title: 'Stop turn', onClick: () => void board.interrupt(item.id) }, h(Icon, { name: 'stop', size: 12, fill: true })),
      h('button', { className: 'hb-iconbtn', title: 'Send', disabled: sending || !text.trim(), onClick: () => void submit() }, h(Icon, { name: 'send', size: 12 }))))
}

// ── status bar chip ──

function StatusChip({ board }) {
  useBoard(board)
  const busyBySession = safeValue(host.state.busyBySession) || {}
  const all = board.items(busyBySession)
  const needs = all.filter(i => i.column === 'needs').length
  const running = all.filter(i => i.column === 'running').length
  return h('button', { className: `hb-sb${needs ? ' hb-hot' : ''}`, title: 'Open SpanWall', onClick: () => host.navigate(ROUTE) },
    h(Icon, { name: needs ? 'warn' : 'board', size: 11 }),
    needs ? `${needs} need you` : `${running} running`)
}

// ── settings: which profiles to watch ──

function SettingsPage({ board }) {
  useBoard(board)
  useEffect(() => {
    if (!board.state.routes.length) void board.poll()
  }, [board])
  const routes = board.state.routes
  const liveCount = key => [...board.state.sessions.values()].filter(s => s._routeKey === key).length
  return h('div', { className: 'hb-root hb-settings' },
    h('div', { className: 'hb-note' }, 'The board polls every profile enabled below, every 3 seconds, which may start that profile\'s backend — turn off the ones you don\'t need.'),
    h('label', null,
      h('input', { type: 'checkbox', checked: board.state.showStored, onChange: e => board.setShowStored(e.target.checked) }),
      h('span', { style: { flex: 1 } }, `Show each profile's recent saved sessions (up to ${STORED_SHOWN}) in the Idle column`)),
    routes.length === 0 && h('div', { className: 'hb-note' }, 'Loading profiles…'),
    routes.map(r => {
      const st = board.state.stored.get(r.key)
      const err = r.error || st?.error
      return h('label', { key: r.key },
        h('input', { type: 'checkbox', checked: !board.state.hidden.has(r.key), onChange: e => board.setHidden(r.key, !e.target.checked) }),
        h('span', { className: 'hb-pdot', style: { background: profileHue(r.profile) } }),
        h('span', { style: { flex: 1 } }, r.label, r.active ? ' (current)' : ''),
        // Diagnostics: what this route answered on the last poll.
        h('span', { className: 'hb-note', title: `route ${r.key}${r.route?.mode ? ` · ${r.route.mode}` : ''}${r.route?.targetProfile && r.route.targetProfile !== r.profile ? ` → ${r.route.targetProfile}` : ''}` },
          `${liveCount(r.key)} live · ${st ? st.rows.length : '…'} saved`),
        err && h('span', { className: 'hb-note hb-c-failed', title: err }, ' · error'))
    }),
    h('div', { className: 'hb-row hb-end' }, h('button', { className: 'hb-btn hb-small', onClick: () => void board.refresh() }, h(Icon, { name: 'refresh', size: 11 }), 'Rescan')))
}

// ── plugin ────────────────────────────────────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,
  name: 'SpanWall',
  register(ctx) {
    const board = createBoard(ctx)
    injectStyles(ctx)
    if (typeof ctx.os?.openExternal === 'function') openLink = url => void ctx.os.openExternal(url)

    ctx.onEvent('*', board.handleEvent)
    ctx.setInterval(() => void board.poll(), POLL_MS)
    void board.poll()

    ctx.registerMany([
      { id: 'page', area: sdk.ROUTES_AREA || 'routes', data: { path: ROUTE }, render: () => h(BoardPage, { board, ctx }) },
      { id: 'nav', area: sdk.SIDEBAR_NAV_AREA || 'sidebar.nav', data: { path: ROUTE, label: 'SpanWall', codicon: 'project' } },
      { id: 'status', area: sdk.STATUSBAR_AREAS?.right || 'statusBar.right', order: 120, render: () => h(StatusChip, { board }) },
      { id: 'open', area: sdk.PALETTE_AREA || 'palette', data: { id: 'spanwall.open', label: 'SpanWall: Open', keywords: ['kanban', 'board', 'wall', 'sessions', 'approval', 'profiles'], run: () => host.navigate(ROUTE) } },
      { id: 'new-task', area: sdk.PALETTE_AREA || 'palette', data: { id: 'spanwall.new-task', label: 'SpanWall: New task', keywords: ['task', 'session', 'create', 'profile'], run: () => board.openComposer() } },
      { id: 'refresh', area: sdk.PALETTE_AREA || 'palette', data: { id: 'spanwall.refresh', label: 'SpanWall: Refresh', keywords: ['kanban', 'board'], run: () => void board.refresh() } }
    ])
    ctx.registerSettingsPage?.({ id: 'settings', title: 'SpanWall', icon: 'project', render: () => h(SettingsPage, { board }) })
  }
}
