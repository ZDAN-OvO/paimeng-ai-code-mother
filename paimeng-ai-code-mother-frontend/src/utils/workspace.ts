export const SPLIT_MIN = 320
export const SPLIT_MAX = 560
export const PREVIEW_MIN = 480
export const SPLIT_STORAGE_KEY = 'pm.workspace.split'

export function defaultSplitWidth(viewportWidth: number): number {
  return viewportWidth < 1280 ? 340 : 400
}

export function clampSplitWidth(value: number, viewportWidth: number): number {
  const max = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, viewportWidth - PREVIEW_MIN))
  return Math.round(Math.min(max, Math.max(SPLIT_MIN, value)))
}

export function parseStoredSplit(raw: string | null, viewportWidth: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return defaultSplitWidth(viewportWidth)
  return clampSplitWidth(value, viewportWidth)
}
