export const browserTestsStarted = 'PAIMENG_E2E_TESTS_STARTED'

export default class PhaseReporter {
  #started = false

  onTestBegin() {
    if (this.#started) return
    this.#started = true
    console.log(browserTestsStarted)
  }
}
