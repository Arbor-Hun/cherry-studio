import { loggerService } from '@logger'
import type { WebModelProvider } from '@renderer/store/llm'

type WebModelEventPayload = {
  requestId: string
  content?: string
  done?: boolean
  error?: string
}

type StreamCallbacks = {
  onUpdate?: (content: string, done: boolean) => void
  onError?: (error: Error) => void
}

const logger = loggerService.withContext('WebModelClient')

class WebModelClient {
  private initialized = false
  private initializePromise: Promise<boolean> | null = null
  private readonly listeners = new Map<string, StreamCallbacks>()

  constructor() {
    if (window.api?.webModel?.onEvent) {
      window.api.webModel.onEvent((payload) => this.handleEvent(payload))
    }
  }

  async ensureInitialized(): Promise<boolean> {
    if (this.initialized) {
      return true
    }

    if (!this.initializePromise) {
      this.initializePromise =
        window.api?.webModel
          ?.initialize()
          .catch((error: unknown) => {
            logger.error('Failed to initialize web model', error as Error)
            return false
          })
          .finally(() => {
            this.initializePromise = null
          }) ?? Promise.resolve(false)
    }

    const result = await this.initializePromise
    this.initialized = result
    return result
  }

  async sendMessage(
    { prompt, provider }: { prompt: string; provider?: WebModelProvider },
    callbacks: StreamCallbacks
  ): Promise<string> {
    await this.ensureInitialized()

    if (!window.api?.webModel) {
      throw new Error('Web model API is not available')
    }

    const requestId: string = await window.api.webModel.sendMessage({ prompt, provider })
    this.listeners.set(requestId, callbacks)
    return requestId
  }

  cancel(requestId: string) {
    if (!requestId) {
      return
    }

    window.api?.webModel?.cancel(requestId)
    this.listeners.delete(requestId)
  }

  private handleEvent(payload: WebModelEventPayload) {
    const listener = this.listeners.get(payload.requestId)
    if (!listener) {
      return
    }

    if (payload.error) {
      listener.onError?.(new Error(payload.error))
      this.listeners.delete(payload.requestId)
      return
    }

    if (payload.content !== undefined) {
      listener.onUpdate?.(payload.content, Boolean(payload.done))
    }

    if (payload.done) {
      this.listeners.delete(payload.requestId)
    }
  }
}

export const webModelClient = new WebModelClient()
