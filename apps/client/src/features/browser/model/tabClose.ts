export type BrowserTabCloseScope = 'tab' | 'others' | 'right'

export function pageIdsToClose(
  pageIds: number[],
  targetPageId: number,
  scope: BrowserTabCloseScope,
) {
  const targetIndex = pageIds.indexOf(targetPageId)
  if (targetIndex < 0) return []

  if (scope === 'tab') return [targetPageId]
  if (scope === 'others') return pageIds.filter((pageId) => pageId !== targetPageId)
  return pageIds.slice(targetIndex + 1)
}
