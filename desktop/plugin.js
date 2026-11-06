// lampstand for Hermes Desktop: the desktop half of the `lampstand` package.
//
// Plain ESM, loaded uncompiled by the Desktop disk-plugin door. Only `@hermes/plugin-sdk` and `react` are imported,
// the SDK through a namespace import so a name an older Desktop does not export degrades to `undefined`.
//
// Contributions:
//   - route `/lampstand` and a sidebar row: the House page (overview, work, inbox, knowledge, constitution, rooms,
//     rhythm, health) under a hero that draws the house's five lamps, with a reader for any file of the house
//   - a status-bar lamp: the five lamps as tiny flames, the house's name and what waits for its operator
//   - palette commands and a keybind: open the house, capture a thought, new task, compile, doctor, rooms
//   - transcript directive `::lampstand{view="..."}`: live house cards the agent's tools hand back
//   - a settings page: the houses this seat knows, the default house, refresh pace and the status-bar lamp
//
// Backend: dashboard/plugin_api.py, reached with ctx.rest('/...'). Live updates arrive as `plugin.lampstand.*`
// gateway events; React Query polling is the fallback. Every act that writes is saved and committed by the backend
// as one git commit of exactly the files it changed. Rooms are agora's: the page reads them through agora's own room
// pane, and posts from here are this seat's human's, never an agent's.
//
// The page injects one stylesheet (<style id="lampstand-cockpit-style">, every class `.ls-` prefixed), removed when
// the plugin unloads. Every colour in it is a Hermes theme variable (--ui-*) or a color-mix()/relative colour of one.

import * as sdk from '@hermes/plugin-sdk'
import { createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'

const ID = 'lampstand'
const ROUTE = '/lampstand'
const STYLE_ID = 'lampstand-cockpit-style'
const ROOM_POLL_MS = 12_000

const {
  host,
  useQuery,
  useValue,
  queryClient,
  atom,
  Button,
  Codicon,
  ConfirmDialog,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  PALETTE_AREA
} = sdk

// -----------------------------------------------------------------------------------------------------------------
// Module state (reset on every register; a hot reload evaluates a fresh module)

let CTX = null
const $root = atom(null) // the house the page shows
const $tab = atom('overview')
const $reader = atom(null) // { root, path, back: [paths] } of the open document
const $dialog = atom(null) // the open act dialog
const $room = atom(null) // the room the Rooms tab shows
const $pending = atom({}) // row key -> what is happening to it ('Saving', 'Adding'...)
const $prefs = atom({ poll: 20_000, statusLamp: true })

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'work', label: 'Work', icon: 'checklist' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'knowledge', label: 'Knowledge', icon: 'book' },
  { id: 'constitution', label: 'Constitution', icon: 'law' },
  { id: 'rooms', label: 'Rooms', icon: 'comment-discussion' },
  { id: 'rhythm', label: 'Rhythm', icon: 'pulse' },
  { id: 'health', label: 'Health', icon: 'heart' }
]

// -----------------------------------------------------------------------------------------------------------------
// The backend

function rest(path, opts) {
  if (!CTX) return Promise.reject(new Error('lampstand is not loaded'))
  return CTX.rest(path, opts)
}

const q = params =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')

/** Any error shape (a string, an Error, `{message}`, `{error: {...}}`, an HTTP body with `detail`) as one plain line. */
function messageOf(error, depth = 0) {
  if (error == null || error === false || depth > 4) return ''
  if (typeof error === 'string') {
    const m = /"detail"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(error)
    return (m ? m[1].replace(/\\"/g, '"') : error.replace(/^(Error|HTTPError):\s*/, '')).trim().slice(0, 400)
  }
  if (typeof error === 'object') {
    for (const key of ['message', 'detail', 'error', 'text', 'reason']) {
      const out = error[key] != null ? messageOf(error[key], depth + 1) : ''
      if (out) return out
    }
    if (error instanceof Error) return String(error)
    try {
      return JSON.stringify(error).slice(0, 400)
    } catch {
      return 'failed'
    }
  }
  return String(error).slice(0, 400)
}

const errorText = error => messageOf(error) || 'failed'

/** One toast. An `id` replaces our own earlier toast of that id instead of stacking another. */
function say(kind, message, { title = 'lampstand', id, durationMs } = {}) {
  host.notify({
    kind,
    title,
    message: messageOf(message) || String(message || ''),
    ...(id ? { id: `lampstand:${id}` } : {}),
    ...(durationMs ? { durationMs } : {})
  })
}

// Which lists each act changes, so only those (and the overview) are read again.
const AFFECTS = {
  'task.new': ['tasks'], 'task.set': ['tasks'], 'task.done': ['tasks'],
  'inbox.new': ['inbox'], 'inbox.set': ['inbox'], capture: ['inbox'], 'decide.new': ['inbox'], 'decide.resolve': ['inbox'],
  'remind.new': ['reminders'], 'remind.done': ['reminders'], 'knowledge.new': ['knowledge']
}
const CONSTITUTION_ACTS = ['adopt', 'strike', 'compile', 'lint']
const HUMAN = {
  'task.new': 'Task added', 'task.set': 'Task updated', 'task.done': 'Task done', 'inbox.new': 'Filed in the inbox',
  'inbox.set': 'Inbox item settled', capture: 'Captured', 'decide.new': 'Decision opened', 'decide.resolve': 'Ruled',
  'remind.new': 'Reminder set', 'remind.done': 'Reminder done', 'knowledge.new': 'Note written', adopt: 'Adopted',
  strike: 'Struck', compile: 'Compiled the constitution', 'record.commit': 'Committed'
}
const ownActs = new Map() // root -> when this page last acted there (its own house.changed echo is not re-read)

function invalidateAfter(root, action) {
  for (const kind of AFFECTS[action] || []) queryClient.invalidateQueries({ queryKey: [ID, 'items', root, kind] })
  queryClient.invalidateQueries({ queryKey: [ID, 'overview', root] })
  if (CONSTITUTION_ACTS.includes(action)) queryClient.invalidateQueries({ queryKey: [ID, 'constitution', root] })
  if (action.startsWith('remind')) queryClient.invalidateQueries({ queryKey: [ID, 'rhythm', root] })
}

function refreshHouse(root) {
  if (!root) return queryClient.invalidateQueries({ queryKey: [ID] })
  for (const key of ['overview', 'items', 'constitution', 'rhythm', 'doctor', 'lint']) queryClient.invalidateQueries({ queryKey: [ID, key, root] })
  queryClient.invalidateQueries({ queryKey: [ID, 'seat'] })
}

function setPending(key, label) {
  if (key) $pending.set({ ...$pending.get(), [key]: label })
}
function clearPending(key) {
  if (!key) return
  const next = { ...$pending.get() }
  delete next[key]
  $pending.set(next)
}
const pendKey = (root, id) => `${root}|${id}`

/** Changes one cached list (and the overview's copy of it) in place: the optimistic half of an act. */
function patchList(root, kind, change) {
  queryClient.cancelQueries({ queryKey: [ID, 'items', root, kind] })
  queryClient.setQueriesData({ queryKey: [ID, 'items', root, kind] }, old => (old && Array.isArray(old.items) ? { ...old, items: change(old.items) } : old))
  const field = { tasks: 'tasks', inbox: 'inbox', reminders: 'reminders' }[kind]
  if (field) queryClient.setQueriesData({ queryKey: [ID, 'overview', root] }, old => (old && Array.isArray(old[field]) ? { ...old, [field]: change(old[field]) } : old))
}

const optimistic = {
  status: (root, kind, id, status) => () => patchList(root, kind, items => items.map(i => (i.id === id ? { ...i, status } : i))),
  remove: (root, kind, id) => () => patchList(root, kind, items => items.map(i => (i.id === id ? { ...i, _leaving: true } : i))),
  add: (root, kind, row) => () => patchList(root, kind, items => [...items, { _pending: true, status: 'open', ...row }])
}

/**
 * Runs one act. Returns `{ ok, message, ... }` and never throws. A refused act toasts its reason unless `inline`
 * (a dialog shows it under its fields and keeps what was typed). A done act toasts one plain sentence.
 */
async function act(root, action, params = {}, { quiet = false, inline = false, pending, pendingLabel = 'Saving', apply } = {}) {
  setPending(pending, pendingLabel)
  if (apply) apply()
  ownActs.set(root, Date.now())
  let out
  try {
    const data = await rest('/act', { method: 'POST', body: { root, action, params } })
    out = data && typeof data === 'object' ? { ...data } : { ok: false, message: 'The backend gave no answer.' }
    if (out.ok === false) out.message = messageOf(out.message) || messageOf(out.error) || messageOf(out.text) || 'The house refused this.'
  } catch (error) {
    out = { ok: false, message: errorText(error) }
  }
  clearPending(pending)
  ownActs.set(root, Date.now())
  invalidateAfter(root, action)
  if (out.ok === false) {
    if (!inline) say('error', out.message, { title: `${HUMAN[action] || 'That'}: refused`, id: 'act-refused' })
    return out
  }
  if (out.commit_error) {
    say('warning', `Saved, but not committed: ${messageOf(out.commit_error)}`, { title: 'Saved, not committed', id: 'act-commit' })
  } else if (!quiet) {
    const line = out.summary || String(out.text || '').split('\n').find(Boolean) || HUMAN[action] || 'Done'
    const committed = out.commit ? ` · ${out.commit}` : ''
    say('success', `${line.slice(0, 200)}${committed}`, { title: out.commit ? 'Saved and committed' : 'Saved', durationMs: 4500 })
  }
  return out
}

// -----------------------------------------------------------------------------------------------------------------
// Small helpers

function ago(value) {
  if (!value) return ''
  const t = typeof value === 'number' ? value : Date.parse(String(value).replace(' ', 'T'))
  if (!Number.isFinite(t)) return String(value)
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(t).toISOString().slice(0, 10)
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysUntil(due) {
  if (!due) return null
  const d = Math.round((Date.parse(due) - Date.parse(today())) / 86400000)
  return Number.isFinite(d) ? d : null
}

function dueIn(due) {
  const d = daysUntil(due)
  if (d === null) return due || ''
  if (d === 0) return 'due today'
  if (d === -1) return '1 day overdue'
  if (d < 0) return `${-d} days overdue`
  if (d === 1) return 'due tomorrow'
  return `in ${d} days`
}

const TERMINAL = ['done', 'dropped', 'decided', 'superseded', 'withdrawn', 'adopted', 'filed', 'concluded', 'abandoned']
const isOverdue = item => !!item && !TERMINAL.includes(item.status) && (item.overdue === true || (!!item.due && daysUntil(item.due) < 0))
const dueTone = item => (isOverdue(item) ? 'bad' : item.due && daysUntil(item.due) <= 2 ? 'warn' : undefined)

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const cls = (...names) => names.filter(Boolean).join(' ')
const join = (root, rel) => (root.includes('\\') ? `${root}\\${rel.replace(/\//g, '\\')}` : `${root}/${rel}`)
const slugTitle = slug => String(slug || '').replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase())

function rankTask(t) {
  if (isOverdue(t)) return 0
  if (t.status === 'active') return 1
  if (t.due) return 2
  if (t.status === 'blocked') return 3
  return 4
}
const sortTasks = tasks => [...tasks].sort((a, b) => rankTask(a) - rankTask(b) || String(a.due || '9999').localeCompare(String(b.due || '9999')) || String(a.title || a.id).localeCompare(String(b.title || b.id)))

function Icon({ name, className }) {
  return Codicon ? h(Codicon, { name, className: cls('ls-icon', className) }) : null
}

function openReader(root, path, { push = false } = {}) {
  const current = $reader.get()
  const back = push && current && current.root === root ? [...(current.back || []), current.path].slice(-30) : []
  $reader.set({ root, path, back })
}

function navigateTo(tab) {
  $tab.set(tab)
  host.navigate(ROUTE)
}

/** The house the palette and status bar act on: the page's, else the seat's pick (fetching the seat if needed). */
async function resolveRoot() {
  const chosen = $root.get()
  if (chosen) return chosen
  const cwd = host.state.cwd?.get?.() || ''
  try {
    const seat = await queryClient.fetchQuery({ queryKey: [ID, 'seat', cwd], queryFn: () => rest(`/seat?${q({ cwd })}`), staleTime: 15_000 })
    const pick = pickInitialRoot(seat)
    if (pick) $root.set(pick)
    return pick
  } catch {
    return null
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Styles: one sheet from the theme's variables, removed with the plugin. No colour is written here: every hue is a
// theme variable, a color-mix() of one, or a relative colour derived from one, so the page reskins with every theme.

const CSS = `
.ls-tok{--ls-accent:var(--ui-accent,currentColor);
  --ls-flame:var(--ui-yellow,var(--ui-orange,var(--ls-accent)));--ls-hot:var(--ui-orange,var(--ls-flame));
  --ls-core:oklch(from var(--ls-flame) calc(l + .3) calc(c * .45) h);
  --ls-glow:color-mix(in oklab,var(--ls-flame) 42%,transparent);
  --ls-brass:color-mix(in oklab,var(--ui-text-tertiary) 62%,var(--ls-flame));
  --ls-line:color-mix(in oklab,var(--ui-stroke-secondary,var(--ui-text-quaternary)) 70%,transparent);
  --ls-soft:color-mix(in oklab,var(--ui-stroke-tertiary,var(--ui-text-quaternary)) 55%,transparent);
  --ls-card:var(--ui-bg-elevated,var(--ui-bg-card,transparent));
  --ls-field:color-mix(in oklab,var(--ui-text-primary) 4%,var(--ui-bg-editor,transparent));
  --ls-shade:color-mix(in oklab,var(--ui-bg-chrome,var(--ui-bg-editor)) 80%,transparent);
  --ls-red:var(--ui-red,var(--ls-accent));--ls-green:var(--ui-green,var(--ls-accent));--ls-yellow:var(--ui-yellow,var(--ls-accent));
  --ls-serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
  --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px}
.ls-page{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;color:var(--ui-text-primary);font-size:13px;overflow:hidden;container-type:inline-size;container-name:lspage}
.ls-page *,.ls-dialog *{box-sizing:border-box}
.ls-num{font-variant-numeric:tabular-nums lining-nums}
.ls-scroll{flex:1;min-height:0;overflow:auto}
.ls-body{padding:0 var(--s6) var(--s7)}
/* hero */
.ls-hero{position:relative;padding:var(--s5) var(--s6) var(--s4);isolation:isolate}
.ls-hero:before{content:"";position:absolute;inset:-60px 0 -30px 0;z-index:-1;pointer-events:none;
  background:radial-gradient(ellipse 560px 260px at calc(100% - 230px) 40%,color-mix(in oklab,var(--ls-flame) 9%,transparent),transparent 70%),
  radial-gradient(ellipse 700px 220px at 10% -40px,color-mix(in oklab,var(--ls-accent) 8%,transparent),transparent 70%)}
.ls-hero-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,430px);gap:var(--s6);align-items:center}
@container lspage (max-width:900px){.ls-hero-grid{grid-template-columns:minmax(0,1fr)}.ls-lamp-panel{max-width:520px}}
.ls-hero-text{min-width:0}
.ls-eyebrow{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ui-text-tertiary);display:flex;gap:6px 14px;align-items:center;flex-wrap:wrap}
.ls-eyebrow b{color:var(--ui-text-secondary);font-weight:600}
.ls-title{font-family:var(--ls-serif);font-size:38px;line-height:1.06;font-weight:500;letter-spacing:-.005em;margin:var(--s2) 0 var(--s2);color:var(--ui-text-primary);overflow-wrap:anywhere}
.ls-purpose{font-family:var(--ls-serif);font-style:italic;font-size:15px;line-height:1.55;color:var(--ui-text-secondary);max-width:68ch;margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ls-hero-actions{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap;margin-top:var(--s4)}
.ls-switch{appearance:none;background:var(--ls-field);color:var(--ui-text-primary);border:1px solid var(--ls-line);border-radius:9px;padding:6px 26px 6px 10px;font:inherit;max-width:240px;cursor:pointer;
  background-image:linear-gradient(45deg,transparent 50%,var(--ui-text-tertiary) 50%),linear-gradient(135deg,var(--ui-text-tertiary) 50%,transparent 50%);
  background-position:calc(100% - 14px) 52%,calc(100% - 9px) 52%;background-size:5px 5px;background-repeat:no-repeat}
.ls-switch option{background:var(--ui-bg-elevated,var(--ui-bg-editor));color:var(--ui-text-primary)}
/* the five lamps */
.ls-lamp-panel{position:relative;padding:var(--s3) var(--s3) var(--s2);border-radius:18px;border:1px solid var(--ls-soft);
  background:radial-gradient(ellipse 80% 70% at 50% 18%,color-mix(in oklab,var(--ls-flame) 7%,transparent),transparent 72%),color-mix(in oklab,var(--ls-card) 55%,transparent);
  box-shadow:0 1px 0 color-mix(in oklab,var(--ui-text-primary) 5%,transparent) inset,0 18px 40px -26px var(--ls-shade)}
.ls-stand-svg{display:block;width:100%;height:auto;overflow:visible}
.ls-stand-svg .metal{fill:none;stroke:var(--ls-brass);stroke-linecap:round}
.ls-stand-svg .metal-fill{fill:var(--ls-brass)}
.ls-stand-svg .cup{fill:var(--ls-brass);transition:fill .6s}
.ls-l.on .cup{fill:color-mix(in oklab,var(--ls-brass) 70%,var(--ls-flame))}
.ls-fl,.ls-bloom,.ls-ember{transform-box:fill-box;transform-origin:50% 100%}
.ls-bloom{transform-origin:50% 50%;opacity:.9;animation:ls-breathe 4.8s ease-in-out infinite;transition:opacity .3s}
.ls-l.hot .ls-bloom{opacity:1;transform:scale(1.18)}
.ls-l.on .ls-fl{animation:ls-flicker 3.2s ease-in-out infinite}
.ls-l.ignite .ls-fl{animation:ls-ignite 1.1s cubic-bezier(.2,.9,.3,1.25) both}
.ls-l.ignite .ls-bloom{animation:ls-flash 1.4s ease-out both}
.ls-wick{stroke:color-mix(in oklab,var(--ui-text-secondary) 80%,transparent);stroke-width:1.6;stroke-linecap:round}
.ls-ember{fill:var(--ls-hot);opacity:.55;filter:drop-shadow(0 0 2px var(--ls-glow));animation:ls-ember 3.6s ease-in-out infinite}
.ls-l.off.hot .ls-ember{opacity:.9}
.ls-smoke{fill:none;stroke:color-mix(in oklab,var(--ui-text-tertiary) 45%,transparent);stroke-width:1;stroke-linecap:round;opacity:.0;animation:ls-smoke 7s ease-in-out infinite}
.ls-l{cursor:pointer}
@keyframes ls-flicker{0%,100%{transform:scale(1,1) skewX(0)}15%{transform:scale(.96,1.05) skewX(1.5deg)}33%{transform:scale(1.03,.97) skewX(-1deg)}52%{transform:scale(.98,1.03) skewX(.8deg)}74%{transform:scale(1.02,.99) skewX(-1.4deg)}}
@keyframes ls-breathe{0%,100%{opacity:.78;transform:scale(1)}50%{opacity:1;transform:scale(1.06)}}
@keyframes ls-ignite{0%{transform:scale(.05,.05);opacity:0}45%{transform:scale(1.18,1.3);opacity:1}100%{transform:scale(1,1)}}
@keyframes ls-flash{0%{opacity:0;transform:scale(.4)}35%{opacity:1;transform:scale(1.6)}100%{opacity:.9;transform:scale(1)}}
@keyframes ls-ember{0%,100%{opacity:.35}50%{opacity:.7}}
@keyframes ls-smoke{0%{opacity:0;transform:translateY(2px)}30%{opacity:.5}100%{opacity:0;transform:translateY(-10px)}}
.ls-legend{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;margin-top:2px}
.ls-legend button{appearance:none;border:0;background:none;font:inherit;color:inherit;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 2px 7px;border-radius:10px;min-width:0;transition:background .15s}
.ls-legend button:hover,.ls-legend button:focus-visible,.ls-legend button[data-hot="1"]{background:color-mix(in oklab,var(--ui-text-primary) 5%,transparent);outline:none}
.ls-legend b{font-family:var(--ls-serif);font-variant:small-caps;letter-spacing:.04em;font-weight:500;font-size:13px;white-space:nowrap;color:var(--ui-text-primary)}
.ls-legend span{font-size:11px;line-height:1.25;color:var(--ui-text-tertiary);text-align:center;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;min-height:2.5em}
.ls-legend button[data-lit="0"] b{color:var(--ui-text-secondary)}
.ls-legend button[data-tone="bad"] span{color:color-mix(in oklab,var(--ls-red) 85%,var(--ui-text-primary))}
.ls-legend button[data-tone="warn"] span{color:color-mix(in oklab,var(--ls-yellow) 80%,var(--ui-text-primary))}
.ls-lamp-caption{display:flex;align-items:baseline;gap:var(--s2);justify-content:center;flex-wrap:wrap;font-size:11.5px;color:var(--ui-text-tertiary);padding:var(--s1) var(--s2) var(--s1);text-align:center}
.ls-lamp-caption b{font-family:var(--ls-serif);font-size:14px;font-weight:500;color:var(--ui-text-primary)}
/* tabs */
.ls-tabs-wrap{position:sticky;top:0;z-index:3;margin-bottom:var(--s5);background:linear-gradient(var(--ui-bg-editor,var(--ui-surface-background,transparent)) 72%,transparent);backdrop-filter:blur(8px)}
.ls-tabs{display:flex;gap:2px;padding:var(--s2) var(--s6) 0;border-bottom:1px solid var(--ls-soft);overflow-x:auto;scrollbar-width:none;
  -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 var(--s6),#000 calc(100% - var(--s6)),transparent 100%);mask-image:linear-gradient(90deg,transparent 0,#000 var(--s6),#000 calc(100% - var(--s6)),transparent 100%)}
.ls-tabs::-webkit-scrollbar{display:none}
.ls-tab{position:relative;flex:none;display:flex;align-items:center;gap:7px;padding:8px 12px 11px;border:0;background:none;color:var(--ui-text-tertiary);font:inherit;cursor:pointer;white-space:nowrap;border-radius:8px 8px 0 0;transition:color .15s,background .15s}
.ls-tab:hover{color:var(--ui-text-primary);background:color-mix(in oklab,var(--ui-text-primary) 3%,transparent)}
.ls-tab[data-on="1"]{color:var(--ui-text-primary)}
.ls-tab[data-on="1"]:after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:2px;background:var(--ls-accent);box-shadow:0 0 12px color-mix(in oklab,var(--ls-accent) 40%,transparent)}
.ls-tab .ls-count{font-size:10px;line-height:15px;min-width:17px;text-align:center;padding:0 5px;border-radius:10px;background:color-mix(in oklab,var(--ui-text-primary) 8%,transparent);color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
.ls-tab .ls-count.bad{background:color-mix(in oklab,var(--ls-red) 22%,transparent);color:var(--ui-text-primary)}
.ls-icon{font-size:14px;opacity:.9}
/* cards */
.ls-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:var(--s4);align-items:start}
.ls-card{position:relative;grid-column:span 4;min-width:0;padding:var(--s4) 18px 18px;border-radius:14px;border:1px solid var(--ls-line);
  background:linear-gradient(180deg,color-mix(in oklab,var(--ls-card) 96%,transparent),color-mix(in oklab,var(--ls-card) 78%,transparent));
  box-shadow:0 1px 0 color-mix(in oklab,var(--ui-text-primary) 4%,transparent) inset,0 10px 30px -22px var(--ls-shade);transition:border-color .2s}
.ls-card:hover{border-color:color-mix(in oklab,var(--ls-accent) 26%,var(--ls-line))}
.ls-card.w3{grid-column:span 3}.ls-card.w5{grid-column:span 5}.ls-card.w6{grid-column:span 6}.ls-card.w7{grid-column:span 7}.ls-card.w8{grid-column:span 8}.ls-card.w12{grid-column:span 12}
@container lspage (max-width:1040px){.ls-card,.ls-card.w3,.ls-card.w5,.ls-card.w6,.ls-card.w7,.ls-card.w8{grid-column:span 12}}
.ls-card.lit{border-color:color-mix(in oklab,var(--ls-flame) 34%,var(--ls-line));
  background:radial-gradient(ellipse at 0% 0%,color-mix(in oklab,var(--ls-flame) 8%,transparent),transparent 60%),linear-gradient(180deg,color-mix(in oklab,var(--ls-card) 96%,transparent),color-mix(in oklab,var(--ls-card) 78%,transparent))}
.ls-card-head{display:flex;align-items:center;gap:var(--s2);margin-bottom:var(--s3);min-height:24px}
.ls-label{font-family:var(--ls-serif);font-variant:small-caps;letter-spacing:.06em;font-size:15px;color:var(--ui-text-secondary)}
.ls-card-head .ls-spacer{flex:1}
.ls-big{font-family:var(--ls-serif);font-size:32px;line-height:1;color:var(--ui-text-primary);font-variant-numeric:lining-nums tabular-nums}
.ls-muted{color:var(--ui-text-tertiary)}.ls-faint{color:var(--ui-text-quaternary,var(--ui-text-tertiary))}
.ls-note-line{font-size:11.5px;color:var(--ui-text-tertiary);line-height:1.5}
.ls-row{display:flex;align-items:center;gap:10px;min-width:0}
.ls-rows{display:flex;flex-direction:column}
.ls-enter{animation:ls-rise .38s cubic-bezier(.2,.7,.2,1) both}
@keyframes ls-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ls-item{display:flex;align-items:center;gap:10px;padding:9px 10px;margin:0 -10px;border-radius:10px;min-width:0;cursor:default;transition:background .12s,opacity .25s}
.ls-item:hover{background:color-mix(in oklab,var(--ui-text-primary) 4%,transparent)}
.ls-item.click{cursor:pointer}
.ls-item[data-pending]{opacity:.62}
.ls-item[data-leaving]{opacity:.35;text-decoration:line-through;text-decoration-color:var(--ui-text-quaternary)}
.ls-item-main{flex:1;min-width:0}
.ls-item-title{color:var(--ui-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ls-item-sub{font-size:11.5px;color:var(--ui-text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.ls-item-actions{display:flex;gap:4px;opacity:0;transition:opacity .12s}
.ls-item:hover .ls-item-actions,.ls-item:focus-within .ls-item-actions,.ls-item[data-pending] .ls-item-actions{opacity:1}
.ls-busy{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ui-text-tertiary)}
.ls-busy:before{content:"";width:10px;height:10px;border-radius:50%;border:1.5px solid color-mix(in oklab,var(--ui-text-tertiary) 40%,transparent);border-top-color:var(--ls-accent);animation:ls-spin .8s linear infinite}
@keyframes ls-spin{to{transform:rotate(360deg)}}
.ls-dot{flex:none;width:8px;height:8px;border-radius:50%;background:color-mix(in oklab,var(--ui-text-tertiary) 70%,transparent)}
.ls-dot[data-s="active"],.ls-dot[data-s="current"]{background:var(--ls-flame);box-shadow:0 0 8px var(--ls-glow)}
.ls-dot[data-s="blocked"]{background:var(--ui-orange,var(--ls-yellow))}
.ls-dot[data-s="overdue"]{background:var(--ls-red);box-shadow:0 0 8px color-mix(in oklab,var(--ls-red) 50%,transparent)}
.ls-dot[data-s="done"],.ls-dot[data-s="decided"],.ls-dot[data-s="adopted"],.ls-dot[data-s="concluded"],.ls-dot[data-s="filed"]{background:var(--ls-green)}
.ls-dot[data-s="dropped"],.ls-dot[data-s="withdrawn"],.ls-dot[data-s="abandoned"],.ls-dot[data-s="superseded"]{background:var(--ui-text-quaternary,var(--ui-text-tertiary));opacity:.6}
.ls-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums;
  color:var(--ui-text-secondary);background:color-mix(in oklab,var(--ui-text-primary) 6%,transparent);border:1px solid transparent}
.ls-chip.accent{color:var(--ui-text-primary);background:color-mix(in oklab,var(--ls-accent) 15%,transparent);border-color:color-mix(in oklab,var(--ls-accent) 28%,transparent)}
.ls-chip.warn{color:var(--ui-text-primary);background:color-mix(in oklab,var(--ls-yellow) 18%,transparent);border-color:color-mix(in oklab,var(--ls-yellow) 26%,transparent)}
.ls-chip.bad{color:var(--ui-text-primary);background:color-mix(in oklab,var(--ls-red) 20%,transparent);border-color:color-mix(in oklab,var(--ls-red) 34%,transparent)}
.ls-chip.good{color:var(--ui-text-primary);background:color-mix(in oklab,var(--ls-green) 16%,transparent);border-color:color-mix(in oklab,var(--ls-green) 24%,transparent)}
.ls-chip.button{cursor:pointer;font:inherit;font-size:11px}.ls-chip.button:hover{border-color:var(--ls-line)}
.ls-chip[data-on="1"]{color:var(--ui-text-primary);border-color:color-mix(in oklab,var(--ls-accent) 50%,transparent);background:color-mix(in oklab,var(--ls-accent) 14%,transparent)}
.ls-pills{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ls-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:var(--s3);flex-wrap:wrap}
.ls-toolbar .ls-spacer{flex:1}
.ls-input,.ls-textarea{width:100%;font:inherit;color:var(--ui-text-primary);background:var(--ls-field);border:1px solid var(--ls-line);border-radius:9px;padding:8px 10px;outline:none;transition:border-color .15s,box-shadow .15s}
.ls-input::placeholder,.ls-textarea::placeholder{color:var(--ui-text-quaternary,var(--ui-text-tertiary))}
.ls-input:hover,.ls-textarea:hover{border-color:color-mix(in oklab,var(--ui-text-tertiary) 40%,var(--ls-line))}
.ls-input:focus,.ls-textarea:focus{border-color:color-mix(in oklab,var(--ls-accent) 60%,var(--ls-line));box-shadow:0 0 0 3px color-mix(in oklab,var(--ls-accent) 14%,transparent)}
.ls-input[aria-invalid="true"],.ls-textarea[aria-invalid="true"]{border-color:var(--ls-red);box-shadow:0 0 0 3px color-mix(in oklab,var(--ls-red) 14%,transparent)}
.ls-input option{background:var(--ui-bg-elevated,var(--ui-bg-editor));color:var(--ui-text-primary)}
.ls-textarea{min-height:96px;resize:vertical;line-height:1.5}
.ls-compose{display:flex;gap:8px;align-items:center;padding:4px 6px 4px 12px;border-radius:12px;border:1px solid var(--ls-line);background:var(--ls-field);margin-bottom:var(--s3);transition:border-color .15s,box-shadow .15s}
.ls-compose:focus-within{border-color:color-mix(in oklab,var(--ls-accent) 50%,var(--ls-line));box-shadow:0 0 0 3px color-mix(in oklab,var(--ls-accent) 12%,transparent)}
.ls-compose .ls-input{border:0;background:transparent;box-shadow:none;padding-left:2px}
.ls-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--s2);padding:var(--s6) var(--s3);color:var(--ui-text-tertiary);text-align:center}
.ls-empty-title{font-family:var(--ls-serif);font-size:17px;color:var(--ui-text-secondary)}
.ls-empty-hint{max-width:46ch;font-size:12px;line-height:1.55}
.ls-meter{height:6px;border-radius:6px;background:color-mix(in oklab,var(--ui-text-primary) 8%,transparent);overflow:hidden}
.ls-meter>i{display:block;height:100%;border-radius:6px;background:linear-gradient(90deg,color-mix(in oklab,var(--ls-accent) 70%,transparent),var(--ls-accent))}
.ls-meter.over>i{background:var(--ls-red)}
.ls-stack{display:flex;height:8px;border-radius:8px;overflow:hidden;gap:2px;margin:var(--s2) 0 var(--s3)}
.ls-stack>i{display:block;height:100%}
.ls-kv{display:grid;grid-template-columns:auto 1fr;gap:7px 16px;font-size:12px;align-items:center}
.ls-kv dt{color:var(--ui-text-tertiary)}.ls-kv dd{margin:0;color:var(--ui-text-primary);min-width:0;overflow:hidden;text-overflow:ellipsis}
.ls-mono{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px}
.ls-kernel{white-space:pre-wrap;font-family:var(--font-mono,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px;line-height:1.6;color:var(--ui-text-secondary);max-height:380px;overflow:auto;padding:12px 14px;border-radius:10px;background:color-mix(in oklab,var(--ui-text-primary) 3%,transparent);border:1px solid var(--ls-soft)}
.ls-timeline{position:relative;padding-left:18px}
.ls-timeline:before{content:"";position:absolute;left:4px;top:8px;bottom:8px;width:1px;background:var(--ls-line)}
.ls-tl{position:relative;padding:5px 0 8px}
.ls-tl:before{content:"";position:absolute;left:-17px;top:11px;width:7px;height:7px;border-radius:50%;background:var(--ls-card);border:1.5px solid var(--ls-brass)}
.ls-tl:first-child:before{background:var(--ls-flame);border-color:var(--ls-flame);box-shadow:0 0 10px var(--ls-glow)}
.ls-tl-sub{font-size:11px;color:var(--ui-text-tertiary);margin-top:2px}
.ls-shimmer{border-radius:8px;background:linear-gradient(90deg,color-mix(in oklab,var(--ui-text-primary) 4%,transparent),color-mix(in oklab,var(--ui-text-primary) 9%,transparent),color-mix(in oklab,var(--ui-text-primary) 4%,transparent));background-size:200% 100%;animation:ls-shimmer 1.4s linear infinite}
@keyframes ls-shimmer{to{background-position:-200% 0}}
.ls-spot{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:12px;border:1px solid var(--ls-soft);background:color-mix(in oklab,var(--ui-text-primary) 2.5%,transparent);margin-bottom:8px;transition:border-color .15s}
.ls-spot:hover{border-color:color-mix(in oklab,var(--ls-accent) 30%,var(--ls-line))}
.ls-spot[data-tone="bad"]{border-color:color-mix(in oklab,var(--ls-red) 34%,var(--ls-soft));background:color-mix(in oklab,var(--ls-red) 6%,transparent)}
.ls-spot[data-tone="accent"]{border-color:color-mix(in oklab,var(--ls-accent) 30%,var(--ls-soft));background:color-mix(in oklab,var(--ls-accent) 6%,transparent)}
.ls-spot-icon{flex:none;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:color-mix(in oklab,var(--ui-text-primary) 6%,transparent);color:var(--ui-text-secondary)}
.ls-spot-main{flex:1;min-width:0}
.ls-spot-kind{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ui-text-tertiary)}
.ls-spot-title{font-family:var(--ls-serif);font-size:15.5px;line-height:1.3;color:var(--ui-text-primary);margin-top:2px;overflow:hidden;text-overflow:ellipsis}
/* reader */
.ls-reader{position:absolute;top:0;right:0;bottom:0;z-index:20;width:min(660px,94%);display:flex;flex-direction:column;
  background:var(--ui-bg-elevated,var(--ui-bg-editor,var(--ls-card)));border-left:1px solid var(--ls-line);box-shadow:-30px 0 60px -30px var(--ls-shade);animation:ls-slide .2s ease-out}
@keyframes ls-slide{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
.ls-reader-head{display:flex;align-items:center;gap:6px;padding:12px 16px;border-bottom:1px solid var(--ls-soft)}
.ls-reader-path{flex:1;min-width:0;font-family:var(--font-mono,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px;color:var(--ui-text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ls-reader-body{flex:1;overflow:auto;padding:22px 28px 48px}
.ls-reader-title{font-family:var(--ls-serif);font-size:25px;line-height:1.2;font-weight:500;margin:0 0 var(--s3);color:var(--ui-text-primary)}
.ls-front{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:var(--s4)}
.ls-links{margin-top:var(--s5);padding-top:var(--s4);border-top:1px solid var(--ls-soft)}
.ls-link{display:inline-flex;margin:0 6px 6px 0}
.ls-md{line-height:1.65}
.ls-md a[href^="#ls-link="]{color:var(--ls-accent);text-decoration:none;border-bottom:1px solid color-mix(in oklab,var(--ls-accent) 45%,transparent);cursor:pointer}
.ls-md a[href^="#ls-link="]:hover{border-bottom-color:var(--ls-accent)}
.ls-md a[href^="#ls-dangling="]{color:var(--ui-text-tertiary);text-decoration:none;border-bottom:1px dashed color-mix(in oklab,var(--ls-red) 60%,transparent);cursor:help}
.ls-chip.dangling{text-decoration:line-through;text-decoration-color:color-mix(in oklab,var(--ls-red) 70%,transparent);color:var(--ui-text-tertiary)}
/* dialogs */
.ls-veil{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:color-mix(in oklab,var(--ui-bg-chrome,var(--ui-bg-editor)) 72%,transparent);backdrop-filter:blur(3px);animation:ls-fade .12s ease-out}
@keyframes ls-fade{from{opacity:0}}
.ls-modal{width:min(560px,92vw);max-height:86vh;overflow:auto;padding:22px 24px 18px;border-radius:16px;border:1px solid var(--ls-line);background:var(--ui-bg-elevated,var(--ui-bg-editor,var(--ls-card)));box-shadow:0 30px 80px -24px var(--ls-shade)}
.ls-dialog{color:var(--ui-text-primary)}
.ls-dialog .ls-dialog-title,.ls-dialog h3,.ls-modal h3{font-family:var(--ls-serif);font-weight:500;font-size:21px;line-height:1.25;margin:0 0 4px;color:var(--ui-text-primary);padding-right:24px}
.ls-dialog .ls-sub,.ls-sub{margin:0 0 14px;color:var(--ui-text-tertiary);line-height:1.5;font-size:12.5px}
.ls-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.ls-field label{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ui-text-tertiary)}
.ls-field .ls-hint{font-size:11px;color:var(--ui-text-tertiary);line-height:1.45}
.ls-field .ls-hint.bad{color:color-mix(in oklab,var(--ls-red) 80%,var(--ui-text-primary))}
.ls-refusal{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;margin:2px 0 12px;border-radius:10px;font-size:12.5px;line-height:1.5;color:var(--ui-text-primary);border:1px solid color-mix(in oklab,var(--ls-red) 40%,transparent);background:color-mix(in oklab,var(--ls-red) 9%,transparent)}
.ls-modal-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:var(--s4)}
.ls-kbd{font-size:11px;color:var(--ui-text-tertiary);margin-right:auto}
/* constitution */
.ls-proposal{border:1px solid var(--ls-line);border-radius:14px;margin-bottom:12px;overflow:hidden;background:color-mix(in oklab,var(--ls-card) 60%,transparent)}
.ls-proposal-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--ls-soft);flex-wrap:wrap}
.ls-proposal-title{flex:1;min-width:160px;font-family:var(--ls-serif);font-size:18px;color:var(--ui-text-primary)}
.ls-proposal-body{padding:12px 18px 14px;max-height:280px;overflow:auto}
.ls-occasion{margin:0 0 10px;padding:6px 0 6px 12px;border-left:2px solid color-mix(in oklab,var(--ls-flame) 70%,transparent);font-family:var(--ls-serif);font-style:italic;color:var(--ui-text-secondary);line-height:1.5}
.ls-occasion small{display:block;font-style:normal;font-family:inherit;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ui-text-tertiary);margin-bottom:2px}
/* rooms */
.ls-rooms{display:grid;grid-template-columns:210px minmax(220px,320px) minmax(0,1fr);gap:14px;min-height:520px}
@container lspage (max-width:1040px){.ls-rooms{grid-template-columns:1fr}}
.ls-col{min-width:0;border:1px solid var(--ls-line);border-radius:14px;background:color-mix(in oklab,var(--ls-card) 70%,transparent);display:flex;flex-direction:column;overflow:hidden}
.ls-col-head{padding:10px 14px;border-bottom:1px solid var(--ls-soft);display:flex;align-items:center;gap:8px;min-height:46px;flex-wrap:wrap}
.ls-col-body{flex:1;overflow:auto;padding:6px}
.ls-roomrow{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:9px;cursor:pointer;color:var(--ui-text-secondary);white-space:nowrap}
.ls-roomrow:hover{background:color-mix(in oklab,var(--ui-text-primary) 5%,transparent)}
.ls-roomrow[data-on="1"]{color:var(--ui-text-primary);background:color-mix(in oklab,var(--ls-accent) 12%,transparent)}
.ls-roomrow .ls-hash{font-family:var(--ls-serif);color:var(--ui-text-tertiary)}
.ls-roomrow .ls-room-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-subject{padding:10px 12px;border-radius:10px;cursor:pointer;border:1px solid transparent}
.ls-subject:hover{background:color-mix(in oklab,var(--ui-text-primary) 4%,transparent)}
.ls-subject[data-on="1"]{border-color:color-mix(in oklab,var(--ls-accent) 40%,transparent);background:color-mix(in oklab,var(--ls-accent) 8%,transparent)}
.ls-subject-title{color:var(--ui-text-primary);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ls-unread{min-width:18px;height:18px;padding:0 6px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;
  color:var(--ui-text-primary);background:color-mix(in oklab,var(--ls-accent) 24%,transparent);border:1px solid color-mix(in oklab,var(--ls-accent) 55%,transparent)}
.ls-thread{flex:1;overflow:auto;padding:14px 16px}
.ls-msg{position:relative;padding:10px 12px 10px 14px;margin-bottom:10px;border-radius:12px;background:color-mix(in oklab,var(--ui-text-primary) 3%,transparent);border-left:2px solid var(--ls-line)}
.ls-msg.human{border-left-color:var(--ui-accent-secondary,var(--ls-accent))}
.ls-msg.agent{border-left-color:color-mix(in oklab,var(--ls-flame) 70%,transparent)}
.ls-msg.mine{background:color-mix(in oklab,var(--ls-accent) 7%,transparent)}
.ls-msg.reply{margin-left:22px}
.ls-msg-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px}
.ls-msg-from{font-weight:600;color:var(--ui-text-primary)}
.ls-msg-body{white-space:pre-wrap;line-height:1.55;color:var(--ui-text-secondary);overflow-wrap:anywhere}
.ls-msg-note{margin-top:6px;font-size:11px;color:var(--ui-text-tertiary)}
.ls-composer{border-top:1px solid var(--ls-soft);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.ls-composer .ls-textarea{min-height:64px}
.ls-listen{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ls-listen .ls-input{width:118px;padding:4px 8px;font-size:12px}
.ls-banner{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:12px;margin-bottom:14px;border:1px solid color-mix(in oklab,var(--ls-yellow) 40%,var(--ls-line));background:color-mix(in oklab,var(--ls-yellow) 8%,transparent)}
/* health */
.ls-verdict{display:flex;align-items:center;gap:var(--s4);margin-bottom:var(--s4)}
.ls-verdict-word{font-family:var(--ls-serif);font-size:30px;line-height:1.1;color:var(--ui-text-primary)}
.ls-finding{display:flex;gap:12px;padding:11px 12px;border-radius:10px;margin-bottom:6px;background:color-mix(in oklab,var(--ui-text-primary) 3%,transparent);align-items:flex-start}
.ls-finding[data-l="error"]{background:color-mix(in oklab,var(--ls-red) 9%,transparent)}
.ls-finding[data-l="warning"]{background:color-mix(in oklab,var(--ls-yellow) 9%,transparent)}
.ls-finding code{font-family:var(--font-mono,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px;padding:2px 6px;border-radius:6px;background:color-mix(in oklab,var(--ui-text-primary) 7%,transparent);overflow-wrap:anywhere}
.ls-details>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:8px 2px;color:var(--ui-text-secondary)}
.ls-details>summary::-webkit-details-marker{display:none}
.ls-details>summary:before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s;margin:0 4px}
.ls-details[open]>summary:before{transform:rotate(45deg)}
.ls-table{width:100%;border-collapse:collapse;font-size:12.5px}
.ls-table th{text-align:left;font-weight:500;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ui-text-tertiary);padding:6px 8px;border-bottom:1px solid var(--ls-soft)}
.ls-table td{padding:9px 8px;border-bottom:1px solid var(--ls-soft);vertical-align:middle}
/* knowledge */
.ls-notes{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:var(--s3)}
.ls-note{display:flex;flex-direction:column;gap:8px;padding:16px 18px 14px;border-radius:14px;border:1px solid var(--ls-line);cursor:pointer;transition:border-color .15s,transform .15s,box-shadow .15s;
  background:linear-gradient(180deg,color-mix(in oklab,var(--ls-card) 92%,transparent),color-mix(in oklab,var(--ls-card) 70%,transparent));min-height:150px}
.ls-note:hover{border-color:color-mix(in oklab,var(--ls-accent) 40%,var(--ls-line));transform:translateY(-2px);box-shadow:0 14px 30px -22px var(--ls-shade)}
.ls-note-title{font-family:var(--ls-serif);font-size:16px;line-height:1.32;color:var(--ui-text-primary)}
.ls-note-excerpt{font-size:12px;line-height:1.55;color:var(--ui-text-tertiary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;flex:1}
.ls-note-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ui-text-tertiary)}
.ls-note-meta .ls-spacer{flex:1}
.ls-arc{display:block}
.ls-arc .track{stroke:color-mix(in oklab,var(--ui-text-primary) 9%,transparent)}
.ls-arc .fill{stroke:var(--ls-accent);transition:stroke-dasharray .6s ease}
.ls-arc.over .fill{stroke:var(--ls-red)}
/* status bar */
.ls-status{display:inline-flex;align-items:center;gap:6px;padding:0 8px;height:100%;font-size:11.5px;color:var(--ui-text-tertiary);background:none;border:0;cursor:pointer;font:inherit}
.ls-status:hover{color:var(--ui-text-primary)}
.ls-status svg{display:block;overflow:visible}
.ls-status .ls-tiny-on{fill:var(--ls-flame);filter:drop-shadow(0 0 1.6px var(--ls-glow)) drop-shadow(0 0 3px var(--ls-glow))}
.ls-status .ls-tiny-off{fill:color-mix(in oklab,var(--ui-text-tertiary) 70%,transparent)}
.ls-status .ls-pill{min-width:16px;height:16px;padding:0 5px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ui-text-primary);background:color-mix(in oklab,var(--ls-accent) 26%,transparent);border:1px solid color-mix(in oklab,var(--ls-accent) 60%,transparent)}
.ls-card-directive{max-width:660px;margin:6px 0;padding:14px 16px;border-radius:14px;border:1px solid var(--ls-line);background:color-mix(in oklab,var(--ls-card) 80%,transparent)}
.ls-house-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;border:1px solid var(--ls-soft);margin-bottom:8px}
.ls-seg{display:inline-flex;border:1px solid var(--ls-line);border-radius:9px;overflow:hidden}
.ls-seg button{appearance:none;border:0;background:none;color:var(--ui-text-secondary);font:inherit;font-size:12px;padding:4px 10px;cursor:pointer}
.ls-seg button[data-on="1"]{background:color-mix(in oklab,var(--ls-accent) 16%,transparent);color:var(--ui-text-primary)}
@media (prefers-reduced-motion:reduce){.ls-l.on .ls-fl,.ls-l.ignite .ls-fl,.ls-bloom,.ls-l.ignite .ls-bloom,.ls-ember,.ls-smoke,.ls-shimmer,.ls-enter,.ls-reader,.ls-busy:before{animation:none}.ls-smoke{opacity:0}}
`

function installStyle(ctx) {
  if (typeof document === 'undefined') return
  document.getElementById(STYLE_ID)?.remove()
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
  ctx.onDispose(() => el.remove())
}

// -----------------------------------------------------------------------------------------------------------------
// The five lamps: one lampstand of five branches, a lamp on each. A lit lamp is a check the house passes.

let gradientSeq = 0
const LAMP_X = [24, 72, 120, 168, 216]
const FLAME_OUTER = 'M0,-34 C6,-24 10,-16 10,-8 C10,-1.5 5.5,2 0,2 C-5.5,2 -10,-1.5 -10,-8 C-10,-16 -6,-24 0,-34Z'
const FLAME_INNER = 'M0,-21 C3.2,-15 5,-11 5,-6.5 C5,-2.8 2.8,-.8 0,-.8 C-2.8,-.8 -5,-2.8 -5,-6.5 C-5,-11 -3.2,-15 0,-21Z'

function lampsOf(view) {
  if (!view) return null
  const tasks = view.tasks || []
  const reminders = view.reminders || []
  const overdueTasks = tasks.filter(isOverdue).length
  const overdueReminders = reminders.filter(isOverdue).length
  const overdue = overdueTasks + overdueReminders
  const git = view.git || {}
  const agora = (view.rooms && view.rooms.agora) || {}
  const kernel = view.kernel || {}
  const stale = (view.fresh?.stale || []).length
  const over = (kernel.chars || 0) > (kernel.cap || 4000)
  const problems = (view.problems || []).length
  const doctor = view.doctor || {}
  const overdueSay = [overdueTasks && plural(overdueTasks, 'task'), overdueReminders && plural(overdueReminders, 'reminder')].filter(Boolean).join(', ')
  return [
    {
      key: 'constitution', name: 'Constitution', tab: 'constitution',
      lit: !!kernel.compiled && stale === 0 && !over,
      say: !kernel.compiled ? 'not compiled yet' : over ? 'kernel over budget' : stale ? `${plural(stale, 'projection')} stale` : 'compiled and fresh',
      tone: !kernel.compiled || over ? 'bad' : stale ? 'warn' : undefined
    },
    {
      key: 'health', name: 'Health', tab: 'health',
      lit: doctor.exit === 0,
      say: doctor.exit === 0 ? 'nothing to fix' : doctor.exit === 1 ? 'something to fix' : doctor.exit === 2 ? 'a person must act' : doctor.error ? 'doctor did not run' : 'not checked yet',
      tone: doctor.exit === 2 ? 'bad' : doctor.exit === 1 ? 'warn' : undefined
    },
    {
      key: 'record', name: 'Record', tab: 'overview',
      lit: !!git.ok && !git.dirty_count && !git.ahead,
      say: !git.ok ? 'not a git repository' : git.dirty_count ? `${plural(git.dirty_count, 'change')} uncommitted` : git.ahead ? `${git.ahead} unpushed` : git.upstream ? 'committed and pushed' : 'all committed · no remote',
      tone: !git.ok ? 'bad' : git.dirty_count || git.ahead ? 'warn' : undefined
    },
    {
      key: 'work', name: 'Work', tab: 'work',
      lit: overdue === 0 && problems === 0,
      say: overdue ? `${overdueSay} overdue` : problems ? plural(problems, 'problem') : 'nothing overdue',
      tone: overdue || problems ? 'bad' : undefined
    },
    {
      key: 'rooms', name: 'Rooms', tab: 'rooms',
      lit: !!agora.version && !agora.problem,
      say: agora.version && !agora.problem ? `agora ${agora.version}` : agora.problem ? 'agora needs attention' : 'agora not installed',
      tone: agora.problem ? 'warn' : undefined
    }
  ]
}

/** Remembers which lamps were lit and names the ones that just caught, for the ignition. */
function useIgnition(lit) {
  const prev = useRef(null)
  const [igniting, setIgniting] = useState([])
  const key = lit.map(Boolean).join(',')
  useEffect(() => {
    const before = prev.current
    prev.current = lit.map(Boolean)
    if (!before) return
    const caught = lit.map((on, i) => (on && !before[i] ? i : -1)).filter(i => i >= 0)
    if (!caught.length) return
    setIgniting(caught)
    const timer = setTimeout(() => setIgniting([]), 1500)
    return () => clearTimeout(timer)
  }, [key])
  return igniting
}

function Lampstand({ lit = [true, true, true, true, true], hot = -1, igniting = [], onPick, onHover, names, width = '100%', title }) {
  const ids = useMemo(() => {
    const n = ++gradientSeq
    return { flame: `ls-gf${n}`, core: `ls-gc${n}`, bloom: `ls-gb${n}`, metal: `ls-gm${n}` }
  }, [])
  return h(
    'svg',
    { className: 'ls-stand-svg', viewBox: '0 22 240 166', width, role: 'img', 'aria-label': title || `${lit.filter(Boolean).length} of 5 lamps lit` },
    h(
      'defs',
      null,
      h('radialGradient', { id: ids.flame, cx: '50%', cy: '78%', r: '78%' },
        h('stop', { offset: '0%', style: { stopColor: 'var(--ls-core)' } }),
        h('stop', { offset: '38%', style: { stopColor: 'var(--ls-flame)' } }),
        h('stop', { offset: '80%', style: { stopColor: 'var(--ls-hot)', stopOpacity: 0.92 } }),
        h('stop', { offset: '100%', style: { stopColor: 'var(--ls-hot)', stopOpacity: 0.35 } })),
      h('radialGradient', { id: ids.core, cx: '50%', cy: '70%', r: '70%' },
        h('stop', { offset: '0%', style: { stopColor: 'var(--ls-core)' } }),
        h('stop', { offset: '100%', style: { stopColor: 'var(--ls-core)', stopOpacity: 0.15 } })),
      h('radialGradient', { id: ids.bloom },
        h('stop', { offset: '0%', style: { stopColor: 'var(--ls-flame)', stopOpacity: 0.5 } }),
        h('stop', { offset: '45%', style: { stopColor: 'var(--ls-hot)', stopOpacity: 0.16 } }),
        h('stop', { offset: '100%', style: { stopColor: 'var(--ls-hot)', stopOpacity: 0 } })),
      h('linearGradient', { id: ids.metal, x1: 0, y1: 0, x2: 0, y2: 1 },
        h('stop', { offset: '0%', style: { stopColor: 'var(--ls-brass)' } }),
        h('stop', { offset: '100%', style: { stopColor: 'var(--ls-brass)', stopOpacity: 0.55 } }))
    ),
    // the stand
    h('g', { style: { stroke: `url(#${ids.metal})` } },
      h('path', { className: 'metal', d: 'M24,80 A96,72 0 0 0 216,80', strokeWidth: 3.4, style: { stroke: `url(#${ids.metal})` } }),
      h('path', { className: 'metal', d: 'M72,80 A48,40 0 0 0 168,80', strokeWidth: 3.4, style: { stroke: `url(#${ids.metal})` } }),
      h('path', { className: 'metal', d: 'M120,80 V168', strokeWidth: 4.4, style: { stroke: `url(#${ids.metal})` } })),
    h('ellipse', { className: 'metal-fill', cx: 120, cy: 120, rx: 5, ry: 3.2 }),
    h('ellipse', { className: 'metal-fill', cx: 120, cy: 152, rx: 5.5, ry: 3.4 }),
    h('path', { className: 'metal-fill', d: 'M120,164 C113,171 101,175 86,178 Q84,181 88,182 H152 Q156,181 154,178 C139,175 127,171 120,164 Z', style: { fill: `url(#${ids.metal})` } }),
    // the lamps
    LAMP_X.map((x, i) =>
      h(
        'g',
        {
          key: i,
          className: cls('ls-l', lit[i] ? 'on' : 'off', hot === i && 'hot', igniting.includes(i) && 'ignite'),
          transform: `translate(${x},70)`,
          onClick: onPick ? () => onPick(i) : undefined,
          onMouseEnter: onHover ? () => onHover(i) : undefined,
          onMouseLeave: onHover ? () => onHover(-1) : undefined
        },
        names && h('title', null, names[i]),
        h('rect', { x: -22, y: -46, width: 44, height: 60, fill: 'transparent' }),
        lit[i] && h('circle', { className: 'ls-bloom', cx: 0, cy: -14, r: 30, fill: `url(#${ids.bloom})` }),
        h('path', { className: 'cup', d: 'M-11,2 H11 C11,7.5 6.5,10.5 0,10.5 C-6.5,10.5 -11,7.5 -11,2 Z' }),
        lit[i]
          ? h('g', { className: 'ls-fl', style: { animationDelay: `${-i * 0.63}s` } },
              h('path', { d: FLAME_OUTER, fill: `url(#${ids.flame})` }),
              h('path', { d: FLAME_INNER, fill: `url(#${ids.core})` }))
          : h(Fragment, null,
              h('line', { className: 'ls-wick', x1: 0, y1: 1.5, x2: 0.6, y2: -4.5 }),
              h('circle', { className: 'ls-ember', cx: 0.6, cy: -5, r: 1.7, style: { animationDelay: `${-i * 0.9}s` } }),
              h('path', { className: 'ls-smoke', d: 'M0.6,-8 C3,-12 -2,-15 0.8,-20', style: { animationDelay: `${-i * 1.4}s` } }))
      )
    )
  )
}

/** The status bar's five lamps: a tiny flame each, or a dim ember. */
function TinyLamps({ lit }) {
  return h(
    'svg',
    { viewBox: '0 0 36 14', width: 36, height: 14, 'aria-hidden': true },
    lit.map((on, i) =>
      on
        ? h('path', { key: i, className: 'ls-tiny-on', transform: `translate(${4 + i * 7},12) scale(.3)`, d: FLAME_OUTER })
        : h('circle', { key: i, className: 'ls-tiny-off', cx: 4 + i * 7, cy: 10.5, r: 1.3 })
    )
  )
}

/** A single oil lamp: the motif of every empty state. */
function OneLamp({ lit = false, size = 54, center = true }) {
  return h(
    'div',
    { style: { width: size, flex: 'none', margin: center ? '0 auto' : 0 } },
    h(
      'svg',
      { className: 'ls-stand-svg', viewBox: '96 30 48 56', width: size, 'aria-hidden': true },
      h('path', { className: 'metal-fill', d: 'M104,72 H136 C136,80 128,84 120,84 C112,84 104,80 104,72 Z', style: { opacity: 0.75 } }),
      h('path', { className: 'metal', d: 'M136,74 C142,74 143,68 139,66', strokeWidth: 2 }),
      h(
        'g',
        { className: cls('ls-l', lit ? 'on' : 'off'), transform: 'translate(120,70)' },
        lit
          ? h('g', { className: 'ls-fl' }, h('path', { d: FLAME_OUTER, style: { fill: 'var(--ls-flame)' } }), h('path', { d: FLAME_INNER, style: { fill: 'var(--ls-core)' } }))
          : h(Fragment, null, h('line', { className: 'ls-wick', x1: 0, y1: 1.5, x2: 0.6, y2: -4.5 }), h('circle', { className: 'ls-ember', cx: 0.6, cy: -5, r: 1.7 }), h('path', { className: 'ls-smoke', d: 'M0.6,-8 C3,-12 -2,-15 0.8,-20' }))
      )
    )
  )
}

function LampPanel({ lamps, onPick }) {
  const [hot, setHot] = useState(-1)
  const list = lamps || []
  const lit = list.length ? list.map(l => l.lit) : [false, false, false, false, false]
  const igniting = useIgnition(lit)
  const count = lit.filter(Boolean).length
  return h(
    'div',
    { className: 'ls-lamp-panel' },
    h(Lampstand, { lit, hot, igniting, onPick: i => list[i] && onPick(list[i]), onHover: setHot, names: list.map(l => `${l.name}: ${l.say}`) }),
    h(
      'div',
      { className: 'ls-legend', role: 'list' },
      (list.length ? list : ['Constitution', 'Health', 'Record', 'Work', 'Rooms'].map(name => ({ key: name, name, say: 'reading…', lit: false }))).map((l, i) =>
        h(
          'button',
          {
            key: l.key, type: 'button', role: 'listitem', 'data-lit': l.lit ? '1' : '0', 'data-tone': l.lit ? undefined : l.tone, 'data-hot': hot === i ? '1' : undefined,
            title: `${l.name}: ${l.say}. ${l.lit ? 'Lit' : 'Dark'}; open its tab.`,
            onMouseEnter: () => setHot(i), onMouseLeave: () => setHot(-1), onFocus: () => setHot(i), onBlur: () => setHot(-1),
            onClick: () => list.length && onPick(l)
          },
          h('b', null, l.name),
          h('span', null, l.say)
        )
      )
    ),
    h('div', { className: 'ls-lamp-caption' }, h('b', { className: 'ls-num' }, `${count} of 5 lit`), h('span', null, 'Each lamp is a check the house passes; click one to see why.'))
  )
}

// -----------------------------------------------------------------------------------------------------------------
// Shared pieces

function Card({ title, icon, className, actions, children, lit, style }) {
  return h(
    'section',
    { className: cls('ls-card ls-enter', lit && 'lit', className), style },
    title && h('header', { className: 'ls-card-head' }, icon && h(Icon, { name: icon }), h('span', { className: 'ls-label' }, title), h('span', { className: 'ls-spacer' }), actions),
    children
  )
}

function Empty({ title, children, lit = false, action }) {
  return h(
    'div',
    { className: 'ls-empty' },
    h(OneLamp, { lit }),
    h('div', { className: 'ls-empty-title' }, title),
    children && h('div', { className: 'ls-empty-hint' }, children),
    action && h('div', { style: { marginTop: 6 } }, action)
  )
}

function Skeleton({ rows = 3 }) {
  return h('div', { className: 'ls-rows' }, Array.from({ length: rows }, (_, i) => h('div', { key: i, className: 'ls-shimmer', style: { height: 34, margin: '6px 0', opacity: 1 - i * 0.16 } })))
}

function Chip({ children, tone, onClick, on, title, className }) {
  return h(
    onClick ? 'button' : 'span',
    { className: cls('ls-chip', tone, onClick && 'button', className), 'data-on': on ? '1' : undefined, onClick, title, type: onClick ? 'button' : undefined },
    children
  )
}

function Btn({ children, onClick, variant = 'ghost', size = 'sm', icon, disabled, title, type }) {
  return h(Button, { variant, size, onClick, disabled, title, type, 'aria-label': !children ? title : undefined }, icon && h(Icon, { name: icon }), children)
}

function Meter({ value, cap }) {
  const pct = cap ? Math.min(100, (value / cap) * 100) : 0
  return h('div', { className: cls('ls-meter', value > cap && 'over') }, h('i', { style: { width: `${pct}%` } }))
}

function Arc({ value, cap, size = 84, label }) {
  const r = 34
  const c = 2 * Math.PI * r
  const pct = cap ? Math.min(1, value / cap) : 0
  return h(
    'svg',
    { className: cls('ls-arc', value > cap && 'over'), viewBox: '0 0 84 84', width: size, height: size },
    h('circle', { className: 'track', cx: 42, cy: 42, r, fill: 'none', strokeWidth: 6 }),
    h('circle', { className: 'fill', cx: 42, cy: 42, r, fill: 'none', strokeWidth: 6, strokeLinecap: 'round', strokeDasharray: `${c * pct} ${c}`, transform: 'rotate(-90 42 42)' }),
    h('text', { x: 42, y: 41, textAnchor: 'middle', fontSize: 16, fill: 'currentColor', style: { fontFamily: 'var(--ls-serif)', fontVariantNumeric: 'tabular-nums' } }, `${Math.round(pct * 100)}%`),
    label && h('text', { x: 42, y: 55, textAnchor: 'middle', fontSize: 8, fill: 'currentColor', opacity: 0.55 }, label)
  )
}

function Dot({ status }) {
  return h('span', { className: 'ls-dot', 'data-s': status || 'open', title: status })
}

function Busy({ children }) {
  return h('span', { className: 'ls-busy' }, children)
}

// -----------------------------------------------------------------------------------------------------------------
// The act dialog: one form, opened from anywhere by $dialog.set({...}). Every surface that can open one (the page,
// each transcript card) mounts a host; only the oldest live host draws, so one dialog shows however many are mounted.
// It is the SDK's Dialog (the host's own scrim, focus trap and Esc), with a plain fallback for an older Desktop.

const $dialogHosts = atom([])
let dialogHostSeq = 0

function ActDialog() {
  const [me] = useState(() => ++dialogHostSeq)
  const hosts = useValue($dialogHosts)
  useEffect(() => {
    $dialogHosts.set([...$dialogHosts.get(), me])
    return () => $dialogHosts.set($dialogHosts.get().filter(x => x !== me))
  }, [me])
  const spec = useValue($dialog)
  const [values, setValues] = useState({})
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState(null)
  const [missing, setMissing] = useState({})
  const busyRef = useRef(false)
  useEffect(() => {
    setValues(spec ? { ...(spec.initial || {}) } : {})
    setBusy(false)
    setRefusal(null)
    setMissing({})
    busyRef.current = false
  }, [spec])
  if (!spec || hosts[0] !== me) return null
  const close = () => {
    if (!busyRef.current && $dialog.get() === spec) $dialog.set(null)
  }
  const submit = async () => {
    if (busyRef.current) return
    const miss = {}
    for (const f of spec.fields || []) if (f.required && !String(values[f.name] || '').trim()) miss[f.name] = true
    setMissing(miss)
    if (Object.keys(miss).length) return
    busyRef.current = true
    setBusy(true)
    setRefusal(null)
    let out
    try {
      out = await spec.run(values)
    } catch (error) {
      out = { ok: false, message: errorText(error) }
    }
    busyRef.current = false
    setBusy(false)
    if (out && out.ok === false) {
      setRefusal(out.message || 'The house refused this.')
      return
    }
    if ($dialog.get() === spec) $dialog.set(null)
  }
  const set = (name, value) => {
    setValues(v => ({ ...v, [name]: value }))
    if (missing[name]) setMissing(m => ({ ...m, [name]: false }))
  }
  const onKeyDown = event => {
    if (event.key !== 'Enter' || event.nativeEvent?.isComposing) return
    // One submit path: Ctrl+Enter anywhere, Enter in a one-line field. The form's own submit is suppressed so a
    // keypress never sends twice.
    const oneLine = event.target && event.target.tagName === 'INPUT'
    if (event.metaKey || event.ctrlKey || (oneLine && !event.shiftKey)) {
      event.preventDefault()
      submit()
    }
  }
  const form = h(
    'form',
    { onSubmit: e => { e.preventDefault(); submit() }, onKeyDown, noValidate: true },
    spec.body,
    (spec.fields || []).map((f, i) => {
      const invalid = !!missing[f.name]
      const common = { id: `ls-f-${f.name}`, 'aria-invalid': invalid ? 'true' : undefined, value: values[f.name] || '', onChange: e => set(f.name, e.target.value), disabled: busy }
      return h(
        'div',
        { className: 'ls-field', key: f.name },
        h('label', { htmlFor: `ls-f-${f.name}` }, f.label, f.required ? '' : ' (optional)'),
        f.kind === 'textarea'
          ? h('textarea', { ...common, className: 'ls-textarea', autoFocus: i === 0, placeholder: f.placeholder })
          : f.kind === 'select'
            ? h('select', { ...common, className: 'ls-input' }, f.options.map(o => h('option', { key: o.value, value: o.value }, o.label)))
            : h('input', { ...common, className: 'ls-input', autoFocus: i === 0, type: f.kind === 'date' ? 'date' : 'text', placeholder: f.placeholder }),
        invalid ? h('div', { className: 'ls-hint bad' }, `${f.label} is required.`) : f.hint && h('div', { className: 'ls-hint' }, f.hint)
      )
    }),
    refusal && h('div', { className: 'ls-refusal', role: 'alert' }, h(Icon, { name: 'error' }), h('div', null, h('b', null, 'Not saved. '), refusal, h('div', { className: 'ls-faint', style: { marginTop: 4, fontSize: 11.5 } }, 'Your text is kept; change it and try again.'))),
    h(
      'div',
      { className: 'ls-modal-actions' },
      h('span', { className: 'ls-kbd' }, (spec.fields || []).some(f => f.kind === 'textarea') ? 'Ctrl+Enter saves' : 'Enter saves'),
      h(Btn, { onClick: close, disabled: busy, type: 'button' }, 'Cancel'),
      h(Btn, { variant: spec.destructive ? 'destructive' : 'default', type: 'submit', disabled: busy }, busy ? 'Saving…' : spec.confirm || 'Save')
    )
  )
  if (sdk.Dialog && sdk.DialogContent) {
    const Title = sdk.DialogTitle || 'h3'
    const Description = sdk.DialogDescription || 'p'
    return h(
      sdk.Dialog,
      { open: true, onOpenChange: open => !open && close() },
      h(
        sdk.DialogContent,
        { className: 'ls-tok ls-dialog', style: { maxWidth: 560 }, onEscapeKeyDown: e => busyRef.current && e.preventDefault(), onPointerDownOutside: e => busyRef.current && e.preventDefault() },
        h('div', null,
          h(Title, { className: 'ls-dialog-title' }, spec.title),
          spec.subtitle ? h(Description, { className: 'ls-sub' }, spec.subtitle) : null),
        form
      )
    )
  }
  return h(
    'div',
    { className: 'ls-tok ls-veil', onMouseDown: e => e.target === e.currentTarget && close(), onKeyDown: e => { if (e.key === 'Escape') { e.stopPropagation(); close() } } },
    h('div', { className: 'ls-modal', role: 'dialog', 'aria-modal': true }, h('h3', null, spec.title), spec.subtitle && h('p', { className: 'ls-sub' }, spec.subtitle), form)
  )
}

// -----------------------------------------------------------------------------------------------------------------
// Dialog openers: each act of the house as a form. Each `run` returns the act's answer; a refusal keeps the dialog.

const LINK_HINT = 'A [[wikilink]] to a file in the house, or a URL.'
const terminalNeedsLink = status => !['dropped', 'withdrawn', 'abandoned', 'superseded'].includes(status)

const dialogs = {
  capture(root) {
    $dialog.set({
      title: 'Capture a thought',
      subtitle: 'It lands in inbox/captures/ to sort later, saved and committed as it lands.',
      confirm: 'Capture',
      fields: [{ name: 'text', label: 'Thought', kind: 'textarea', required: true, placeholder: 'What just occurred to you' }],
      run: v => act(root, 'capture', { text: v.text }, { inline: true, apply: optimistic.add(root, 'inbox', { id: `pending-${Date.now()}`, title: v.text.split('\n')[0], kind: 'capture' }) })
    })
  },
  task(root, initial = {}) {
    $dialog.set({
      title: 'New task',
      subtitle: 'Saved in tasks/ and committed.',
      confirm: 'Create task',
      initial,
      fields: [
        { name: 'title', label: 'Title', required: true, placeholder: 'One line: what done looks like' },
        { name: 'due', label: 'Due', kind: 'date' },
        { name: 'body', label: 'Notes', kind: 'textarea', placeholder: 'Context, links, the bar it must meet' }
      ],
      run: v => act(root, 'task.new', v, { inline: true, apply: optimistic.add(root, 'tasks', { id: `pending-${Date.now()}`, title: v.title, due: v.due || null }) })
    })
  },
  done(root, item, status = 'done') {
    const done = status === 'done'
    $dialog.set({
      title: done ? 'Mark done' : 'Drop this task',
      subtitle: item.title || item.id,
      confirm: done ? 'Mark done' : 'Drop',
      destructive: !done,
      fields: [{ name: 'resolution', label: done ? 'Where the work landed' : 'Why it is dropped', required: true, placeholder: done ? '[[knowledge/...]] or https://...' : 'superseded by ...', hint: done ? LINK_HINT : 'Plain words are enough.' }],
      run: v =>
        act(root, done ? 'task.done' : 'task.set', done ? { id: item.id, resolution: v.resolution } : { id: item.id, status, resolution: v.resolution }, {
          inline: true, pending: pendKey(root, item.id), apply: optimistic.remove(root, 'tasks', item.id)
        })
    })
  },
  rule(root, item) {
    $dialog.set({
      title: 'Rule on a decision',
      subtitle: item.title || item.id,
      confirm: 'Rule',
      body: h('div', { className: 'ls-faint', style: { marginBottom: 12, fontSize: 12 } }, 'A ruling is the operator\'s. It is recorded as you write it, the decision moves to resolved/, and the change is committed.'),
      fields: [
        { name: 'resolution', label: 'Ruling', required: true, placeholder: 'Your ruling, in plain words', hint: 'Link where it lands if it does: [[...]] or a URL.' },
        { name: 'status', label: 'Outcome', kind: 'select', options: [{ value: 'decided', label: 'Decided' }, { value: 'superseded', label: 'Superseded' }, { value: 'withdrawn', label: 'Withdrawn' }] }
      ],
      initial: { status: 'decided' },
      run: v => act(root, 'decide.resolve', { id: item.id, resolution: v.resolution, status: v.status }, { inline: true, pending: pendKey(root, item.id), apply: optimistic.remove(root, 'inbox', item.id) })
    })
  },
  settle(root, item, status, verb) {
    const link = terminalNeedsLink(status)
    $dialog.set({
      title: `${verb}: ${item.title || item.id}`,
      confirm: verb,
      destructive: !link,
      fields: [{ name: 'resolution', label: link ? 'Where it landed' : 'Why', required: true, placeholder: link ? '[[tasks/...]] or https://...' : 'A plain reason', hint: link ? LINK_HINT : 'Plain words are enough.' }],
      run: v => act(root, 'inbox.set', { id: item.id, status, resolution: v.resolution }, { inline: true, pending: pendKey(root, item.id), apply: optimistic.remove(root, 'inbox', item.id) })
    })
  },
  inboxNew(root, kind) {
    const names = { idea: 'New idea', investigation: 'New investigation', decision: 'Open a decision' }
    $dialog.set({
      title: names[kind] || 'New inbox item',
      subtitle: kind === 'decision' ? 'Frame it for the operator: the question, the options, what each costs.' : 'Filed in the inbox and committed.',
      confirm: 'File',
      fields: [{ name: 'title', label: 'Title', required: true }, { name: 'body', label: 'Body', kind: 'textarea' }],
      run: v => act(root, kind === 'decision' ? 'decide.new' : 'inbox.new', kind === 'decision' ? v : { ...v, kind }, { inline: true, apply: optimistic.add(root, 'inbox', { id: `pending-${Date.now()}`, title: v.title, kind }) })
    })
  },
  note(root) {
    $dialog.set({
      title: 'New knowledge note',
      subtitle: 'A claim worth keeping, titled as the claim itself.',
      confirm: 'Write note',
      fields: [{ name: 'title', label: 'Title', required: true, placeholder: 'A convergent simulation can still…' }, { name: 'body', label: 'Body', kind: 'textarea', placeholder: 'The evidence, and [[links]] to what it touches' }],
      run: v => act(root, 'knowledge.new', v, { inline: true })
    })
  },
  reminder(root) {
    $dialog.set({
      title: 'New reminder',
      confirm: 'Set reminder',
      fields: [{ name: 'title', label: 'Remind me to', required: true }, { name: 'due', label: 'On', kind: 'date', required: true }, { name: 'body', label: 'Notes', kind: 'textarea' }],
      initial: { due: today() },
      run: v => act(root, 'remind.new', v, { inline: true, apply: optimistic.add(root, 'reminders', { id: `pending-${Date.now()}`, title: v.title, due: v.due }) })
    })
  },
  reminded(root, item) {
    $dialog.set({
      title: 'Reminder done',
      subtitle: item.title || item.id,
      confirm: 'Done',
      fields: [{ name: 'resolution', label: 'Where it landed', required: true, placeholder: '[[...]] or https://...', hint: LINK_HINT }],
      run: v => act(root, 'remind.done', { id: item.id, resolution: v.resolution }, { inline: true, pending: pendKey(root, item.id), apply: optimistic.remove(root, 'reminders', item.id) })
    })
  },
  commit(root, count) {
    $dialog.set({
      title: 'Commit the house',
      subtitle: `${plural(count || 0, 'uncommitted change')} in the house's org folders and generated files become one commit. house.toml and anything else you keep in the house are left as they are.`,
      confirm: 'Commit',
      fields: [{ name: 'message', label: 'Commit message', required: true, placeholder: 'What these changes are' }],
      initial: { message: 'Record the house\'s org changes' },
      run: v => act(root, 'record.commit', { message: v.message }, { inline: true })
    })
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Queries

const usePoll = () => useValue($prefs).poll || 20_000

const useSeat = cwd =>
  useQuery({ queryKey: [ID, 'seat', cwd || ''], queryFn: () => rest(`/seat?${q({ cwd })}`), staleTime: 15_000, refetchInterval: 60_000 })

function useOverview(root) {
  const poll = usePoll()
  return useQuery({ queryKey: [ID, 'overview', root], queryFn: () => rest(`/overview?${q({ root })}`), enabled: !!root, refetchInterval: poll, staleTime: 4_000 })
}

function useItems(root, kind, all = false) {
  const poll = usePoll()
  return useQuery({ queryKey: [ID, 'items', root, kind, all], queryFn: () => rest(`/items?${q({ root, kind, all: all ? 'true' : '' })}`), enabled: !!root, refetchInterval: poll, staleTime: 3_000 })
}

function pickInitialRoot(seat) {
  if (!seat) return null
  const live = (seat.houses || []).filter(x => !x.missing)
  const has = root => root && live.some(x => x.root === root)
  if (seat.focus && has(seat.focus)) return seat.focus
  const preferred = CTX?.storage?.get('defaultRoot', null)
  if (has(preferred)) return preferred
  const stored = CTX?.storage?.get('root', null)
  if (has(stored)) return stored
  if (seat.focus) return seat.focus
  return live.length ? live[0].root : null
}

// -----------------------------------------------------------------------------------------------------------------
// The page

function HousePage() {
  const cwd = useValue(host.state.cwd)
  const seat = useSeat(cwd)
  const root = useValue($root)
  const tab = useValue($tab)
  const reader = useValue($reader)

  useEffect(() => {
    if (!root && seat.data) {
      const pick = pickInitialRoot(seat.data)
      if (pick) $root.set(pick)
    }
  }, [seat.data, root])

  useEffect(() => {
    if (root) CTX?.storage?.set('root', root)
  }, [root])

  const overview = useOverview(root)
  const view = overview.data
  const houses = (seat.data?.houses || []).filter(x => !x.missing)

  if (seat.isLoading) return h('div', { className: 'ls-tok ls-page' }, h('div', { className: 'ls-scroll', style: { padding: 40 } }, h(Skeleton, { rows: 5 })))
  if (seat.error)
    return h('div', { className: 'ls-tok ls-page' }, h('div', { className: 'ls-scroll' }, h(Empty, { title: 'The lampstand backend did not answer' }, h('div', null, errorText(seat.error)), h('div', { style: { marginTop: 8 } }, 'Enable the lampstand plugin (Capabilities, Plugins) and restart Hermes so its backend mounts.'))))
  if (!root) return h('div', { className: 'ls-tok ls-page' }, h(NoHouse, { seat: seat.data }))

  const lamps = lampsOf(view)
  const house = view?.house || houses.find(x => x.root === root) || { name: root.split(/[\\/]/).pop() }
  const tasks = view?.tasks || []
  const overdue = [...tasks, ...(view?.reminders || [])].filter(isOverdue).length
  const counts = {
    work: { n: tasks.filter(t => !t._leaving).length, bad: overdue > 0, title: overdue ? `${overdue} overdue` : undefined },
    inbox: { n: (view?.inbox || []).filter(i => !i._leaving).length },
    constitution: { n: (view?.proposals || []).length, title: 'proposed for adoption' },
    health: { n: (view?.doctor?.findings || []).filter(f => f.level === 'error' || f.level === 'warning').length, bad: true }
  }

  return h(
    'div',
    { className: 'ls-tok ls-page' },
    h(
      'div',
      { className: 'ls-scroll' },
      h(Hero, { house, lamps, houses, root, error: overview.error }),
      h(Tabs, { tab, counts }),
      h(
        'div',
        { className: 'ls-body', key: `${root}|${tab}` },
        tab === 'overview' && h(Overview, { root, view, loading: overview.isLoading }),
        tab === 'work' && h(Work, { root }),
        tab === 'inbox' && h(Inbox, { root }),
        tab === 'knowledge' && h(Knowledge, { root }),
        tab === 'constitution' && h(Constitution, { root, house }),
        tab === 'rooms' && h(Rooms, { seat: seat.data, house, root }),
        tab === 'rhythm' && h(Rhythm, { root }),
        tab === 'health' && h(Health, { root })
      )
    ),
    reader && h(Reader, { ...reader }),
    h(ActDialog)
  )
}

function Tabs({ tab, counts }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current?.querySelector('[data-on="1"]')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])
  return h(
    'div',
    { className: 'ls-tabs-wrap' },
    h(
      'nav',
      { className: 'ls-tabs', role: 'tablist', ref },
      TABS.map(t => {
        const c = counts[t.id]
        return h(
          'button',
          { key: t.id, className: 'ls-tab', 'data-on': tab === t.id ? '1' : undefined, role: 'tab', 'aria-selected': tab === t.id, onClick: () => $tab.set(t.id), title: c?.title },
          h(Icon, { name: t.icon }),
          t.label,
          c && c.n ? h('span', { className: cls('ls-count', c.bad && 'bad') }, c.n) : null
        )
      })
    )
  )
}

function Hero({ house, lamps, houses, root, error }) {
  return h(
    'header',
    { className: 'ls-hero' },
    h(
      'div',
      { className: 'ls-hero-grid' },
      h(
        'div',
        { className: 'ls-hero-text' },
        h(
          'div',
          { className: 'ls-eyebrow' },
          h('span', null, 'lampstand house'),
          house.operator && h('span', null, 'kept by ', h('b', null, house.operator)),
          (house.co_owners || []).length > 0 && h('span', null, 'with ', h('b', null, house.co_owners.join(', '))),
          house.charter && house.charter !== 'none' && h('span', null, `${house.charter} charter`)
        ),
        h('h1', { className: 'ls-title' }, house.name),
        house.purpose && h('p', { className: 'ls-purpose', title: house.purpose }, house.purpose),
        error && h('div', { className: 'ls-refusal', style: { marginTop: 12 } }, h(Icon, { name: 'warning' }), h('div', null, errorText(error))),
        h(
          'div',
          { className: 'ls-hero-actions' },
          houses.length > 1 &&
            h('select', { className: 'ls-switch', value: root, onChange: e => { $reader.set(null); $root.set(e.target.value) }, title: 'Switch house', 'aria-label': 'Switch house' }, houses.map(x => h('option', { key: x.root, value: x.root }, x.name))),
          h(Btn, { variant: 'secondary', icon: 'lightbulb', onClick: () => dialogs.capture(root), title: 'Capture a thought' }, 'Capture'),
          h(Btn, { variant: 'secondary', icon: 'add', onClick: () => dialogs.task(root), title: 'New task' }, 'Task'),
          h(Btn, { icon: 'refresh', onClick: () => refreshHouse(root), title: 'Read the house again' }),
          CTX?.os?.revealPath && h(Btn, { icon: 'folder-opened', onClick: () => CTX.os.revealPath(root), title: 'Reveal the house folder' })
        )
      ),
      h(LampPanel, { lamps, onPick: lamp => $tab.set(lamp.tab) })
    )
  )
}

function NoHouse({ seat }) {
  const missing = (seat?.houses || []).filter(x => x.missing)
  return h(
    'div',
    { className: 'ls-scroll', style: { paddingTop: 56 } },
    h(
      'div',
      { style: { maxWidth: 640, margin: '0 auto', textAlign: 'center', padding: '0 24px' } },
      h('div', { style: { maxWidth: 300, margin: '0 auto 12px' } }, h(Lampstand, { lit: [false, false, true, false, false] })),
      h('h1', { className: 'ls-title' }, 'No house yet'),
      h('p', { className: 'ls-purpose', style: { margin: '0 auto 24px', WebkitLineClamp: 'unset' } }, 'A house is a git repository you own that holds your agent\'s principles, rules, tasks, decisions and knowledge as plain files. Plant one, then open a chat inside it.'),
      h(
        'div',
        { className: 'ls-card w12', style: { textAlign: 'left' } },
        h('div', { className: 'ls-label', style: { marginBottom: 8 } }, 'Plant a house'),
        h('div', { className: 'ls-kernel' }, 'npm install -g "github:vincitamore/lampstand#<tag>"\nlampstand init ~/houses/<name>'),
        h('div', { className: 'ls-note-line', style: { marginTop: 10 } }, `This page lists houses your sessions have worked in and every house in ${(seat?.houses_dirs || []).join(' or ') || '~/houses'}.`),
        missing.length > 0 && h('div', { className: 'ls-note-line', style: { marginTop: 8 } }, `Gone from disk: ${missing.map(m => m.root).join(', ')}`)
      )
    )
  )
}

// ---- Overview ----

function Overview({ root, view, loading }) {
  if (loading || !view)
    return h('div', { className: 'ls-grid' }, ['w7', 'w5', 'w5', 'w7'].map((w, i) => h(Card, { key: i, className: w }, h(Skeleton, { rows: 3 }))))
  const decisions = (view.inbox || []).filter(i => i.kind === 'decision' && !i._leaving)
  const proposals = view.proposals || []
  const overdue = [...(view.tasks || []), ...(view.reminders || [])].filter(isOverdue)
  const waiting = decisions.length + proposals.length + overdue.length
  const tasks = (view.tasks || []).filter(t => !t._leaving)
  const byStatus = {}
  for (const t of tasks) byStatus[isOverdue(t) ? 'overdue' : t.status] = (byStatus[isOverdue(t) ? 'overdue' : t.status] || 0) + 1
  const total = tasks.length || 1
  const kernel = view.kernel || {}
  const git = view.git || {}
  const counts = view.counts || {}
  const knowledge = Object.values(counts.knowledge || {}).reduce((a, b) => a + b, 0)
  const done = (counts.task && counts.task.done) || 0
  const committable = git.committable ?? git.dirty_count ?? 0
  const recordActions = h(
    'span',
    { className: 'ls-pills' },
    git.branch && h(Chip, null, h(Icon, { name: 'git-branch' }), git.branch),
    git.ahead ? h(Chip, { tone: 'warn' }, `${git.ahead} unpushed`) : null,
    git.behind ? h(Chip, { tone: 'warn' }, `${git.behind} behind`) : null,
    git.dirty_count ? h(Chip, { tone: 'warn' }, `${git.dirty_count} uncommitted`) : git.ok ? h(Chip, { tone: 'good' }, 'clean') : null,
    git.dirty_count > 0 && h(Btn, { size: 'xs', variant: 'secondary', icon: 'check', onClick: () => dialogs.commit(root, committable), disabled: !committable, title: committable ? 'Commit the org changes' : 'Only files outside the org folders are uncommitted' }, 'Commit')
  )

  return h(
    'div',
    { className: 'ls-grid' },
    h(
      Card,
      { title: 'Awaiting you', icon: 'bell', className: 'w7', lit: waiting > 0, actions: waiting ? h(Chip, { tone: 'accent' }, plural(waiting, 'item')) : null },
      waiting === 0
        ? h(Empty, { title: 'Nothing waits for you', lit: true }, 'Decisions the house opens, items proposed for adoption and anything overdue gather here.')
        : h(
            Fragment,
            null,
            overdue.slice(0, 3).map(o =>
              h('div', { className: 'ls-spot', key: `o-${o.path || o.id}`, 'data-tone': 'bad' },
                h('div', { className: 'ls-spot-icon' }, h(Icon, { name: 'clock' })),
                h('div', { className: 'ls-spot-main' }, h('div', { className: 'ls-spot-kind' }, `${o.kind || 'item'} · ${dueIn(o.due)}`), h('div', { className: 'ls-spot-title' }, o.title || o.id)),
                h(Btn, { onClick: () => openReader(root, o.path), icon: 'eye' }, 'Open'),
                o.kind === 'reminder' ? h(Btn, { variant: 'secondary', onClick: () => dialogs.reminded(root, o) }, 'Done') : h(Btn, { variant: 'secondary', onClick: () => dialogs.done(root, o) }, 'Done'))
            ),
            decisions.slice(0, 4).map(d =>
              h('div', { className: 'ls-spot', key: d.id, 'data-tone': 'accent' },
                h('div', { className: 'ls-spot-icon' }, h(Icon, { name: 'question' })),
                h('div', { className: 'ls-spot-main' }, h('div', { className: 'ls-spot-kind' }, `decision · opened ${d.created || ''}`), h('div', { className: 'ls-spot-title' }, d.title || d.id)),
                h(Btn, { onClick: () => openReader(root, d.path), icon: 'eye' }, 'Read'),
                h(Btn, { variant: 'default', onClick: () => dialogs.rule(root, d) }, 'Rule'))
            ),
            proposals.slice(0, 4).map(p =>
              h('div', { className: 'ls-spot', key: p.id },
                h('div', { className: 'ls-spot-icon' }, h(Icon, { name: 'law' })),
                h('div', { className: 'ls-spot-main' }, h('div', { className: 'ls-spot-kind' }, `proposed ${p.id.split('/')[0]}`), h('div', { className: 'ls-spot-title' }, p.title || slugTitle(p.id.split('/').slice(1).join('/')))),
                h(Btn, { variant: 'secondary', onClick: () => $tab.set('constitution') }, 'Review'))
            )
          )
    ),
    h(
      Card,
      { title: 'The record', icon: 'git-commit', className: 'w5', actions: recordActions },
      !git.ok
        ? h(Empty, { title: 'Not a git repository' }, 'A house keeps its history in git; acts here are saved but cannot be committed.')
        : h(
            Fragment,
            null,
            h('div', { className: 'ls-note-line', style: { marginBottom: 10 } }, 'Each act on this page is saved and committed as it lands.'),
            h('div', { className: 'ls-timeline' }, (git.commits || []).slice(0, 5).map(c =>
              h('div', { className: 'ls-tl', key: c.sha }, h('div', { className: 'ls-item-title' }, c.subject), h('div', { className: 'ls-tl-sub' }, h('span', { className: 'ls-mono' }, c.sha), ` · ${c.author} · ${ago(c.at)}`))))
          )
    ),
    h(
      Card,
      { title: 'Work', icon: 'checklist', className: 'w7', actions: h(Fragment, null, h(Btn, { size: 'xs', icon: 'add', onClick: () => dialogs.task(root), title: 'New task' }), h(Btn, { size: 'xs', onClick: () => $tab.set('work') }, 'All work')) },
      h('div', { className: 'ls-row', style: { alignItems: 'baseline', gap: 8 } }, h('span', { className: 'ls-big' }, tasks.length), h('span', { className: 'ls-muted' }, `open · ${done} done`), overdue.length ? h(Chip, { tone: 'bad' }, `${overdue.length} overdue`) : null),
      h(
        'div',
        { className: 'ls-stack' },
        ['overdue', 'active', 'open', 'blocked'].map(s =>
          byStatus[s] ? h('i', { key: s, title: `${byStatus[s]} ${s}`, style: { width: `${(byStatus[s] / total) * 100}%`, background: s === 'overdue' ? 'var(--ls-red)' : s === 'active' ? 'var(--ls-accent)' : s === 'blocked' ? 'var(--ui-orange,var(--ls-yellow))' : 'color-mix(in oklab,var(--ui-text-primary) 22%,transparent)' } }) : null
        )
      ),
      h(TaskList, { root, items: sortTasks(tasks).slice(0, 6), compact: true })
    ),
    h(
      Card,
      { title: 'The kernel', icon: 'symbol-constant', className: 'w5', actions: h(Btn, { size: 'xs', onClick: () => act(root, 'compile') }, 'Compile') },
      h(
        'div',
        { className: 'ls-row', style: { gap: 18 } },
        h(Arc, { value: kernel.chars || 0, cap: kernel.cap || 4000, label: 'of budget' }),
        h('dl', { className: 'ls-kv ls-num', style: { flex: 1 } },
          h('dt', null, 'Size'), h('dd', null, `${(kernel.chars ?? 0).toLocaleString()} / ${(kernel.cap ?? 4000).toLocaleString()} chars`),
          h('dt', null, 'Projections'), h('dd', null, (view.fresh?.stale || []).length ? h(Chip, { tone: 'warn' }, `stale: ${view.fresh.stale.join(', ')}`) : h(Chip, { tone: 'good' }, 'fresh')),
          h('dt', null, 'Charter'), h('dd', null, view.house?.charter || 'none'),
          h('dt', null, 'Gate'), h('dd', null, view.house?.gate || 'off'))
      ),
      h('div', { className: 'ls-note-line', style: { marginTop: 12 } }, 'Every session in this house starts with the kernel: its purpose, principles and ask-first lines.')
    ),
    h(
      Card,
      { title: 'Inbox', icon: 'inbox', className: 'w4', actions: h(Btn, { size: 'xs', onClick: () => $tab.set('inbox') }, 'Open') },
      h('div', { className: 'ls-row', style: { alignItems: 'baseline', gap: 8 } }, h('span', { className: 'ls-big' }, (view.inbox || []).length), h('span', { className: 'ls-muted' }, 'open')),
      h('div', { className: 'ls-pills', style: { marginTop: 12 } }, ['decision', 'idea', 'investigation', 'capture'].map(k => {
        const n = (view.inbox || []).filter(i => i.kind === k).length
        return n ? h(Chip, { key: k, tone: k === 'decision' ? 'accent' : undefined }, plural(n, k)) : null
      }))
    ),
    h(
      Card,
      { title: 'Knowledge', icon: 'book', className: 'w4', actions: h(Btn, { size: 'xs', onClick: () => $tab.set('knowledge') }, 'Browse') },
      h('div', { className: 'ls-row', style: { alignItems: 'baseline', gap: 8 } }, h('span', { className: 'ls-big' }, knowledge), h('span', { className: 'ls-muted' }, knowledge === 1 ? 'note kept' : 'notes kept')),
      h('div', { className: 'ls-note-line', style: { marginTop: 12 } }, 'What the house has learned, each note titled as its claim.')
    ),
    h(Card, { title: 'Rooms', icon: 'comment-discussion', className: 'w4', actions: h(Btn, { size: 'xs', onClick: () => $tab.set('rooms') }, 'Enter') }, h(RoomsSummary, { view })),
    (view.problems || []).length > 0 &&
      h(Card, { title: 'Problems', icon: 'warning', className: 'w12' },
        view.problems.map((p, i) => h('div', { key: i, className: 'ls-finding', 'data-l': p.level || 'warning' }, h(Icon, { name: 'warning' }), h('div', { style: { flex: 1, minWidth: 0 } }, h('div', null, p.message || p.code), p.path && h('code', { style: { cursor: 'pointer' }, onClick: () => openReader(root, p.path) }, p.path)))))
  )
}

function RoomsSummary({ view }) {
  const rooms = view.rooms || {}
  const agora = rooms.agora || {}
  const listens = useQuery({ queryKey: [ID, 'listens'], queryFn: () => rest('/listens'), refetchInterval: 30_000 })
  if (!agora.version) return h('div', { className: 'ls-note-line' }, 'agora is not installed. Rooms let your agents and the people they work with share one conversation.')
  const n = (listens.data?.listens || []).length
  return h(
    'dl',
    { className: 'ls-kv' },
    h('dt', null, 'agora'), h('dd', null, `${agora.version}${agora.problem ? ` (${agora.problem})` : ''}`),
    h('dt', null, 'Signs as'), h('dd', null, rooms.bearer?.name || 'the seat default'),
    h('dt', null, 'Module'), h('dd', null, rooms.house?.rooms ? h(Chip, { tone: 'good' }, 'on') : h(Chip, null, 'off')),
    h('dt', null, 'Listening'), h('dd', null, n ? plural(n, 'chat') : 'no chat yet')
  )
}

// ---- Work ----

const TASK_FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'active', label: 'Active' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'all', label: 'With resolved' }
]

function TaskRow({ root, t, compact }) {
  const pending = useValue($pending)[pendKey(root, t.id)]
  const busy = !!pending || t._pending || t._leaving
  const resolved = ['done', 'dropped'].includes(t.status)
  const overdue = isOverdue(t)
  const sub = [
    overdue ? 'overdue' : t.status,
    t.created && `opened ${t.created}`,
    t.resolution && (t.status === 'dropped' ? `dropped: ${t.resolution}` : `landed: ${t.resolution}`)
  ].filter(Boolean).join(' · ')
  const start = () => act(root, 'task.set', { id: t.id, status: 'active' }, { quiet: true, pending: pendKey(root, t.id), pendingLabel: 'Starting', apply: optimistic.status(root, 'tasks', t.id, 'active') })
  const block = () => act(root, 'task.set', { id: t.id, status: 'blocked' }, { quiet: true, pending: pendKey(root, t.id), pendingLabel: 'Blocking', apply: optimistic.status(root, 'tasks', t.id, 'blocked') })
  return h(
    'div',
    { className: 'ls-item click', 'data-pending': busy ? '1' : undefined, 'data-leaving': t._leaving ? '1' : undefined, onClick: () => !t._pending && openReader(root, t.path) },
    h(Dot, { status: overdue ? 'overdue' : t.status }),
    h('div', { className: 'ls-item-main' }, h('div', { className: 'ls-item-title' }, t.title || t.id), !compact && h('div', { className: 'ls-item-sub' }, sub)),
    t.due && !resolved && h(Chip, { tone: dueTone(t), title: t.due }, dueIn(t.due)),
    t._pending ? h(Busy, null, 'Adding') : pending ? h(Busy, null, pending) : null,
    !resolved && !t._pending && !t._leaving &&
      h('div', { className: 'ls-item-actions', onClick: e => e.stopPropagation() },
        t.status !== 'active' && h(Btn, { size: 'xs', onClick: start, disabled: busy, title: 'Start this task' }, 'Start'),
        t.status !== 'blocked' && !compact && h(Btn, { size: 'xs', onClick: block, disabled: busy, title: 'Mark it blocked' }, 'Block'),
        h(Btn, { size: 'xs', variant: 'secondary', onClick: () => dialogs.done(root, t), disabled: busy }, 'Done'),
        !compact && h(Btn, { size: 'xs', onClick: () => dialogs.done(root, t, 'dropped'), disabled: busy }, 'Drop'))
  )
}

function TaskList({ root, items, compact }) {
  if (!items.length) return compact ? h('div', { className: 'ls-note-line', style: { padding: '6px 0' } }, 'No open tasks.') : h(Empty, { title: 'No tasks here' }, 'Add one above; it is saved in tasks/ and committed.')
  return h('div', { className: 'ls-rows' }, items.map(t => h(TaskRow, { key: t.id, root, t, compact })))
}

function Work({ root }) {
  const [filter, setFilter] = useState('open')
  const [title, setTitle] = useState('')
  const all = useItems(root, 'tasks', filter === 'all')
  const rows = sortTasks((all.data?.items || []).filter(t => (filter === 'all' ? true : filter === 'open' ? !TERMINAL.includes(t.status) || t._leaving : t.status === filter)))
  const reminders = useItems(root, 'reminders')
  const quickAdd = () => {
    const text = title.trim()
    if (!text) return
    setTitle('')
    act(root, 'task.new', { title: text }, { apply: optimistic.add(root, 'tasks', { id: `pending-${Date.now()}`, title: text }) }).then(out => {
      if (out.ok === false) setTitle(t => t || text)
    })
  }
  const reminderRows = [...(reminders.data?.items || [])].sort((a, b) => String(a.due).localeCompare(String(b.due)))
  return h(
    'div',
    { className: 'ls-grid' },
    h(
      Card,
      { title: 'Tasks', icon: 'checklist', className: 'w8' },
      h('div', { className: 'ls-compose' },
        h(Icon, { name: 'add' }),
        h('input', { className: 'ls-input', placeholder: 'Add a task and press Enter', value: title, onChange: e => setTitle(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); quickAdd() } }, 'aria-label': 'New task title' }),
        h(Btn, { size: 'xs', onClick: () => dialogs.task(root, title.trim() ? { title: title.trim() } : {}) }, 'With details')),
      h('div', { className: 'ls-toolbar' }, h('div', { className: 'ls-pills' }, TASK_FILTERS.map(f => h(Chip, { key: f.id, on: filter === f.id, onClick: () => setFilter(f.id) }, f.label)))),
      all.isLoading ? h(Skeleton, null) : all.error ? h(Empty, { title: 'Tasks could not be read' }, errorText(all.error)) : h(TaskList, { root, items: rows })
    ),
    h(
      Card,
      { title: 'Reminders', icon: 'bell', className: 'w4', actions: h(Btn, { size: 'xs', icon: 'add', onClick: () => dialogs.reminder(root), title: 'New reminder' }) },
      reminders.isLoading ? h(Skeleton, null) : reminderRows.length === 0 ? h(Empty, { title: 'Nothing scheduled' }, 'A reminder brings something back on a date.') : h(ReminderList, { root, items: reminderRows })
    )
  )
}

function ReminderList({ root, items }) {
  const pending = useValue($pending)
  return h(
    'div',
    { className: 'ls-timeline' },
    items.map(r => {
      const busy = !!pending[pendKey(root, r.id)] || r._pending || r._leaving
      return h(
        'div',
        { className: 'ls-tl', key: r.id, style: { opacity: busy ? 0.6 : 1 } },
        h('div', { className: 'ls-row' }, h('div', { className: 'ls-item-title', style: { flex: 1, cursor: 'pointer' }, onClick: () => !r._pending && openReader(root, r.path) }, r.title), busy ? h(Busy, null, r._pending ? 'Adding' : 'Saving') : h(Btn, { size: 'xs', onClick: () => dialogs.reminded(root, r) }, 'Done')),
        h('div', { className: 'ls-tl-sub' }, h(Chip, { tone: dueTone(r) }, dueIn(r.due)), ` ${r.due || ''}`)
      )
    })
  )
}

// ---- Inbox ----

const INBOX_KINDS = [
  { id: 'all', label: 'Everything' },
  { id: 'decision', label: 'Decisions' },
  { id: 'idea', label: 'Ideas' },
  { id: 'investigation', label: 'Investigations' },
  { id: 'capture', label: 'Captures' }
]
const KIND_ICON = { decision: 'question', idea: 'lightbulb', investigation: 'search', capture: 'note' }

function inboxActions(root, item, busy) {
  const b = (key, label, onClick, variant) => h(Btn, { key, size: 'xs', variant, onClick, disabled: busy }, label)
  switch (item.kind) {
    case 'decision':
      return [b('r', 'Rule', () => dialogs.rule(root, item), 'default')]
    case 'idea':
      return [b('a', 'Adopt', () => dialogs.settle(root, item, 'adopted', 'Adopt'), 'secondary'), b('d', 'Drop', () => dialogs.settle(root, item, 'dropped', 'Drop'))]
    case 'investigation':
      return [
        item.status !== 'active' && b('s', 'Start', () => act(root, 'inbox.set', { id: item.id, status: 'active' }, { quiet: true, pending: pendKey(root, item.id), pendingLabel: 'Starting', apply: optimistic.status(root, 'inbox', item.id, 'active') })),
        b('c', 'Conclude', () => dialogs.settle(root, item, 'concluded', 'Conclude'), 'secondary'),
        b('x', 'Abandon', () => dialogs.settle(root, item, 'abandoned', 'Abandon'))
      ]
    case 'capture':
      return [b('f', 'File', () => dialogs.settle(root, item, 'filed', 'File'), 'secondary'), b('d', 'Drop', () => dialogs.settle(root, item, 'dropped', 'Drop'))]
    default:
      return []
  }
}

function Inbox({ root }) {
  const [kind, setKind] = useState('all')
  const [thought, setThought] = useState('')
  const inbox = useItems(root, 'inbox')
  const pending = useValue($pending)
  const all = inbox.data?.items || []
  const items = all.filter(i => kind === 'all' || i.kind === kind)
  const capture = () => {
    const text = thought.trim()
    if (!text) return
    setThought('')
    act(root, 'capture', { text }, { apply: optimistic.add(root, 'inbox', { id: `pending-${Date.now()}`, title: text.split('\n')[0], kind: 'capture' }) }).then(out => {
      if (out.ok === false) setThought(t => t || text)
    })
  }
  return h(
    Card,
    {
      title: 'Inbox', icon: 'inbox', className: 'w12',
      actions: h('div', { className: 'ls-pills' },
        h(Btn, { size: 'xs', icon: 'question', onClick: () => dialogs.inboxNew(root, 'decision') }, 'Decision'),
        h(Btn, { size: 'xs', icon: 'lightbulb', onClick: () => dialogs.inboxNew(root, 'idea') }, 'Idea'),
        h(Btn, { size: 'xs', icon: 'search', onClick: () => dialogs.inboxNew(root, 'investigation') }, 'Investigation'))
    },
    h('div', { className: 'ls-compose' }, h(Icon, { name: 'lightbulb' }),
      h('input', { className: 'ls-input', placeholder: 'Capture a thought and press Enter; sort it later', value: thought, onChange: e => setThought(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); capture() } }, 'aria-label': 'Capture a thought' })),
    h('div', { className: 'ls-toolbar' }, h('div', { className: 'ls-pills' }, INBOX_KINDS.map(k => {
      const n = k.id === 'all' ? all.length : all.filter(i => i.kind === k.id).length
      return h(Chip, { key: k.id, on: kind === k.id, onClick: () => setKind(k.id) }, `${k.label}${n ? ` ${n}` : ''}`)
    }))),
    inbox.isLoading
      ? h(Skeleton, null)
      : items.length === 0
        ? h(Empty, { title: 'The inbox is clear', lit: true }, 'Captures, ideas, investigations and decisions land here until they are sorted.')
        : h('div', { className: 'ls-rows' }, items.map(i => {
            const busy = !!pending[pendKey(root, i.id)] || i._pending || i._leaving
            return h(
              'div',
              { className: 'ls-item click', key: i.id || i.path, 'data-pending': busy ? '1' : undefined, 'data-leaving': i._leaving ? '1' : undefined, onClick: () => !i._pending && openReader(root, i.path) },
              h('div', { className: 'ls-spot-icon', style: { width: 26, height: 26 } }, h(Icon, { name: KIND_ICON[i.kind] || 'circle-outline' })),
              h('div', { className: 'ls-item-main' }, h('div', { className: 'ls-item-title' }, i.title || i.id), h('div', { className: 'ls-item-sub' }, [i.kind, i.status, i.created].filter(Boolean).join(' · '))),
              i.kind === 'decision' && !busy && h(Chip, { tone: 'accent' }, 'awaits a ruling'),
              busy ? h(Busy, null, i._pending ? 'Adding' : pending[pendKey(root, i.id)] || 'Saving') : h('div', { className: 'ls-item-actions', onClick: e => e.stopPropagation() }, inboxActions(root, i, busy))
            )
          }))
  )
}

// ---- Knowledge ----

function Knowledge({ root }) {
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const notes = useItems(root, 'knowledge', all)
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const items = notes.data?.items || []
  const rows = items.filter(n => words.every(w => `${n.title || ''} ${n.id} ${n.excerpt || ''} ${(n.tags || []).join(' ')}`.toLowerCase().includes(w)))
  return h(
    'div',
    null,
    h('div', { className: 'ls-toolbar' },
      h('div', { className: 'ls-compose', style: { margin: 0, flex: '1 1 260px', maxWidth: 420 } }, h(Icon, { name: 'search' }), h('input', { className: 'ls-input', placeholder: 'Search titles, text and tags', value: query, onChange: e => setQuery(e.target.value), 'aria-label': 'Search notes' })),
      h(Chip, { on: all, onClick: () => setAll(!all) }, 'Include superseded'),
      h('span', { className: 'ls-spacer' }),
      h('span', { className: 'ls-muted ls-num' }, query ? `${rows.length} of ${items.length}` : plural(items.length, 'note')),
      h(Btn, { variant: 'secondary', icon: 'add', onClick: () => dialogs.note(root) }, 'Note')),
    notes.isLoading
      ? h('div', { className: 'ls-notes' }, [0, 1, 2, 3].map(i => h('div', { key: i, className: 'ls-shimmer', style: { height: 150 } })))
      : rows.length === 0
        ? h(Empty, { title: query ? 'No note matches' : 'No knowledge yet', action: !query && h(Btn, { variant: 'secondary', icon: 'add', onClick: () => dialogs.note(root) }, 'Write the first note') }, query ? 'Try fewer words.' : 'A note keeps one claim the house has learned, titled as the claim.')
        : h('div', { className: 'ls-notes' }, rows.map((n, i) =>
            h(
              'div',
              { className: 'ls-note ls-enter', key: n.path, style: { animationDelay: `${Math.min(i, 12) * 30}ms` }, onClick: () => openReader(root, n.path), role: 'button', tabIndex: 0, onKeyDown: e => e.key === 'Enter' && openReader(root, n.path) },
              h('div', { className: 'ls-note-title' }, n.title || n.id),
              n.excerpt ? h('div', { className: 'ls-note-excerpt' }, n.excerpt) : n.excerpt === '' ? h('div', { className: 'ls-note-excerpt', style: { fontStyle: 'italic' } }, 'No text yet.') : h('div', { className: 'ls-note-excerpt' }),
              h('div', { className: 'ls-note-meta' },
                (n.tags || []).slice(0, 3).map(t => h(Chip, { key: t }, t)),
                n.status && n.status !== 'current' && h(Chip, { tone: 'warn' }, n.status),
                h('span', { className: 'ls-spacer' }),
                typeof n.links === 'number' && n.links > 0 && h('span', { title: 'Links this note makes' }, `${plural(n.links, 'link')}`),
                n.created && h('span', { className: 'ls-num' }, n.created))
            )
          ))
  )
}

// ---- Constitution ----

function stripFront(text) {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(String(text || ''))
  return m ? String(text).slice(m[0].length) : String(text || '')
}

function proposalOf(p) {
  if (p.body !== undefined) return p
  const body = stripFront(p.text).trim()
  const lines = body.split('\n')
  const m = /^#{1,4}\s+(?:[A-Za-z0-9._-]+\s*:\s*)?(.+?)\s*$/.exec(lines[0] || '')
  const occ = /(^|\n)occasion:\s*"?(.*?)"?\s*(\n|$)/.exec(String(p.text || ''))
  return { ...p, title: m ? m[1] : slugTitle(p.id.split('/').slice(1).join('/')), body: (m ? lines.slice(1).join('\n') : body).trim(), occasion: occ ? occ[2] : '' }
}

function Markdown({ text }) {
  const Md = sdk.MessageTextContent
  return Md ? h(Md, { text, media: false }) : h('div', { style: { whiteSpace: 'pre-wrap' } }, text)
}

async function fetchLint(root) {
  try {
    return await rest(`/lint?${q({ root })}`)
  } catch (error) {
    // An older backend has no /lint: its lint act answers ok:false with the findings it found.
    const data = await rest('/act', { method: 'POST', body: { root, action: 'lint', params: {} } })
    if (Array.isArray(data?.findings)) return { ok: true, findings: data.findings }
    throw error
  }
}

function LintPanel({ root }) {
  const lint = useQuery({ queryKey: [ID, 'lint', root], queryFn: () => fetchLint(root), staleTime: 10_000 })
  const findings = [...(lint.data?.findings || [])].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
  const errors = findings.filter(f => f.level === 'error').length
  return h(
    Card,
    { title: 'Lint', icon: 'checklist', className: 'w12', actions: h(Btn, { size: 'xs', icon: 'refresh', onClick: () => lint.refetch(), disabled: lint.isFetching }, lint.isFetching ? 'Checking…' : 'Check again') },
    lint.isLoading
      ? h(Skeleton, { rows: 2 })
      : lint.error
        ? h('div', { className: 'ls-refusal' }, h(Icon, { name: 'error' }), errorText(lint.error))
        : findings.length === 0
          ? h('div', { className: 'ls-row' }, h(Chip, { tone: 'good' }, 'clean'), h('span', { className: 'ls-note-line' }, 'Every org item parses, sits where it belongs and links to files that exist.'))
          : h(Fragment, null,
              h('div', { className: 'ls-note-line', style: { marginBottom: 10 } }, `${plural(findings.length, 'finding')}${errors ? `, ${plural(errors, 'error')}` : ''}. Click a path to open the file.`),
              findings.slice(0, 60).map((f, i) =>
                h('div', { key: i, className: 'ls-finding', 'data-l': f.level },
                  h(Icon, { name: f.level === 'error' ? 'error' : f.level === 'warning' ? 'warning' : 'info' }),
                  h('div', { style: { flex: 1, minWidth: 0 } }, h('div', null, f.message), f.path && h('code', { style: { cursor: 'pointer', display: 'inline-block', marginTop: 6 }, onClick: () => openReader(root, f.path) }, `${f.path}${f.line ? `:${f.line}` : ''}`)),
                  h('span', { className: 'ls-faint ls-mono', style: { fontSize: 10.5 } }, f.rule || f.code))))
  )
}

function Constitution({ root, house }) {
  const poll = usePoll()
  const data = useQuery({ queryKey: [ID, 'constitution', root], queryFn: () => rest(`/constitution?${q({ root })}`), refetchInterval: poll })
  const [confirm, setConfirm] = useState(null)
  const [showLint, setShowLint] = useState(false)
  const pending = useValue($pending)
  if (data.isLoading) return h(Skeleton, { rows: 6 })
  if (data.error) return h(Empty, { title: 'The constitution could not be read' }, errorText(data.error))
  const c = data.data
  const kernel = c.kernel || {}
  const surfaces = Object.entries(kernel.surfaces || {})
  const operator = house.operator || 'the operator'
  const proposals = (c.proposals || []).map(proposalOf)
  return h(
    'div',
    { className: 'ls-grid' },
    proposals.length > 0 &&
      h(
        Card,
        { title: 'Proposed for adoption', icon: 'law', className: 'w12', lit: true, actions: h(Chip, { tone: 'accent' }, plural(proposals.length, 'proposal')) },
        h('div', { className: 'ls-note-line', style: { marginBottom: 12 } }, `Principles, provisions and updates are adopted by the operator (house.toml names ${operator}); a reflex the house's agent may admit. Adopting or striking is saved and committed.`),
        proposals.map(p => {
          const busy = !!pending[pendKey(root, p.id)]
          return h(
            'article',
            { className: 'ls-proposal ls-enter', key: p.id },
            h('div', { className: 'ls-proposal-head' },
              h(Chip, { tone: 'accent' }, p.id.split('/')[0]),
              h('div', { className: 'ls-proposal-title' }, p.title),
              h('span', { className: 'ls-faint ls-num', style: { fontSize: 11 } }, `${(p.chars ?? 0).toLocaleString()} chars${p.surface ? ` · ${p.surface} ${(p.surfaceChars ?? 0).toLocaleString()}/${(p.cap ?? 0).toLocaleString()}` : ''}`),
              busy ? h(Busy, null, pending[pendKey(root, p.id)]) : h(Fragment, null,
                p.path && h(Btn, { size: 'xs', icon: 'eye', onClick: () => openReader(root, p.path), title: 'Open the file' }),
                h(Btn, { size: 'xs', onClick: () => setConfirm({ item: p, how: 'strike' }) }, 'Strike'),
                h(Btn, { size: 'xs', variant: 'default', onClick: () => setConfirm({ item: p, how: 'adopt' }) }, 'Adopt'))),
            h('div', { className: 'ls-proposal-body' },
              p.occasion && h('blockquote', { className: 'ls-occasion' }, h('small', null, 'the occasion'), p.occasion),
              h('div', { className: 'ls-md' }, h(Markdown, { text: p.body || '' })))
          )
        })
      ),
    h(
      Card,
      {
        title: 'The kernel', icon: 'symbol-constant', className: 'w7',
        actions: h('div', { className: 'ls-pills' }, h(Btn, { size: 'xs', onClick: () => act(root, 'compile') }, 'Compile'), h(Btn, { size: 'xs', onClick: () => setShowLint(true), variant: showLint ? 'secondary' : 'ghost' }, 'Lint'))
      },
      h('div', { className: 'ls-row', style: { marginBottom: 10 } }, h('div', { style: { flex: 1 } }, h(Meter, { value: kernel.chars || 0, cap: kernel.cap || 4000 })), h('span', { className: 'ls-faint ls-mono ls-num' }, `${(kernel.chars ?? 0).toLocaleString()} / ${(kernel.cap ?? 4000).toLocaleString()}`)),
      kernel.compiled ? h('div', { className: 'ls-kernel' }, kernel.text) : h(Empty, { title: 'Not compiled yet', action: h(Btn, { variant: 'secondary', onClick: () => act(root, 'compile') }, 'Compile now') }, 'Compiling writes the kernel every session in this house starts with.')
    ),
    h(
      Card,
      { title: 'Its files', icon: 'files', className: 'w5' },
      (c.groups || []).map(g =>
        h('div', { key: g.name, style: { marginBottom: 14 } },
          h('div', { className: 'ls-spot-kind', style: { marginBottom: 4 } }, g.name),
          g.files.length === 0
            ? h('div', { className: 'ls-note-line' }, 'none yet')
            : g.files.map(f => h('div', { className: 'ls-item click', key: f.path, onClick: () => openReader(root, f.path) }, h(Icon, { name: 'file' }), h('div', { className: 'ls-item-main' }, h('div', { className: 'ls-item-title' }, f.title)), h('span', { className: 'ls-faint ls-mono ls-num' }, (f.chars || 0).toLocaleString()))))
      )
    ),
    showLint && h(LintPanel, { root }),
    surfaces.length > 0 &&
      h(Card, { title: 'Compiled surfaces', icon: 'layers', className: 'w12' },
        h('table', { className: 'ls-table' },
          h('thead', null, h('tr', null, h('th', null, 'Surface'), h('th', null, 'Size'), h('th', { style: { width: '40%' } }, 'Budget'))),
          h('tbody', null, surfaces.map(([name, s]) =>
            h('tr', { key: name }, h('td', { className: 'ls-mono' }, name), h('td', { className: 'ls-mono ls-num' }, `${(s.chars ?? 0).toLocaleString()} / ${(s.cap ?? 0).toLocaleString()}${s.tokens ? ` (~${s.tokens.toLocaleString()} tokens)` : ''}`), h('td', null, h(Meter, { value: s.chars, cap: s.cap }))))))),
    confirm &&
      ConfirmDialog &&
      h(ConfirmDialog, {
        open: true,
        onClose: () => setConfirm(null),
        title: confirm.how === 'adopt' ? `Adopt “${confirm.item.title}”?` : `Strike “${confirm.item.title}”?`,
        description: confirm.item.id.startsWith('reflex/')
          ? 'A reflex is admitted into the house\'s reflexes and the projections recompile. The change is committed.'
          : `This is the operator's act${house.operator ? ` (${house.operator})` : ''}. ${confirm.how === 'adopt' ? 'It joins the constitution and the kernel recompiles' : 'It is recorded as struck'}, and the change is committed.`,
        confirmLabel: confirm.how === 'adopt' ? 'Adopt' : 'Strike',
        destructive: confirm.how === 'strike',
        onConfirm: async () => {
          const item = confirm.item
          const out = await act(root, confirm.how, { ids: [item.id] }, { pending: pendKey(root, item.id), pendingLabel: confirm.how === 'adopt' ? 'Adopting' : 'Striking' })
          if (out.ok !== false) setConfirm(null)
        }
      })
  )
}

// ---- Rooms ----

function useRoomView(room) {
  const seenKey = `seen:${room || ''}`
  return useQuery({
    queryKey: [ID, 'room', room || ''],
    queryFn: async () => {
      const stored = CTX?.storage?.get(seenKey, null) || {}
      return rest('/rooms/view', { method: 'POST', body: { room: room || '', seen: stored.seen || {}, baselineId: stored.baselineId || null, hasBaseline: !!stored.hasBaseline } })
    },
    refetchInterval: ROOM_POLL_MS
  })
}

function markSeen(room, view, subject) {
  if (!room || !view) return
  const key = `seen:${room}`
  const stored = CTX?.storage?.get(key, null) || {}
  const seen = { ...(stored.seen || {}) }
  if (subject) seen[subject.id] = subject.latestId
  CTX?.storage?.set(key, { seen, baselineId: view.baselineId, hasBaseline: true })
}

const age = value => {
  const s = String(value || '')
  const m = /^(\d+)s$/.exec(s)
  return m && Number(m[1]) < 60 ? 'just now' : s
}

function Rooms({ seat, house, root }) {
  const selected = useValue($room)
  const view = useRoomView(selected)
  const listens = useQuery({ queryKey: [ID, 'listens'], queryFn: () => rest('/listens'), refetchInterval: 15_000 })
  const [subjectId, setSubjectId] = useState(null)
  const agora = seat?.agora || {}
  const data = view.data || {}

  useEffect(() => {
    if (!selected && data.room) $room.set(data.room)
  }, [data.room, selected])
  useEffect(() => {
    if (data.ok && data.room && !CTX?.storage?.get(`seen:${data.room}`, null)) markSeen(data.room, data, null)
  }, [data.room, data.baselineId])

  if (!agora.installed || agora.problem)
    return h(Card, { title: 'Rooms', icon: 'comment-discussion', className: 'w12' },
      h(Empty, { title: agora.problem || 'agora is not installed' },
        h('div', null, 'Rooms are shared conversations where your agents and the people they work with meet: a native room on this machine, a Slack channel, a GitHub issue. They come from agora, a separate open-source package.'),
        h('div', { className: 'ls-kernel', style: { marginTop: 12, textAlign: 'left' } }, 'npm install -g "github:vincitamore/agora#<tag>"')))

  const subjects = data.subjects || []
  const subject = subjects.find(s => s.id === subjectId) || null
  const roomListens = (listens.data?.listens || []).filter(l => l.room === data.room)

  return h(
    Fragment,
    null,
    h(WakeBanner, { seat, listens: listens.data }),
    h(
      'div',
      { className: 'ls-rooms' },
      h('div', { className: 'ls-col' },
        h('div', { className: 'ls-col-head' }, h('span', { className: 'ls-label' }, 'Rooms')),
        h('div', { className: 'ls-col-body' }, (data.rooms || []).map(r =>
          h('div', { key: r.alias, className: 'ls-roomrow', 'data-on': r.alias === data.room ? '1' : undefined, onClick: () => { setSubjectId(null); $room.set(r.alias) }, title: [r.alias, r.note].filter(Boolean).join(' · ') },
            h('span', { className: 'ls-hash' }, '#'),
            h('span', { className: 'ls-room-name' }, r.alias),
            h('span', { className: 'ls-faint', style: { fontSize: 10, flex: 'none' } }, r.transport))))),
      h('div', { className: 'ls-col' },
        h('div', { className: 'ls-col-head' },
          h('span', { className: 'ls-label', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, data.room ? `#${data.room}` : 'Subjects'),
          h('span', { style: { flex: 1 } }),
          view.isFetching && h(Busy, null, 'reading'),
          h(Btn, { size: 'xs', icon: 'add', title: 'Open a new subject', onClick: () => setSubjectId('new') })),
        data.fault && h('div', { className: 'ls-banner', style: { margin: 8 } }, h(Icon, { name: 'warning' }), h('div', null, data.fault.reason || data.fault.kind)),
        h('div', { className: 'ls-col-body' },
          view.isLoading ? h(Skeleton, { rows: 6 }) : subjects.length === 0 ? h(Empty, { title: 'A quiet room' }, 'Open a subject with + to start the conversation.') :
          subjects.map(s =>
            h('div', { key: s.id, className: 'ls-subject', 'data-on': s.id === subjectId ? '1' : undefined, onClick: () => { setSubjectId(s.id); markSeen(data.room, data, s) } },
              h('div', { className: 'ls-row', style: { alignItems: 'flex-start' } }, h('div', { className: 'ls-subject-title', style: { flex: 1 } }, s.title), s.unread ? h('span', { className: 'ls-unread' }, s.unread) : null),
              h('div', { className: 'ls-item-sub' }, [s.lastFrom || s.rootFrom, age(s.age), s.replies && plural(s.replies, 'reply', 'replies')].filter(Boolean).join(' · ')))))),
      h('div', { className: 'ls-col' },
        h('div', { className: 'ls-col-head' },
          h('span', { className: 'ls-label', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, subject ? subject.fullTitle || subject.title : subjectId === 'new' ? 'A new subject' : data.room ? `#${data.room}` : ''),
          h(ListenControl, { room: data.room, listens: roomListens, house, root })),
        subject
          ? h('div', { className: 'ls-thread' }, (subject.messages || []).map(m => h(Message, { key: m.id, m })))
          : subjectId === 'new'
            ? h('div', { className: 'ls-thread' }, h('div', { className: 'ls-note-line' }, 'Write the opening message below; it starts a subject of its own.'))
            : h(RoomSide, { data }),
        data.room && (subject || subjectId === 'new') && h(Composer, { data, subject, onPosted: id => id && subjectId === 'new' && setSubjectId(id) }))
    )
  )
}

function Message({ m }) {
  const notes = [m.note, m.attachmentText].filter(Boolean)
  const shown = notes.filter(n => !/\bhop\s+\d+\b/i.test(n))
  const hidden = notes.filter(n => /\bhop\s+\d+\b/i.test(n))
  return h(
    'div',
    { className: cls('ls-msg', m.kind === 'human' ? 'human' : 'agent', m.mine && 'mine', m.depth > 0 && 'reply'), title: hidden.join(' · ') || undefined },
    h('div', { className: 'ls-msg-head' },
      h('span', { className: 'ls-msg-from' }, m.from),
      m.kind === 'human' && h(Chip, { tone: 'accent' }, 'human'),
      m.seatLabel && h('span', { className: 'ls-faint', style: { fontSize: 11 } }, m.seatLabel),
      h('span', { className: 'ls-faint', style: { fontSize: 11, marginLeft: 'auto' } }, age(m.age)),
      (m.to || []).length > 0 && h(Chip, null, `to ${m.to.join(', ')}`)),
    h('div', { className: 'ls-msg-body' }, m.body),
    shown.length > 0 && h('div', { className: 'ls-msg-note' }, shown.join(' · '))
  )
}

function RoomSide({ data }) {
  const claims = (data.board?.claims || []).slice(0, 8)
  const who = (data.board?.who || []).slice(0, 10)
  const sessions = (data.sessions?.items || []).filter(s => s.state === 'live').slice(0, 8)
  return h(
    'div',
    { className: 'ls-thread' },
    h('div', { className: 'ls-spot-kind' }, 'This seat'),
    h('dl', { className: 'ls-kv', style: { margin: '8px 0 18px' } },
      h('dt', null, 'Human'), h('dd', null, data.human?.name || 'not named'),
      h('dt', null, 'Posts go'), h('dd', null, data.posting?.detail || ''),
      h('dt', null, 'Service'), h('dd', null, data.service?.present ? `live${data.service.seatLabel ? ` on ${data.service.seatLabel}` : ''}` : 'not running'),
      h('dt', null, 'Read to'), h('dd', null, data.horizon?.readAt || '')),
    h('div', { className: 'ls-spot-kind' }, 'The board'),
    claims.length === 0 ? h('div', { className: 'ls-note-line', style: { margin: '6px 0 16px' } }, 'No claims in view.') :
      h('div', { className: 'ls-rows', style: { margin: '4px 0 16px' } }, claims.map(c => h('div', { className: 'ls-item', key: `${c.subject}-${c.cursor}` }, h(Dot, { status: c.status === 'held' ? 'active' : 'done' }), h('div', { className: 'ls-item-main' }, h('div', { className: 'ls-item-title' }, c.subject), h('div', { className: 'ls-item-sub' }, `${c.holder} · ${c.status} · ${c.ts}`))))),
    h('div', { className: 'ls-spot-kind' }, 'Who speaks here'),
    h('div', { className: 'ls-pills', style: { margin: '8px 0 16px' } }, who.length ? who.map(w => h(Chip, { key: w.name, tone: w.kind === 'human' ? 'accent' : undefined }, w.name)) : h('span', { className: 'ls-note-line' }, 'nobody in view')),
    h('div', { className: 'ls-spot-kind' }, 'Live sessions on this seat'),
    h('div', { className: 'ls-rows', style: { marginTop: 4 } }, sessions.length ? sessions.map(s => h('div', { className: 'ls-item', key: s.slug }, h(Dot, { status: 'active' }), h('div', { className: 'ls-item-main' }, h('div', { className: 'ls-item-title' }, s.bearer || s.slug), h('div', { className: 'ls-item-sub' }, [s.label, (s.armed || []).map(a => `#${a.room}`).join(' ')].filter(Boolean).join(' · '))))) : h('div', { className: 'ls-note-line' }, 'none'))
  )
}

function Composer({ data, subject, onPosted }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const needsName = data.human?.needsName && data.posting?.via !== 'command'
  const post = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const last = subject?.messages?.[subject.messages.length - 1]
      const out = await rest('/rooms/post', { method: 'POST', body: { room: data.room, text, thread: subject ? subject.id : undefined, re: subject && last && last.id !== subject.id ? last.id : undefined } })
      if (out?.ok === false) throw new Error(messageOf(out) || 'not posted')
      setText('')
      queryClient.invalidateQueries({ queryKey: [ID, 'room', data.room] })
      onPosted?.(out?.id || out?.posted?.id)
    } catch (error) {
      say('error', errorText(error), { title: 'Not posted (the draft is kept)', id: 'room-post' })
    } finally {
      setBusy(false)
    }
  }
  if (needsName) return h(NameSeat, null)
  return h(
    'div',
    { className: 'ls-composer' },
    h('textarea', {
      className: 'ls-textarea', placeholder: subject ? 'Reply in this subject' : `Open a subject in #${data.room}`, value: text, disabled: busy,
      onChange: e => setText(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); post() } }
    }),
    h('div', { className: 'ls-row' },
      h('span', { className: 'ls-note-line', style: { flex: 1 } }, `as ${data.self || data.human?.name || 'this seat'} · ${data.posting?.detail || ''} · Enter posts, Shift+Enter is a new line`),
      h(Btn, { variant: 'default', onClick: post, disabled: busy || !text.trim() }, busy ? 'Posting…' : 'Post'))
  )
}

function NameSeat() {
  const [name, setName] = useState('')
  const save = async () => {
    try {
      const out = await rest('/rooms/name', { method: 'POST', body: { name } })
      if (out?.ok === false) throw new Error(messageOf(out))
      queryClient.invalidateQueries({ queryKey: [ID, 'room'] })
    } catch (error) {
      say('error', errorText(error), { id: 'room-name' })
    }
  }
  return h(
    'div',
    { className: 'ls-composer' },
    h('div', { className: 'ls-note-line' }, 'This seat\'s human has no name yet, so nothing can be posted as them. Your posts here are signed with it.'),
    h('div', { className: 'ls-row' }, h('input', { className: 'ls-input', placeholder: 'Your name', value: name, onChange: e => setName(e.target.value), onKeyDown: e => e.key === 'Enter' && name.trim() && save() }), h(Btn, { variant: 'default', onClick: save, disabled: !name.trim() }, 'Save'))
  )
}

function WakeBanner({ seat, listens }) {
  const wakes = seat?.wakes || {}
  const granted = listens ? listens.granted : wakes.granted
  if (granted) return null
  return h(
    'div',
    { className: 'ls-banner' },
    h(Icon, { name: 'shield' }),
    h('div', { style: { flex: 1 } },
      h('div', { style: { color: 'var(--ui-text-primary)' } }, 'Room wakes are off for this profile'),
      h('div', { className: 'ls-note-line', style: { marginTop: 2 } }, 'A chat brought into a room is woken by its messages only once you allow lampstand to start turns. Run this once, then restart Hermes:'),
      h('div', { className: 'ls-mono', style: { marginTop: 6 } }, wakes.command)),
    CTX?.os?.writeClipboard && h(Btn, { variant: 'secondary', onClick: () => CTX.os.writeClipboard(wakes.command).then(ok => ok && say('success', 'Copied the command', { id: 'copied' })) }, 'Copy')
  )
}

function ListenControl({ room, listens, house, root }) {
  const focused = useValue(host.state.focusedStoredSessionId)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  if (!room) return null
  const mine = focused ? listens.find(l => l.chat_id === focused || l.session_key === focused) : null
  const toggle = async () => {
    if (!focused || busy) return
    setBusy(true)
    try {
      const body = mine
        ? { action: 'stop', session_key: mine.session_key || focused, room }
        : { action: 'start', session_key: focused, room, wake: 'addressed', house: house?.root || root || '', bearer: '', name: name.trim() || undefined, title: `${house?.name || 'chat'}${name.trim() ? ` · ${name.trim()}` : ''}` }
      const out = await rest('/listens', { method: 'POST', body })
      if (out?.ok === false) throw new Error(messageOf(out))
      queryClient.invalidateQueries({ queryKey: [ID, 'listens'] })
      say('success', mine ? `This chat left #${room}` : `#${room} now wakes this chat${out?.listen?.bearer ? `, signed ${out.listen.bearer}` : ''}`, { id: 'listen' })
      setName('')
    } catch (error) {
      say('error', errorText(error), { title: 'Not changed', id: 'listen' })
    } finally {
      setBusy(false)
    }
  }
  const label = l => l.bearer || l.title || (l.chat_id || l.session_key || '').slice(-8)
  return h(
    'div',
    { className: 'ls-listen' },
    listens.map(l => h(Chip, { key: l.session_key || l.chat_id, tone: l.chat_id === focused ? 'accent' : undefined, title: [l.title, l.state, l.waiting ? `${plural(l.waiting, 'message')} waiting` : '', l.last_error].filter(Boolean).join(' · ') }, h(Icon, { name: 'comment' }), label(l), l.waiting ? ` · ${l.waiting}` : '')),
    !mine && focused && h('input', { className: 'ls-input', placeholder: 'role (optional)', value: name, onChange: e => setName(e.target.value), title: 'The chat\'s role in the room (planner, builder…): it signs as <house>/<role>. Empty picks one.', 'aria-label': 'Role in the room' }),
    h(Btn, { size: 'xs', variant: mine ? 'secondary' : 'default', onClick: toggle, disabled: !focused || busy, title: focused ? 'The room\'s messages arrive in the focused chat as turns' : 'Open a chat first: the room wakes the chat you bring into it' }, busy ? 'Working…' : mine ? 'Leave with this chat' : 'Bring this chat in')
  )
}

// ---- Rhythm ----

function Rhythm({ root }) {
  const poll = usePoll()
  const data = useQuery({ queryKey: [ID, 'rhythm', root], queryFn: () => rest(`/rhythm?${q({ root })}`), refetchInterval: poll })
  if (data.isLoading) return h(Skeleton, { rows: 5 })
  if (data.error) return h(Empty, { title: 'The rhythm could not be read' }, errorText(data.error))
  const r = data.data || {}
  const sched = r.scheduler || {}
  const reminders = [...(r.reminders || [])].sort((a, b) => String(a.due).localeCompare(String(b.due)))
  const starters = r.starters || []
  return h(
    'div',
    { className: 'ls-grid' },
    h(
      Card,
      { title: 'Jobs', icon: 'pulse', className: 'w8' },
      (r.jobs || []).length === 0
        ? h(Fragment, null,
            h(Empty, { title: 'No jobs declared yet' }, 'A job is a command the house runs on a schedule under write governance: a nightly check, a weekly doctor. Declare one in house.toml; lampstand run --status then shows its health here.'),
            starters.length > 0 && h('div', null,
              h('div', { className: 'ls-spot-kind', style: { margin: '4px 0 8px' } }, 'Starter jobs lampstand ships'),
              starters.map(s => h('details', { key: s.name, className: 'ls-details' },
                h('summary', null, h('b', { style: { fontWeight: 600, color: 'var(--ui-text-primary)' } }, s.name), h('span', { className: 'ls-note-line' }, 'copy into house.toml')),
                h('div', { className: 'ls-row', style: { alignItems: 'flex-start' } },
                  h('div', { className: 'ls-kernel', style: { flex: 1, maxHeight: 220 } }, s.toml),
                  CTX?.os?.writeClipboard && h(Btn, { size: 'xs', icon: 'copy', title: 'Copy', onClick: () => CTX.os.writeClipboard(s.toml).then(ok => ok && say('success', `Copied the ${s.name} job`, { id: 'copied' })) }))))))
        : h('table', { className: 'ls-table' },
            h('thead', null, h('tr', null, h('th', null, 'Job'), h('th', null, 'Every'), h('th', null, 'Last run'), h('th', null, 'Health'))),
            h('tbody', null, r.jobs.map(j => h('tr', { key: j.id || j.name },
              h('td', null, j.id || j.name),
              h('td', { className: 'ls-mono' }, j.every || j.schedule || ''),
              h('td', null, j.last ? ago(j.last.at || j.last) : 'never'),
              h('td', null, h(Chip, { tone: j.healthy === false || j.health === 'failing' ? 'bad' : j.due ? 'warn' : 'good' }, j.health || (j.due ? 'due' : 'ok')))))))
    ),
    h(
      Card,
      { title: 'Coming up', icon: 'calendar', className: 'w4', actions: h(Btn, { size: 'xs', icon: 'add', onClick: () => dialogs.reminder(root), title: 'New reminder' }) },
      reminders.length === 0 ? h(Empty, { title: 'Nothing scheduled' }, 'Reminders you set appear here by date.') : h(ReminderList, { root, items: reminders })
    ),
    h(
      Card,
      { title: 'The clock', icon: 'clock', className: 'w6' },
      h('dl', { className: 'ls-kv' },
        h('dt', null, 'Module'), h('dd', null, sched.module ? h(Chip, { tone: 'good' }, 'on') : h(Chip, null, 'off')),
        h('dt', null, 'OS entry'), h('dd', null, sched.registered ? h(Chip, { tone: 'good' }, 'registered') : h(Chip, null, 'not registered')),
        sched.method && h(Fragment, null, h('dt', null, 'Method'), h('dd', null, sched.method)),
        sched.key && h(Fragment, null, h('dt', null, 'Key'), h('dd', { className: 'ls-mono' }, sched.key))),
      h('div', { className: 'ls-note-line', style: { marginTop: 12 } }, 'The OS scheduler runs due jobs and a quick doctor. Turning it on is the operator\'s act, from a terminal: ', h('span', { className: 'ls-mono' }, 'lampstand scheduler enable'), '.')
    ),
    h(
      Card,
      { title: 'Pipelines', icon: 'server-process', className: 'w6' },
      (r.forge || []).length === 0
        ? h('div', { className: 'ls-note-line' }, 'No pipelines yet. A pipeline is a multi-stage piece of work the house logs as it goes; ', h('span', { className: 'ls-mono' }, 'lampstand forge new'), ' starts one.')
        : h('div', { className: 'ls-rows' }, r.forge.map(s => h('div', { className: 'ls-item click', key: s.path || s.id, onClick: () => s.path && openReader(root, s.path) }, h(Dot, { status: s.status === 'complete' ? 'done' : 'active' }), h('div', { className: 'ls-item-main' }, h('div', { className: 'ls-item-title' }, s.title || s.id), h('div', { className: 'ls-item-sub' }, [s.status, s.created].filter(Boolean).join(' · ')))))))
  )
}

// ---- Health ----

const LEVELS = ['error', 'warning', 'info']

function Health({ root }) {
  const [quick, setQuick] = useState(false)
  const data = useQuery({ queryKey: [ID, 'doctor', root, quick], queryFn: () => rest(`/doctor?${q({ root, quick: quick ? 'true' : '' })}`), staleTime: 30_000 })
  const r = data.data || {}
  const findings = [...(r.findings || [])].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
  const faults = findings.filter(f => f.level === 'error' || f.level === 'warning')
  const notes = findings.filter(f => f.level !== 'error' && f.level !== 'warning')
  const verdict = r.exit === 0 ? 'Healthy' : r.exit === 1 ? 'Something to fix' : r.exit === 2 ? 'A person must act' : r.exit === 3 ? 'No house here' : r.error ? 'The doctor did not run' : ''
  const finding = (f, i) =>
    h('div', { key: i, className: 'ls-finding', 'data-l': f.level },
      h(Icon, { name: f.level === 'error' ? 'error' : f.level === 'warning' ? 'warning' : 'info' }),
      h('div', { style: { flex: 1, minWidth: 0 } }, h('div', null, f.message), f.fix && h('div', { style: { marginTop: 6 } }, h('code', null, f.fix))),
      h('span', { className: 'ls-faint ls-mono', style: { fontSize: 10.5 } }, [f.area, f.code].filter(Boolean).join(' · ')))
  return h(
    'div',
    { className: 'ls-grid' },
    h(
      Card,
      {
        title: 'Doctor', icon: 'heart', className: 'w12', lit: r.exit === 0,
        actions: h('div', { className: 'ls-pills' },
          h('div', { className: 'ls-seg', role: 'group', 'aria-label': 'Depth' }, h('button', { type: 'button', 'data-on': !quick ? '1' : undefined, onClick: () => setQuick(false) }, 'Full'), h('button', { type: 'button', 'data-on': quick ? '1' : undefined, onClick: () => setQuick(true) }, 'Quick')),
          h(Btn, { size: 'xs', icon: 'refresh', onClick: () => data.refetch(), disabled: data.isFetching }, data.isFetching ? 'Running…' : 'Run again'))
      },
      data.isLoading
        ? h(Fragment, null, h('div', { className: 'ls-note-line', style: { marginBottom: 10 } }, quick ? 'Running the quick doctor…' : 'Running the full doctor: the house, its state, Hermes, OMP and rooms. This takes a few seconds.'), h(Skeleton, { rows: 4 }))
        : h(
            Fragment,
            null,
            h('div', { className: 'ls-verdict' },
              h(OneLamp, { lit: r.exit === 0, size: 46, center: false }),
              h('div', null,
                h('div', { className: 'ls-verdict-word' }, verdict),
                h('div', { className: 'ls-note-line ls-num' }, [faults.length ? plural(faults.length, 'thing to fix', 'things to fix') : 'nothing to fix', notes.length && plural(notes.length, 'note')].filter(Boolean).join(' · '), data.isFetching ? ' · checking again…' : ''))),
            r.error && h('div', { className: 'ls-refusal' }, h(Icon, { name: 'error' }), messageOf(r.error)),
            faults.map(finding),
            notes.length > 0 && h('details', { className: 'ls-details', open: faults.length === 0 && notes.length <= 3 },
              h('summary', null, `${plural(notes.length, 'note')}`, h('span', { className: 'ls-note-line' }, 'for information; nothing here needs fixing')),
              notes.map(finding)),
            findings.length === 0 && !r.error && h(Empty, { title: 'Nothing to report', lit: true }, 'Every check the doctor runs passed.')
          )
    )
  )
}

// ---- Reader ----

function parseFront(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (m && m[2] !== '') out.push([m[1], m[2].replace(/^"(.*)"$/, '$1')])
  }
  return out
}
const HIDDEN_FRONT = ['title', 'kind', 'id']

/** The body with each [[wikilink]] turned into a link the reader follows; a link to no file is marked dangling. */
function linkify(body, resolved) {
  return String(body || '')
    .split(/(```[\s\S]*?```)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\[\[([^\]\n]+?)\]\]/g, (_, inner) => {
            const target = inner.split('|')[0].split('#')[0].trim()
            const label = (inner.includes('|') ? inner.split('|').slice(1).join('|') : inner.split('#')[0]).trim() || target
            const found = resolved ? resolved[target] : undefined
            const dangling = resolved && Object.prototype.hasOwnProperty.call(resolved, target) && !found
            return `[${label.replace(/[[\]]/g, '')}](#ls-${dangling ? 'dangling' : 'link'}=${encodeURIComponent(found || target)})`
          })
    )
    .join('')
}

function Reader({ root, path, back = [] }) {
  const doc = useQuery({ queryKey: [ID, 'doc', root, path], queryFn: () => rest(`/doc?${q({ root, path })}`) })
  useEffect(() => {
    const onKey = e => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Esc belongs to the topmost layer: an open dialog closes first, the reader only when none is open.
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return
      $reader.set(null)
    }
    if (CTX?.addEventListener) return CTX.addEventListener(window, 'keydown', onKey)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const go = target => openReader(root, target, { push: true })
  const follow = async target => {
    if (/\.(md|toml|json|txt|ya?ml|jsonl)$/i.test(target)) return go(target)
    try {
      const out = await rest(`/link?${q({ root, target })}`)
      if (out?.path) go(out.path)
      else say('info', `[[${target}]] names no file in the house yet.`, { id: 'dangling', title: 'A link to nowhere' })
    } catch (error) {
      say('error', errorText(error), { id: 'reader' })
    }
  }
  const goBack = () => {
    const earlier = [...back]
    const prev = earlier.pop()
    if (prev) $reader.set({ root, path: prev, back: earlier })
  }
  const onClickCapture = e => {
    const a = e.target && e.target.closest ? e.target.closest('a[href^="#ls-"]') : null
    if (!a) return
    e.preventDefault()
    e.stopPropagation()
    const m = /^#ls-(link|dangling)=(.*)$/.exec(a.getAttribute('href') || '')
    if (!m) return
    const target = decodeURIComponent(m[2])
    if (m[1] === 'dangling') say('info', `[[${target}]] names no file in the house yet.`, { id: 'dangling', title: 'A link to nowhere' })
    else follow(target)
  }
  const d = doc.data
  const front = d ? parseFront(d.frontmatter) : []
  const title = front.find(([k]) => k === 'title')?.[1]
  const hasHeading = d ? /^\s*#\s+/m.test(String(d.body).split('\n').slice(0, 6).join('\n')) : false
  const resolved = d?.resolved
  const shown = front.filter(([k]) => !HIDDEN_FRONT.includes(k))
  return h(
    'aside',
    { className: 'ls-tok ls-reader', 'aria-label': 'Reader' },
    h('div', { className: 'ls-reader-head' },
      back.length > 0 && h(Btn, { size: 'xs', icon: 'arrow-left', title: `Back to ${back[back.length - 1]}`, onClick: goBack }),
      h(Icon, { name: 'file' }),
      h('div', { className: 'ls-reader-path', title: path }, h('bdi', null, path)),
      CTX?.os?.writeClipboard && h(Btn, { size: 'xs', icon: 'copy', title: 'Copy the path', onClick: () => CTX.os.writeClipboard(join(root, path)).then(ok => ok && say('success', 'Copied the path', { id: 'copied' })) }),
      CTX?.os?.revealPath && h(Btn, { size: 'xs', icon: 'folder-opened', title: 'Reveal in the file manager', onClick: () => CTX.os.revealPath(join(root, path)) }),
      h(Btn, { size: 'xs', icon: 'close', title: 'Close (Esc)', onClick: () => $reader.set(null) })),
    h('div', { className: 'ls-reader-body', key: path },
      doc.isLoading
        ? h(Skeleton, { rows: 8 })
        : doc.error
          ? h(Empty, { title: 'Cannot show this file' }, errorText(doc.error))
          : h(Fragment, null,
              title && !hasHeading && h('h2', { className: 'ls-reader-title' }, title),
              shown.length > 0 && h('div', { className: 'ls-front' }, shown.map(([k, v]) => h(Chip, { key: k, tone: k === 'status' ? 'accent' : k === 'due' && daysUntil(v) < 0 ? 'bad' : undefined }, `${k}: ${v}`))),
              h('div', { className: 'ls-md', onClickCapture }, h(Markdown, { text: d.path.endsWith('.md') ? linkify(d.body, resolved) : `\`\`\`\n${d.body}\n\`\`\`` })),
              ((d.links || []).length > 0 || (d.backlinks || []).length > 0) &&
                h('div', { className: 'ls-links' },
                  (d.links || []).length > 0 && h(Fragment, null, h('div', { className: 'ls-spot-kind', style: { marginBottom: 6 } }, 'Links to'),
                    h('div', null, d.links.map(l => {
                      const dangling = resolved && Object.prototype.hasOwnProperty.call(resolved, l) && !resolved[l]
                      return h('span', { className: 'ls-link', key: l }, h(Chip, { className: dangling && 'dangling', title: dangling ? 'No file has this name yet' : resolved?.[l] || l, onClick: () => (dangling ? say('info', `[[${l}]] names no file in the house yet.`, { id: 'dangling', title: 'A link to nowhere' }) : follow(resolved?.[l] || l)) }, l))
                    }))),
                  (d.backlinks || []).length > 0 && h(Fragment, null, h('div', { className: 'ls-spot-kind', style: { margin: '14px 0 6px' } }, 'Linked from'), h('div', null, d.backlinks.map(l => h('span', { className: 'ls-link', key: l }, h(Chip, { onClick: () => go(l) }, l))))))))
  )
}

// -----------------------------------------------------------------------------------------------------------------
// The status bar lamp

function StatusLamp() {
  const prefs = useValue($prefs)
  const cwd = useValue(host.state.cwd)
  const seat = useSeat(cwd)
  const chosen = useValue($root)
  const root = chosen || pickInitialRoot(seat.data)
  const view = useOverview(prefs.statusLamp ? root : null)
  if (!prefs.statusLamp || !root || !view.data) return null
  const lamps = lampsOf(view.data) || []
  const overdue = [...(view.data.tasks || []), ...(view.data.reminders || [])].filter(isOverdue).length
  const waiting = (view.data.inbox || []).filter(i => i.kind === 'decision').length + (view.data.proposals || []).length + overdue
  const lit = lamps.filter(l => l.lit).length
  return h(
    'button',
    {
      className: 'ls-tok ls-status',
      type: 'button',
      title: `${view.data.house?.name}: ${lit} of 5 lamps lit\n${lamps.map(l => `${l.lit ? 'lit' : 'dark'}  ${l.name}: ${l.say}`).join('\n')}${waiting ? `\n${plural(waiting, 'item')} awaiting you` : ''}`,
      onClick: () => {
        if (!chosen) $root.set(root)
        navigateTo('overview')
      }
    },
    h(TinyLamps, { lit: lamps.map(l => l.lit) }),
    h('span', null, view.data.house?.name),
    waiting > 0 && h('span', { className: 'ls-pill', 'aria-label': `${waiting} awaiting you` }, waiting)
  )
}

// -----------------------------------------------------------------------------------------------------------------
// The transcript card: ::lampstand{view="house|tasks|inbox|decision|proposals|room" root="..." path="..." room="..."}
// The root comes from a model's text, so the card draws only a house this seat already knows.

function DirectiveCard({ attrs }) {
  const view = String(attrs?.view || '')
  const seat = useSeat('')
  const named = typeof attrs?.root === 'string' && attrs.root ? attrs.root : null
  const known = named && (seat.data?.houses || []).find(x => !x.missing && (x.root === named || x.root.toLowerCase() === named.toLowerCase()))
  const root = known ? known.root : null
  const overview = useOverview(root)
  if (!/^(house|tasks|inbox|decision|proposals|room)$/.test(view)) return null
  const open = tab => {
    if (root) $root.set(root)
    if (view === 'room' && attrs.room) $room.set(String(attrs.room))
    navigateTo(tab)
  }
  if (view === 'room')
    return h('div', { className: 'ls-tok', style: { height: 'auto' } }, h('div', { className: 'ls-card-directive' },
      h('div', { className: 'ls-row' }, h(Icon, { name: 'comment-discussion' }), h('div', { style: { flex: 1 } }, h('div', { className: 'ls-spot-kind' }, 'listening'), h('div', { className: 'ls-spot-title' }, `#${attrs.room || ''}`)), h(Btn, { variant: 'secondary', onClick: () => open('rooms') }, 'Open the room'))))
  if (!named) return null
  if (seat.data && !known)
    return h('div', { className: 'ls-tok' }, h('div', { className: 'ls-card-directive' }, h('div', { className: 'ls-note-line' }, 'A lampstand card for a house this seat does not know; it is not shown.')))
  const v = overview.data
  if (!v) return h('div', { className: 'ls-tok' }, h('div', { className: 'ls-card-directive' }, h(Skeleton, { rows: 2 })))
  const lamps = lampsOf(v) || []
  const decisions = (v.inbox || []).filter(i => i.kind === 'decision')
  const body =
    view === 'tasks'
      ? h(TaskList, { root, items: sortTasks(v.tasks || []).slice(0, 6), compact: true })
      : view === 'decision' || view === 'inbox'
        ? h('div', { className: 'ls-rows' }, (view === 'decision' ? decisions : v.inbox || []).slice(0, 5).map(i =>
            h('div', { className: 'ls-item', key: i.path }, h(Dot, { status: i.status }), h('div', { className: 'ls-item-main' }, h('div', { className: 'ls-item-title' }, i.title || i.id), h('div', { className: 'ls-item-sub' }, i.kind)), i.kind === 'decision' && h(Btn, { size: 'xs', variant: 'secondary', onClick: () => dialogs.rule(root, i) }, 'Rule'))))
        : view === 'proposals'
          ? h('div', { className: 'ls-rows' }, (v.proposals || []).map(p => h('div', { className: 'ls-item', key: p.id }, h(Icon, { name: 'law' }), h('div', { className: 'ls-item-main' }, h('div', { className: 'ls-item-title' }, p.title || p.id)), h(Btn, { size: 'xs', onClick: () => open('constitution') }, 'Review'))))
          : h('div', { style: { maxWidth: 420 } }, h(LampPanel, { lamps, onPick: l => open(l.tab) }))
  return h(
    'div',
    { className: 'ls-tok', style: { height: 'auto' } },
    h('div', { className: 'ls-card-directive' },
      h('div', { className: 'ls-row', style: { marginBottom: 10 } }, h(TinyLamps, { lit: lamps.map(l => l.lit) }), h('div', { style: { flex: 1 } }, h('div', { className: 'ls-spot-kind' }, view === 'house' ? 'the house' : view), h('div', { className: 'ls-spot-title' }, v.house?.name)), h(Btn, { size: 'xs', onClick: () => open(view === 'house' ? 'overview' : view === 'tasks' ? 'work' : view === 'proposals' ? 'constitution' : 'inbox') }, 'Open')),
      body),
    h(ActDialog)
  )
}

// -----------------------------------------------------------------------------------------------------------------
// Settings

function savePrefs(next) {
  const merged = { ...$prefs.get(), ...next }
  $prefs.set(merged)
  CTX?.storage?.set('prefs', merged)
}

function SettingsPage() {
  const seat = useSeat('')
  const prefs = useValue($prefs)
  const [defaultRoot, setDefaultRoot] = useState(() => CTX?.storage?.get('defaultRoot', null))
  const s = seat.data || {}
  const houses = s.houses || []
  const markRoot = $root.get() || pickInitialRoot(s)
  const overview = useOverview(markRoot)
  const lamps = lampsOf(overview.data)
  const choose = root => {
    CTX?.storage?.set('defaultRoot', root)
    setDefaultRoot(root)
    if (root) $root.set(root)
  }
  const forget = async root => {
    try {
      await rest('/houses/forget', { method: 'POST', body: { root } })
      queryClient.invalidateQueries({ queryKey: [ID, 'seat'] })
      say('success', 'Forgotten. It returns if a session works in it again.', { id: 'forget' })
    } catch (error) {
      say('error', errorText(error), { id: 'forget' })
    }
  }
  return h(
    'div',
    { className: 'ls-tok', style: { padding: 4, color: 'var(--ui-text-primary)' } },
    h('div', { className: 'ls-row', style: { gap: 18, marginBottom: 20, alignItems: 'center' } },
      h('div', { style: { width: 120, flex: 'none' } }, h(Lampstand, { lit: lamps ? lamps.map(l => l.lit) : [false, false, true, false, false] })),
      h('div', null,
        h('div', { className: 'ls-title', style: { fontSize: 26, margin: 0 } }, 'lampstand'),
        h('div', { className: 'ls-note-line' }, `plugin ${s.version || ''} · agora ${s.agora?.version || 'not installed'} · Node ${s.node ? 'found' : 'missing'}`),
        lamps && h('div', { className: 'ls-note-line' }, `${overview.data?.house?.name}: ${lamps.filter(l => l.lit).length} of 5 lamps lit`))),
    h('div', { className: 'ls-label', style: { marginBottom: 8 } }, 'Houses this seat knows'),
    seat.isLoading ? h(Skeleton, { rows: 2 }) : houses.length === 0 ? h('div', { className: 'ls-note-line' }, 'None yet. Plant a house with lampstand init, then open a chat inside it.') :
      houses.map(x =>
        h('div', { className: 'ls-house-row', key: x.root },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'ls-row', style: { gap: 8 } }, h('b', { style: { fontWeight: 600 } }, x.name), defaultRoot === x.root && h(Chip, { tone: 'accent' }, 'default'), x.missing && h(Chip, { tone: 'bad' }, 'gone from disk'), h(Chip, null, x.source === 'folder' ? 'in a scanned folder' : x.source === 'session' ? 'this chat\'s house' : 'a session worked here')),
            h('div', { className: 'ls-mono ls-faint', style: { fontSize: 11, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: x.root }, x.root),
            x.seen && h('div', { className: 'ls-note-line' }, `last seen ${ago(x.seen)}`)),
          h('div', { className: 'ls-pills' },
            !x.missing && defaultRoot !== x.root && h(Btn, { size: 'xs', onClick: () => choose(x.root) }, 'Make default'),
            defaultRoot === x.root && h(Btn, { size: 'xs', onClick: () => choose(null) }, 'Clear default'),
            x.source === 'remembered' && h(Btn, { size: 'xs', onClick: () => forget(x.root), title: 'Remove it from this list (the house itself is untouched)' }, 'Forget')))),
    h('div', { className: 'ls-label', style: { margin: '22px 0 8px' } }, 'This page'),
    h('dl', { className: 'ls-kv', style: { fontSize: 13, gap: '12px 18px' } },
      h('dt', null, 'Refresh every'),
      h('dd', null, h('div', { className: 'ls-seg' }, [[10_000, '10 s'], [20_000, '20 s'], [60_000, '1 min']].map(([ms, label]) => h('button', { key: ms, type: 'button', 'data-on': prefs.poll === ms ? '1' : undefined, onClick: () => savePrefs({ poll: ms }) }, label)))),
      h('dt', null, 'Status-bar lamp'),
      h('dd', null, h('div', { className: 'ls-seg' }, h('button', { type: 'button', 'data-on': prefs.statusLamp ? '1' : undefined, onClick: () => savePrefs({ statusLamp: true }) }, 'Shown'), h('button', { type: 'button', 'data-on': !prefs.statusLamp ? '1' : undefined, onClick: () => savePrefs({ statusLamp: false }) }, 'Hidden'))),
      h('dt', null, 'Scanned folders'), h('dd', { className: 'ls-mono', style: { fontSize: 12 } }, (s.houses_dirs || []).join(', ')),
      h('dt', null, 'Room wakes'), h('dd', null, s.wakes?.granted ? h(Chip, { tone: 'good' }, 'granted') : h('span', null, 'off: ', h('span', { className: 'ls-mono' }, s.wakes?.command)))),
    h('div', { className: 'ls-note-line', style: { marginTop: 18 } }, 'The folders scanned for houses are the lampstand plugin\'s houses_dir setting (Capabilities, Plugins, lampstand). Everything a house is lives in its own files; acts from the House page are saved there and committed.')
  )
}

// -----------------------------------------------------------------------------------------------------------------
// register

export default {
  id: ID,
  name: 'lampstand',
  register(ctx) {
    CTX = ctx
    $root.set(null)
    $tab.set(ctx.storage?.get('tab', 'overview') || 'overview')
    $reader.set(null)
    $dialog.set(null)
    $pending.set({})
    $room.set(ctx.storage?.get('room', null) || null)
    $prefs.set({ poll: 20_000, statusLamp: true, ...(ctx.storage?.get('prefs', null) || {}) })
    installStyle(ctx)
    ctx.onDispose($tab.listen(v => ctx.storage?.set('tab', v)))
    ctx.onDispose($room.listen(v => v && ctx.storage?.set('room', v)))

    const withRoot = fn => async () => {
      const root = await resolveRoot()
      if (!root) return navigateTo('overview')
      fn(root)
    }

    const contributions = [
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => h(HousePage) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: ROUTE, label: 'House', codicon: 'flame' } },
      STATUSBAR_AREAS && { id: 'lamp', area: STATUSBAR_AREAS.right, order: 115, render: () => h(StatusLamp) },
      { id: 'open', area: PALETTE_AREA, data: { id: 'lampstand.open', label: 'lampstand: Open the house', keywords: ['house', 'lampstand', 'tasks', 'constitution'], run: () => navigateTo('overview') } },
      { id: 'capture', area: PALETTE_AREA, data: { id: 'lampstand.capture', label: 'lampstand: Capture a thought', keywords: ['capture', 'note', 'inbox'], run: withRoot(root => { host.navigate(ROUTE); dialogs.capture(root) }) } },
      { id: 'task', area: PALETTE_AREA, data: { id: 'lampstand.task', label: 'lampstand: New task', keywords: ['task', 'todo'], run: withRoot(root => { navigateTo('work'); dialogs.task(root) }) } },
      { id: 'compile', area: PALETTE_AREA, data: { id: 'lampstand.compile', label: 'lampstand: Compile the constitution', keywords: ['compile', 'kernel'], run: withRoot(root => act(root, 'compile')) } },
      {
        id: 'doctor', area: PALETTE_AREA,
        data: { id: 'lampstand.doctor', label: 'lampstand: Run the doctor', keywords: ['doctor', 'health'], run: withRoot(root => { navigateTo('health'); queryClient.invalidateQueries({ queryKey: [ID, 'doctor', root] }) }) }
      },
      { id: 'rooms', area: PALETTE_AREA, data: { id: 'lampstand.rooms', label: 'lampstand: Open the rooms', keywords: ['agora', 'room', 'chat'], run: () => navigateTo('rooms') } },
      sdk.KEYBINDS_AREA && { id: 'key-open', area: sdk.KEYBINDS_AREA, data: { id: 'lampstand.open', label: 'Open the house', category: 'lampstand', defaults: ['mod+alt+h'], run: () => navigateTo('overview') } },
      typeof sdk.TRANSCRIPT_DIRECTIVE_AREA === 'string' && { id: 'card', area: sdk.TRANSCRIPT_DIRECTIVE_AREA, data: { name: 'lampstand', render: props => h(DirectiveCard, props) } }
    ].filter(Boolean)
    ctx.registerMany(contributions)

    if (typeof ctx.registerSettingsPage === 'function') ctx.registerSettingsPage({ id: 'settings', title: 'lampstand', icon: 'flame', render: () => h(SettingsPage) })

    ctx.onEvent('plugin.lampstand.house.changed', event => {
      const root = event?.payload?.root
      // This page's own acts already re-read what they changed; only another surface's change is read here.
      if (root && Date.now() - (ownActs.get(root) || 0) < 4000) return
      refreshHouse(root)
    })
    ctx.onEvent('plugin.lampstand.room.delivered', () => queryClient.invalidateQueries({ queryKey: [ID, 'listens'] }))
    ctx.onEvent('plugin.lampstand.room.posted', () => queryClient.invalidateQueries({ queryKey: [ID, 'room'] }))
    ctx.onEvent('plugin.lampstand.room.listens', () => queryClient.invalidateQueries({ queryKey: [ID, 'listens'] }))
    ctx.onEvent('plugin.lampstand.room.undelivered', event => {
      queryClient.invalidateQueries({ queryKey: [ID, 'listens'] })
      const p = event?.payload || {}
      if (p.mine || p.self) return
      const n = Number(p.count) || 0
      const room = p.room || 'a room'
      say('warning', `${n ? plural(n, 'message') : 'Some messages'} in #${room} did not reach the chat; ${n === 1 ? 'it stays' : 'they stay'} readable in the room.`, { title: 'Not delivered', id: `undelivered:${room}` })
    })
  }
}
