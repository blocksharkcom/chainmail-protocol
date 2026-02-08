const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

class ApiClient {
  private token: string | null = null

  setToken(token: string | null) {
    this.token = token
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        ...headers,
        ...(options.headers as Record<string, string>),
      },
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }))
      throw new Error(error.error || error.message || 'Request failed')
    }

    return response.json()
  }

  async getChallenge(address?: string): Promise<{ challenge: string; message: string; expiresAt: number }> {
    return this.fetch('/api/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ address }),
    })
  }

  async login(walletAddress: string, signature: string, challenge: string): Promise<{
    token: string
    dmailAddress: string
    walletAddress: string
  }> {
    const response = await this.fetch<{
      success: boolean
      token: string
      address: string
      error?: string
    }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ challenge, signature, address: walletAddress }),
    })

    if (!response.success) {
      throw new Error(response.error || 'Login failed')
    }

    // Create identity for this wallet if not exists
    let dmailAddress = ''
    try {
      const identity = await this.createIdentity(walletAddress)
      dmailAddress = identity.address
    } catch {
      // Identity might already exist, try to get it
      try {
        const identity = await this.getIdentity()
        dmailAddress = identity.address
      } catch {
        dmailAddress = response.address
      }
    }

    return {
      token: response.token,
      dmailAddress,
      walletAddress: response.address,
    }
  }

  async createIdentity(name?: string): Promise<{ address: string; publicKey: string; encryptionPublicKey: string }> {
    return this.fetch('/api/identity', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  }

  async getIdentity(): Promise<{ address: string; publicKey: string; encryptionPublicKey: string }> {
    return this.fetch('/api/identity')
  }

  async logout(): Promise<void> {
    await this.fetch('/api/auth/logout', { method: 'POST' })
    this.token = null
  }

  async getInbox(): Promise<{ messages: any[] }> {
    return this.fetch('/api/messages')
  }

  async getSent(): Promise<{ messages: any[] }> {
    // Server stores sent messages in the same place, filter by 'from' on client
    // For now, return empty - sent messages would need server-side tracking
    try {
      return await this.fetch('/api/messages?type=sent')
    } catch {
      return { messages: [] }
    }
  }

  async sendMessage(to: string, subject: string, body: string): Promise<{ id: string }> {
    return this.fetch('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ to, subject, body }),
    })
  }

  async getPublicKey(address: string): Promise<{ publicKey: string; encryptionPublicKey: string }> {
    return this.fetch(`/api/identity/${address}/publickey`)
  }

  async registerUsername(username: string): Promise<{ success: boolean; username: string }> {
    return this.fetch('/api/username/register', {
      method: 'POST',
      body: JSON.stringify({ username }),
    })
  }

  async lookupUsername(username: string): Promise<{ address: string }> {
    return this.fetch(`/api/username/${username}`)
  }

  async getProfile(): Promise<{ address: string; publicKey: string; walletAddress: string; username?: string }> {
    return this.fetch('/api/identity/me')
  }

  async startNode(): Promise<{ status: string; peerId?: string }> {
    return this.fetch('/api/node/start', { method: 'POST' })
  }

  async getNodeStatus(): Promise<{ running: boolean; peerId?: string; peerCount?: number }> {
    return this.fetch('/api/node/status')
  }
}

export const api = new ApiClient()
