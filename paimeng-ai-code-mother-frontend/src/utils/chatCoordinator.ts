export class ChatSubmissionRejected extends Error {}

export function createTaskQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(task)
      tail = next.catch(() => undefined)
      return next
    },
    async idle() {
      let current: Promise<unknown>
      do {
        current = tail
        await current
      } while (current !== tail)
    },
  }
}
