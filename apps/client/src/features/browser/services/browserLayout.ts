let framePromise: Promise<void> | null = null

/** Wait for Vue's layout to be committed before measuring the native webview bounds. */
export function waitForBrowserLayoutFrame() {
  if (framePromise) return framePromise

  framePromise = new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      framePromise = null
      resolve()
    })
  })

  return framePromise
}
