import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import { BrowserWindow, ipcMain, webContents } from 'electron'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'

type PendingRequest = {
  senderId: number
}

type WebModelChunkPayload = {
  requestId: string
  content?: string
  done?: boolean
  error?: string
}

const CHATGPT_URL = 'https://chatgpt.com/?oai=1'

export class WebModelService {
  private static instance: WebModelService

  private window: BrowserWindow | null = null
  private isReady = false
  private creatingWindowPromise: Promise<void> | null = null
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly logger = loggerService.withContext('WebModelService')

  private constructor() {
    ipcMain.on('web-model:ready', () => {
      this.logger.info('Web model preload reported ready')
      this.isReady = true
    })

    ipcMain.on('web-model:chunk', (_event, payload: WebModelChunkPayload) => {
      this.forwardChunk(payload)
    })

    ipcMain.on('web-model:error', (_event, payload: WebModelChunkPayload) => {
      this.forwardChunk({ ...payload, error: payload.error ?? 'Unknown error', done: true })
    })
  }

  static getInstance(): WebModelService {
    if (!WebModelService.instance) {
      WebModelService.instance = new WebModelService()
    }
    return WebModelService.instance
  }

  async initialize(): Promise<boolean> {
    await this.ensureWindow()
    return this.isReady
  }

  async sendMessage({
    prompt,
    provider,
    senderId
  }: {
    prompt: string
    provider?: string
    senderId: number
  }): Promise<string> {
    await this.ensureWindow()

    if (!this.window || this.window.isDestroyed()) {
      throw new Error('Web model window is not available')
    }

    const requestId = uuidv4()
    this.pendingRequests.set(requestId, { senderId })

    this.window.webContents.send('web-model:prompt', {
      requestId,
      prompt,
      provider
    })

    return requestId
  }

  cancel(requestId: string) {
    if (!requestId) return
    this.window?.webContents.send('web-model:cancel', { requestId })
    this.pendingRequests.delete(requestId)
  }

  private forwardChunk(payload: WebModelChunkPayload) {
    const request = this.pendingRequests.get(payload.requestId)
    if (!request) {
      return
    }

    const target = webContents.fromId(request.senderId)
    if (!target || target.isDestroyed()) {
      this.pendingRequests.delete(payload.requestId)
      return
    }

    target.send(IpcChannel.WebModel_Stream, payload)

    if (payload.done || payload.error) {
      this.pendingRequests.delete(payload.requestId)
    }
  }

  private async ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      return
    }

    if (this.creatingWindowPromise) {
      await this.creatingWindowPromise
      return
    }

    this.creatingWindowPromise = this.createWindow()
    try {
      await this.creatingWindowPromise
    } finally {
      this.creatingWindowPromise = null
    }
  }

  private async createWindow(): Promise<void> {
    this.logger.info('Creating hidden window for web model integration')
    this.isReady = false

    this.window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/webModelPreload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false,
        partition: 'persist:webview'
      }
    })

    this.window.on('closed', () => {
      this.logger.info('Web model window closed')
      this.window = null
      this.isReady = false
    })

    this.window.webContents.on('did-finish-load', () => {
      this.logger.info('Web model page loaded')
    })

    this.window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      this.logger.error(`Failed to load ChatGPT page: ${errorCode} ${errorDescription}`)
    })

    try {
      await this.window.loadURL(CHATGPT_URL)
    } catch (error) {
      this.logger.error('Failed to load ChatGPT page', error as Error)
      throw error
    }
  }
}

export const webModelService = WebModelService.getInstance()
