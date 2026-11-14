export function chatStreamEventType(type: string): string {
  if (type === 'data-run') return 'run-finished'
  if (type === 'data-plan') return 'plan-updated'
  if (type === 'data-validation') return 'validation-status'
  if (type === 'data-model') return 'model-status'
  if (type === 'data-preview') return 'preview-status'
  return type.slice(5)
}
