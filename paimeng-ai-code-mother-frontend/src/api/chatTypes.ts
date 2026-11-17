export type UIMessagePart = API.ChatUIMessage['parts'][number]
export type UIMessageTextPart = Extract<UIMessagePart, { type: 'text' }>
export type UIMessageToolPart = Extract<UIMessagePart, { type: 'dynamic-tool' }>
export type UIMessagePlanPart = Extract<UIMessagePart, { type: 'data-plan' }>
export type UIMessageValidationPart = Extract<UIMessagePart, { type: 'data-validation' }>
export type UIMessageSteerPart = Extract<UIMessagePart, { type: 'data-steer' }>
export type ChatUIMessage = API.ChatUIMessage
export type ChatUIMessageChunk = { type: string; [key: string]: unknown }

export type ChatMode = 'normal' | 'steer'

export type QueueItem = API.BaseResponseQueueItem['data']
export type MessageQueueState = API.BaseResponseMessageQueue['data']

export type RunPlanStep = UIMessagePlanPart['data']['steps'][number]
export type RunPlan = UIMessagePlanPart['data']
export type RunValidation = API.BaseResponseRunDetails['data']['validations'][number]

export type ChatStreamEvent = {
  runId: string
  type: string
  payload: Record<string, unknown>
}
