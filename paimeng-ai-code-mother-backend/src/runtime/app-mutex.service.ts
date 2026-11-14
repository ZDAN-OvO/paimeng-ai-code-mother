import { Injectable } from '@nestjs/common'

@Injectable()
export class AppMutexService {
  private readonly tails = new Map<number, Promise<void>>()

  async withLock<T>(appId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(appId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.tails.set(appId, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.tails.get(appId) === tail) this.tails.delete(appId)
    }
  }
}
