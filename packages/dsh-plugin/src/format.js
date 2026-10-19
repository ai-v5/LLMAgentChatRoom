/**
 * Pure, dependency-free formatting for room messages injected into a DSH
 * session. The header is the only trust signal the agent gets, so every field
 * is flattened to one line and bracket characters are stripped: a member name
 * must not be able to close the header or forge extra attributes.
 * @module @llmagentchatroom/dsh-plugin/format
 */

const INSTRUCTION = 'instruction'
const DATA = 'data'

/**
 * Flatten one untrusted header value to a single line.
 * @param {unknown} value - Value from a room message.
 * @returns {string} Single-line value with control characters, brackets, and
 *   repeated whitespace removed.
 */
function inline(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    // eslint-disable-next-line no-control-regex -- Deliberate header-injection defense.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\[|\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Human-readable author label used in the source header.
 * Owner messages are labelled `owner (human)` exactly like the CLI/GUI, so a
 * forwarded owner message cannot masquerade as a direct owner instruction.
 * @param {{ memberId?: string, name?: string, kind?: string, platform?: string | null } | null | undefined} author
 * @returns {string} Stable label.
 */
export function authorLabel(author) {
  if (!author || typeof author !== 'object') return 'unknown'
  if (author.kind === 'owner') return 'owner (human)'
  const name = inline(author.name) || 'unknown'
  const kind = inline(author.kind) || 'agent'
  const platform = inline(author.platform)
  return platform ? `${name} (${kind}, ${platform})` : `${name} (${kind})`
}

/**
 * Classify a message for the agent's trust rules.
 * Only a direct owner message (owner author, no forwarding) is an
 * `instruction`; everything else, including an owner-forwarded message, is
 * peer `data` that must be verified before use.
 * @param {{ author?: { kind?: string }, forwardedFrom?: unknown } | null | undefined} message
 * @returns {'instruction' | 'data'} Message kind.
 */
export function messageKind(message) {
  if (message && typeof message === 'object' && message.author?.kind === 'owner' && !message.forwardedFrom) {
    return INSTRUCTION
  }
  return DATA
}

/**
 * Render one room message as the text pushed into the DSH session.
 * @param {{ id?: unknown, seq?: unknown, ts?: unknown, text?: unknown,
 *   author?: { kind?: string, name?: string, platform?: string | null } | null,
 *   forwardedFrom?: { name?: string, kind?: string, platform?: string | null } | null }} message
 * @returns {string} One header line plus the verbatim message body.
 */
export function formatIncoming(message) {
  const source = message && typeof message === 'object' ? message : {}
  const id = inline(source.id) || '?'
  const seq = Number.isInteger(source.seq) ? String(source.seq) : inline(source.seq) || '?'
  let header = `[chat-room msg=${id} seq=${seq} from=${authorLabel(source.author)}`
  if (source.forwardedFrom) header += ` forwarded_from=${authorLabel(source.forwardedFrom)}`
  header += ` kind=${messageKind(source)} ts=${inline(source.ts) || '?'}]`
  const text = typeof source.text === 'string' ? source.text : ''
  return `${header}\n${text}`
}

/**
 * Decide whether one delivered message should wake the bound member.
 * The author is never woken for its own message, and an empty or missing
 * `wake` list means "record only".
 * @param {{ wake?: unknown, author?: { memberId?: string } } | null | undefined} message
 * @param {string} memberId - Member id of the bound room client.
 * @returns {boolean} True when this member is explicitly woken.
 */
export function shouldWake(message, memberId) {
  if (typeof memberId !== 'string' || memberId.length === 0) return false
  if (!message || typeof message !== 'object') return false
  const authorId = message.author?.memberId
  if (typeof authorId === 'string' && authorId === memberId) return false
  return Array.isArray(message.wake) && message.wake.includes(memberId)
}
