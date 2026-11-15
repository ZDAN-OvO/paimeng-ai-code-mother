export type UIMessagePart = API.ChatUIMessage['parts'][number]
export type UIMessageTextPart = Extract<UIMessagePart, { type: 'text' }>
export type UIMessageToolPart = Extract<UIMessagePart, { type: 'dynamic-tool' }>
export type UIMessagePlanPart = Extract<UIMessagePart, { type: 'data-plan' }>
export type UIMessageValidationPart = Extract<UIMessagePart, { type: 'data-validation' }>
export type ChatUIMessage = API.ChatUIMessage
export type ChatUIMessageChunk = { type: string; [key: string]: unknown }

export type RunPlanStep = UIMessagePlanPart['data']['steps'][number]
export type RunPlan = UIMessagePlanPart['data']
export type RunValidation = API.BaseResponseRunDetails['data']['validations'][number]

export type ChatStreamEvent = {
  runId: string
  type: string
  payload: Record<string, unknown>
}
