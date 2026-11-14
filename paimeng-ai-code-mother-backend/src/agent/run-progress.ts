export type TextTurnDecision =
  | { action: 'validate' }
  | { action: 'prompt'; note: string }
  | {
      action: 'fail'
      errorCode: 'NO_CODE_PRODUCED' | 'VALIDATION_FAILED'
      errorSummary: string
    }

export const NO_CODE_NOTE =
  '本轮还没有生成或修改任何源码，不能进入平台验证。请立即调用 update_plan（如本轮尚未提交计划）和 write/edit/delete 等工具实际写入项目文件；只回复文字不会完成任务。'

export const NO_REPAIR_NOTE =
  '验证失败后还没有产生新的修复变更，不会重复进入平台验证。请根据上一条验证结果调用 read 和 edit/write 修复问题；只回复文字不会完成任务。'

export const NO_CODE_SUMMARY = '本轮没有生成或修改任何源码，任务已停止，未执行平台验证。'

export const NO_REPAIR_SUMMARY = '验证失败后没有产生新的修复变更，任务已停止。'

/**
 * 跟踪两次平台验证之间是否真的发生过源码变更。
 * 模型只读文件或只回复文字时，不能让空目录进入平台验证并消耗修复机会。
 */
export class RunProgress {
  private mutatedSinceValidation = false
  private everMutated = false
  private promptedWithoutMutation = false

  markMutated() {
    this.mutatedSinceValidation = true
    this.everMutated = true
  }

  onTextOnlyTurn(): TextTurnDecision {
    if (this.mutatedSinceValidation) {
      this.mutatedSinceValidation = false
      this.promptedWithoutMutation = false
      return { action: 'validate' }
    }
    if (this.promptedWithoutMutation) {
      if (this.everMutated) {
        return {
          action: 'fail',
          errorCode: 'VALIDATION_FAILED',
          errorSummary: NO_REPAIR_SUMMARY,
        }
      }
      return { action: 'fail', errorCode: 'NO_CODE_PRODUCED', errorSummary: NO_CODE_SUMMARY }
    }
    this.promptedWithoutMutation = true
    if (this.everMutated) return { action: 'prompt', note: NO_REPAIR_NOTE }
    return { action: 'prompt', note: NO_CODE_NOTE }
  }
}
