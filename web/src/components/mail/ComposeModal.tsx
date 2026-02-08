import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { X, Send, Lock, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useMailStore } from '@/store/mail'

interface ComposeModalProps {
  isOpen: boolean
  onClose: () => void
  replyTo?: string
  replySubject?: string
}

export function ComposeModal({ isOpen, onClose, replyTo, replySubject }: ComposeModalProps) {
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { addToSent } = useMailStore()

  // Sync state when replyTo/replySubject props change
  useEffect(() => {
    if (replyTo) {
      setTo(replyTo)
    }
    if (replySubject) {
      setSubject(replySubject.startsWith('Re: ') ? replySubject : `Re: ${replySubject}`)
    }
  }, [replyTo, replySubject])

  if (!isOpen) return null

  const handleSend = async () => {
    if (!to.trim()) {
      setError('Please enter a recipient address')
      return
    }

    setSending(true)
    setError(null)

    try {
      const result = await api.sendMessage(to.trim(), subject, body)

      // Add to sent locally
      addToSent({
        id: result.id,
        from: '', // Will be filled by the store
        to: to.trim(),
        subject,
        body,
        timestamp: Date.now(),
        read: true,
        encrypted: true,
      })

      onClose()
      setTo('')
      setSubject('')
      setBody('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">New Message</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* To Field */}
          <div className="space-y-2">
            <label className="text-sm font-medium">To</label>
            <Input
              placeholder="dm1... or username"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>

          {/* Subject Field */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Subject</label>
            <Input
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          {/* Body Field */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Message</label>
            <Textarea
              placeholder="Write your message..."
              className="min-h-[200px] resize-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
              {error}
            </div>
          )}

          {/* Encryption Notice */}
          <div className="flex items-center gap-2 text-sm text-green-500">
            <Lock className="h-4 w-4" />
            <span>Your message will be end-to-end encrypted</span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t">
          <Button variant="outline" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={sending} className="gap-2">
            {sending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Send
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
