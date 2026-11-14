export const PREVIEW_AUTH_REFRESH_MS = 5 * 60 * 1000

export function shouldRefreshPreviewAuth(input: {
  visible: boolean
  hasPreview: boolean
  lastAccessAt: number
  now: number
}): boolean {
  return (
    input.visible &&
    input.hasPreview &&
    input.now - input.lastAccessAt > PREVIEW_AUTH_REFRESH_MS
  )
}
