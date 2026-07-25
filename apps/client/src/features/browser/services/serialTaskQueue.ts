export function createSerialTaskQueue() {
  let tail = Promise.resolve()

  return {
    enqueue<T>(task: () => Promise<T>) {
      const result = tail.then(task)
      // Keep the queue usable after a failed task while preserving that task's result.
      tail = result.then(() => undefined, () => undefined)
      return result
    },
  }
}
