export function createLatestRequestGuard() {
  let version = 0
  let controller: AbortController | null = null

  function start() {
    version += 1
    controller?.abort()
    controller = new AbortController()
    const requestVersion = version

    return {
      signal: controller.signal,
      isCurrent: () => requestVersion === version,
      release: () => {
        if (requestVersion === version) controller = null
      },
    }
  }

  function cancel() {
    version += 1
    controller?.abort()
    controller = null
  }

  return { cancel, start }
}
