/* eslint-env browser */

import { ipcRenderer } from 'electron'

const globalWindow = globalThis as typeof globalThis & Window
const documentRef = globalWindow.document
const HTMLButtonCtor = globalWindow.HTMLButtonElement
const InputEventCtor = globalWindow.InputEvent

type RequestState = {
  interval?: NodeJS.Timeout
  lastContent: string
  lastEmit: number
  done: boolean
}

const ACTIVE_REQUESTS = new Map<string, RequestState>()

const INPUT_SELECTORS = ['textarea[data-id="chat-input"]', 'textarea[placeholder*="Message"]', 'textarea']

const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[type="submit"]',
  'button[aria-label*="Send"]'
]

const STOP_BUTTON_SELECTORS = ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]']

const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]'

function waitForSelector<T extends Element>(selectors: string[], timeout = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now()

    const check = () => {
      for (const selector of selectors) {
        const element = documentRef.querySelector(selector) as T | null
        if (element) {
          resolve(element)
          return
        }
      }

      if (Date.now() - start > timeout) {
        reject(new Error('Timed out waiting for ChatGPT input area'))
        return
      }

      setTimeout(check, 200)
    }

    check()
  })
}

function setNativeValue(element: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set
  const prototype = Object.getPrototypeOf(element)
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set

  if (valueSetter && valueSetter !== prototypeValueSetter) {
    prototypeValueSetter?.call(element, value)
  } else {
    valueSetter?.call(element, value)
  }

  element.dispatchEvent(new Event('input', { bubbles: true }))
  if (InputEventCtor) {
    element.dispatchEvent(new InputEventCtor('input', { bubbles: true, data: value }))
  }
}

function findSendButton(textarea: HTMLTextAreaElement): HTMLButtonElement | null {
  const form = textarea.closest('form')
  if (form) {
    for (const selector of SEND_BUTTON_SELECTORS) {
      const button = form.querySelector(selector)
      if (HTMLButtonCtor && button instanceof HTMLButtonCtor) {
        return button
      }
    }
  }

  for (const selector of SEND_BUTTON_SELECTORS) {
    const button = documentRef.querySelector(selector)
    if (HTMLButtonCtor && button instanceof HTMLButtonCtor) {
      return button
    }
  }

  return null
}

function findStopButton(): HTMLButtonElement | null {
  for (const selector of STOP_BUTTON_SELECTORS) {
    const button = documentRef.querySelector(selector)
    if (HTMLButtonCtor && button instanceof HTMLButtonCtor) {
      return button
    }
  }
  return null
}

function getLatestAssistantContent(): string {
  const nodes = documentRef.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR)
  if (nodes.length === 0) {
    return ''
  }

  const last = nodes[nodes.length - 1] as HTMLElement
  return (last.innerText || '').trim()
}

async function submitPrompt(requestId: string, prompt: string) {
  const textarea = await waitForSelector<HTMLTextAreaElement>(INPUT_SELECTORS)

  textarea.focus()
  setNativeValue(textarea, prompt)

  const sendButton = findSendButton(textarea)
  if (!sendButton) {
    throw new Error('Unable to locate ChatGPT send button. Please make sure you are signed in.')
  }

  sendButton.click()

  startPolling(requestId)
}

function startPolling(requestId: string) {
  const state: RequestState = {
    lastContent: '',
    lastEmit: 0,
    done: false
  }

  ACTIVE_REQUESTS.set(requestId, state)

  state.interval = setInterval(() => {
    const content = getLatestAssistantContent()
    if (content && content !== state.lastContent) {
      state.lastContent = content
      state.lastEmit = Date.now()
      ipcRenderer.send('web-model:chunk', { requestId, content, done: false })
    }

    const stopButtonVisible = Boolean(findStopButton())
    if (!state.done) {
      if (!content && state.lastEmit === 0) {
        return
      }

      if (!stopButtonVisible && state.lastEmit > 0 && Date.now() - state.lastEmit > 1500) {
        state.done = true
        ipcRenderer.send('web-model:chunk', { requestId, content: state.lastContent, done: true })
        cleanupRequest(requestId)
      }
    }
  }, 400)
}

function cleanupRequest(requestId: string) {
  const state = ACTIVE_REQUESTS.get(requestId)
  if (!state) return

  if (state.interval) {
    clearInterval(state.interval)
  }

  ACTIVE_REQUESTS.delete(requestId)
}

function cancelRequest(requestId: string) {
  const stopButton = findStopButton()
  if (stopButton) {
    stopButton.click()
  }
  cleanupRequest(requestId)
}

ipcRenderer.on('web-model:prompt', async (_event, payload: { requestId: string; prompt: string }) => {
  const { requestId, prompt } = payload
  try {
    await submitPrompt(requestId, prompt)
  } catch (error) {
    cleanupRequest(requestId)
    ipcRenderer.send('web-model:error', {
      requestId,
      error: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

ipcRenderer.on('web-model:cancel', (_event, payload: { requestId: string }) => {
  cancelRequest(payload.requestId)
})

globalWindow.addEventListener('beforeunload', () => {
  ACTIVE_REQUESTS.forEach((_state, requestId) => cleanupRequest(requestId))
  ACTIVE_REQUESTS.clear()
})

globalWindow.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('web-model:ready')
})
