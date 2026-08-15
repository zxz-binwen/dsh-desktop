// Splash logic for the DeepSeek Harness desktop launcher. Runs inside the
// Tauri shell (window.__TAURI__ globals, withGlobalTauri); in a plain
// browser it degrades to a preview mode with no shell events.
const PHASE_LABELS = {
  restart: '正在重启 · Restarting',
  clone: '克隆仓库 · Cloning the repository',
  sync: '拉取最新代码 · Fetching the latest code',
  install: '安装依赖 · Installing dependencies',
  build: '构建 · Building',
  start: '启动服务 · Starting the server',
}
const MAX_LOG_LINES = 300

const stepsElement = document.getElementById('steps')
const logElement = document.getElementById('log')
const errorElement = document.getElementById('error')
const errorMessage = document.getElementById('error-message')
const errorHint = document.getElementById('error-hint')
const retryButton = document.getElementById('retry')

const logLines = []
let activeStep = null

function appendLog(line) {
  logLines.push(line)
  if (logLines.length > MAX_LOG_LINES) logLines.shift()
  logElement.textContent = logLines.join('\n')
  logElement.scrollTop = logElement.scrollHeight
}

function markStepError() {
  if (activeStep === null) return
  activeStep.classList.remove('active')
  activeStep.classList.add('error')
  activeStep.querySelector('.mark').textContent = '✗'
  activeStep = null
}

function completeStep() {
  if (activeStep === null) return
  activeStep.classList.remove('active')
  activeStep.classList.add('done')
  activeStep.querySelector('.mark').textContent = '✓'
  activeStep = null
}

function beginStep(phase) {
  completeStep()
  const step = document.createElement('div')
  step.className = 'step active'
  const mark = document.createElement('span')
  mark.className = 'mark'
  mark.textContent = '•'
  const label = document.createElement('span')
  label.textContent = PHASE_LABELS[phase] ?? phase
  step.append(mark, label)
  stepsElement.append(step)
  activeStep = step
}

function showError(message, hint) {
  markStepError()
  errorMessage.textContent = message
  errorHint.textContent = hint ?? ''
  errorElement.style.display = 'block'
  retryButton.hidden = false
}

function onBootEvent(payload) {
  if (typeof payload !== 'object' || payload === null) return
  switch (payload.type) {
    case 'phase':
      beginStep(payload.phase)
      break
    case 'log':
      if (typeof payload.line === 'string') appendLog(payload.line)
      break
    case 'notice':
      if (typeof payload.message === 'string') appendLog('⚠ ' + payload.message)
      break
    case 'mode':
      if (payload.mode === 'frozen') {
        footer.textContent = '内置离线版本 · Bundled build — opens directly, no git sync'
      }
      break
    case 'ready':
      // The shell navigates this window to the URL; nothing to do here.
      completeStep()
      break
    case 'exited':
      showError('服务已退出 · The server exited with code ' + String(payload.code), '')
      retryButton.hidden = false
      break
    case 'error':
      showError(String(payload.message ?? 'unknown error'), String(payload.hint ?? ''))
      break
    default:
      break
  }
}

retryButton.addEventListener('click', () => {
  retryButton.hidden = true
  errorElement.style.display = 'none'
  stepsElement.replaceChildren()
  logLines.length = 0
  logElement.textContent = ''
  const tauri = window.__TAURI__
  if (tauri !== undefined) {
    // The shell drains the previous boot tree (up to its shutdown grace)
    // before respawning, so surface that wait instead of an empty step list.
    beginStep('restart')
    tauri.core.invoke('restart_boot').catch(() => {
      markStepError()
      footer.textContent = '重启失败，请重新打开应用 · Restart failed; reopen the app'
    })
  }
})

const tauri = window.__TAURI__
const footer = document.getElementById('footer')
if (tauri !== undefined) {
  // The shell gates the first boot on this handshake, so no boot event can
  // fire before the listener exists.
  tauri.event.listen('boot-event', (event) => onBootEvent(event.payload))
    .then(() => tauri.core.invoke('splash_ready'))
    .catch(() => {
      footer.textContent = '事件通道初始化失败，请重新打开应用 · Event channel failed; reopen the app'
    })
} else {
  footer.textContent = '浏览器预览模式：无壳事件 · Browser preview: no shell events'
}
