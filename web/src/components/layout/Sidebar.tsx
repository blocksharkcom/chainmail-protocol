import { useState } from 'react'
import { Inbox, Send, PenSquare, LogOut, Mail, Copy, Check, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn, formatAddress } from '@/lib/utils'
import { useAuthStore } from '@/store/auth'
import { useAppKit, useAppKitAccount } from '@reown/appkit/react'
import { useDisconnect } from 'wagmi'
import { api } from '@/lib/api'

interface SidebarProps {
  activeView: 'inbox' | 'sent'
  onViewChange: (view: 'inbox' | 'sent') => void
  onCompose: () => void
  unreadCount: number
}

export function Sidebar({ activeView, onViewChange, onCompose, unreadCount }: SidebarProps) {
  const { dmailAddress, clearSession } = useAuthStore()
  const { open } = useAppKit()
  const { address } = useAppKitAccount()
  const { disconnect } = useDisconnect()

  const [copied, setCopied] = useState(false)
  const [showUsernameForm, setShowUsernameForm] = useState(false)
  const [username, setUsername] = useState('')
  const [usernameError, setUsernameError] = useState<string | null>(null)
  const [usernameSuccess, setUsernameSuccess] = useState<string | null>(null)
  const [registering, setRegistering] = useState(false)

  const handleLogout = async () => {
    clearSession()
    disconnect()
  }

  const handleCopy = async () => {
    if (dmailAddress) {
      await navigator.clipboard.writeText(dmailAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleRegisterUsername = async () => {
    if (!username.trim()) {
      setUsernameError('Please enter a username')
      return
    }

    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      setUsernameError('Username must be 3-20 chars, lowercase letters, numbers, underscores only')
      return
    }

    setRegistering(true)
    setUsernameError(null)
    setUsernameSuccess(null)

    try {
      const result = await api.registerUsername(username)
      setUsernameSuccess(`Registered: ${result.username}@dmail.network`)
      setShowUsernameForm(false)
      setUsername('')
    } catch (err) {
      setUsernameError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setRegistering(false)
    }
  }

  return (
    <div className="flex flex-col h-full w-64 bg-card border-r">
      {/* Logo */}
      <div className="p-4 flex items-center gap-2">
        <Mail className="h-8 w-8 text-primary" />
        <span className="text-xl font-bold">dMail</span>
      </div>

      <Separator />

      {/* Compose Button */}
      <div className="p-4">
        <Button onClick={onCompose} className="w-full gap-2">
          <PenSquare className="h-4 w-4" />
          Compose
        </Button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2">
        <button
          onClick={() => onViewChange('inbox')}
          className={cn(
            "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
            activeView === 'inbox'
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
        >
          <Inbox className="h-4 w-4" />
          <span className="flex-1 text-left">Inbox</span>
          {unreadCount > 0 && (
            <span className="bg-primary text-primary-foreground text-xs px-2 py-0.5 rounded-full">
              {unreadCount}
            </span>
          )}
        </button>

        <button
          onClick={() => onViewChange('sent')}
          className={cn(
            "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors mt-1",
            activeView === 'sent'
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
        >
          <Send className="h-4 w-4" />
          <span className="flex-1 text-left">Sent</span>
        </button>
      </nav>

      <Separator />

      {/* User Info */}
      <div className="p-4 space-y-3">
        {/* dMail Address - Full with copy button */}
        <div className="text-xs">
          <div className="text-muted-foreground mb-1">Your dMail Address</div>
          <div className="flex items-center gap-1">
            <div
              className="flex-1 font-mono text-foreground text-[10px] bg-muted/50 px-2 py-1.5 rounded break-all cursor-pointer hover:bg-muted"
              onClick={handleCopy}
              title="Click to copy"
            >
              {dmailAddress}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={handleCopy}
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          </div>
        </div>

        {/* Username Registration */}
        <div className="text-xs">
          <div className="flex items-center justify-between mb-1">
            <span className="text-muted-foreground">Public Username</span>
            {!showUsernameForm && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1 text-xs text-primary"
                onClick={() => setShowUsernameForm(true)}
              >
                <Plus className="h-3 w-3 mr-1" />
                Register
              </Button>
            )}
          </div>

          {usernameSuccess && (
            <div className="text-green-500 text-xs mb-2 flex items-center gap-1">
              <Check className="h-3 w-3" />
              {usernameSuccess}
            </div>
          )}

          {showUsernameForm && (
            <div className="space-y-2">
              <div className="flex gap-1">
                <Input
                  placeholder="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  className="h-7 text-xs"
                />
                <span className="text-muted-foreground self-center text-[10px]">@dmail.network</span>
              </div>
              {usernameError && (
                <div className="text-destructive text-[10px]">{usernameError}</div>
              )}
              <div className="flex gap-1">
                <Button
                  size="sm"
                  className="h-6 text-xs flex-1"
                  onClick={handleRegisterUsername}
                  disabled={registering}
                >
                  {registering ? 'Registering...' : 'Register'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => {
                    setShowUsernameForm(false)
                    setUsername('')
                    setUsernameError(null)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>

        <Separator />

        {/* Wallet */}
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2 text-xs"
          onClick={() => open()}
        >
          <div className="w-2 h-2 rounded-full bg-green-500" />
          {formatAddress(address || '')}
        </Button>

        {/* Logout */}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground"
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4" />
          Disconnect
        </Button>
      </div>
    </div>
  )
}
