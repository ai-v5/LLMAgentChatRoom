import type { ServerResponse } from 'node:http'

export interface OutboundEvent {
  event: string
  data: unknown
  id?: number
}

const MAX_QUEUE_EVENTS = 1000
const MAX_QUEUE_BYTES = 8 * 1024 * 1024

export class Connection {
  readonly res: ServerResponse
  readonly roomId: string
  readonly memberId: string
  private queue: OutboundEvent[] = []
  private queuedBytes = 0
  private live = false
  overflow = false
  closed = false

  constructor(res: ServerResponse, roomId: string, memberId: string) {
    this.res = res
    this.roomId = roomId
    this.memberId = memberId
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
  }

  enqueue(event: OutboundEvent): void {
    if (this.closed || this.overflow) return
    if (this.live) {
      this.write(event)
      return
    }
    this.queue.push(event)
    this.queuedBytes += JSON.stringify(event.data).length
    if (this.queue.length > MAX_QUEUE_EVENTS || this.queuedBytes > MAX_QUEUE_BYTES) {
      this.overflow = true
      this.closed = true
      this.res.end('retry: 1000\n\n')
    }
  }

  flush(): void {
    if (this.closed) return
    const pending = this.queue
    this.queue = []
    this.queuedBytes = 0
    for (const event of pending) this.write(event)
    this.live = true
  }

  write(event: OutboundEvent): void {
    if (this.closed) return
    let frame = ''
    if (event.id !== undefined) frame += 'id: ' + event.id + '\n'
    frame += 'event: ' + event.event + '\n'
    frame += 'data: ' + JSON.stringify(event.data) + '\n\n'
    this.res.write(frame)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.res.end()
  }
}

export class RoomHub {
  private readonly connections = new Map<string, Set<Connection>>()
  private readonly chains = new Map<string, Promise<unknown>>()

  withLock<T>(roomId: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.chains.get(roomId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    this.chains.set(
      roomId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  add(connection: Connection): void {
    let set = this.connections.get(connection.roomId)
    if (!set) {
      set = new Set()
      this.connections.set(connection.roomId, set)
    }
    set.add(connection)
  }

  remove(connection: Connection): void {
    this.connections.get(connection.roomId)?.delete(connection)
  }

  broadcast(roomId: string, event: OutboundEvent, exceptMemberId?: string): void {
    const set = this.connections.get(roomId)
    if (!set) return
    for (const connection of set) {
      if (exceptMemberId && connection.memberId === exceptMemberId) continue
      connection.enqueue(event)
      if (connection.closed) this.remove(connection)
    }
  }

  closeMember(roomId: string, memberId: string): void {
    const set = this.connections.get(roomId)
    if (!set) return
    for (const connection of set) {
      if (connection.memberId !== memberId) continue
      connection.close()
      this.remove(connection)
    }
  }

  count(roomId: string): number {
    return this.connections.get(roomId)?.size ?? 0
  }
}
