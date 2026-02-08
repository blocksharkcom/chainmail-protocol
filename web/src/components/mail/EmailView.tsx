import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { formatChainmailAddress } from '@/lib/utils'
import type { Email } from '@/store/mail'
import { ArrowLeft, Lock, Reply, Trash2 } from 'lucide-react'

interface EmailViewProps {
  email: Email
  onBack: () => void
  onReply: () => void
  type: 'inbox' | 'sent'
}

export function EmailView({ email, onBack, onReply, type }: EmailViewProps) {
  const displayAddress = type === 'inbox' ? email.from : email.to
  const addressLabel = type === 'inbox' ? 'From' : 'To'

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 p-4 border-b">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex-1" />

        {type === 'inbox' && (
          <Button variant="ghost" size="sm" onClick={onReply} className="gap-2">
            <Reply className="h-4 w-4" />
            Reply
          </Button>
        )}

        <Button variant="ghost" size="icon" className="text-muted-foreground">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Email Content */}
      <ScrollArea className="flex-1">
        <div className="p-6">
          {/* Subject */}
          <div className="flex items-start gap-3 mb-6">
            <div className="flex-1">
              <h1 className="text-xl font-semibold flex items-center gap-2">
                {email.encrypted && <Lock className="h-4 w-4 text-green-500" />}
                {email.subject || '(No subject)'}
              </h1>
            </div>
          </div>

          {/* Sender/Recipient Info */}
          <div className="flex items-start gap-4 mb-6">
            <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-primary text-lg font-medium">
                {displayAddress.charAt(3).toUpperCase()}
              </span>
            </div>

            <div className="flex-1">
              <div className="font-medium">{formatChainmailAddress(displayAddress)}</div>
              <div className="text-sm text-muted-foreground">
                {addressLabel}: <span className="font-mono text-xs">{displayAddress}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {new Date(email.timestamp).toLocaleString()}
              </div>
            </div>
          </div>

          <Separator className="my-6" />

          {/* Body */}
          <div className="prose prose-invert max-w-none">
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
              {email.body}
            </pre>
          </div>

          {/* Encryption Badge */}
          {email.encrypted && (
            <div className="mt-8 p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
              <div className="flex items-center gap-2 text-green-500 text-sm">
                <Lock className="h-4 w-4" />
                <span className="font-medium">End-to-end encrypted</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                This message was encrypted using X25519-ChaCha20-Poly1305. Only you and the sender can read it.
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
