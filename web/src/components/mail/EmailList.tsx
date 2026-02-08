import { ScrollArea } from '@/components/ui/scroll-area'
import { cn, formatDate, formatDmailAddress } from '@/lib/utils'
import type { Email } from '@/store/mail'
import { Lock, Mail } from 'lucide-react'

interface EmailListProps {
  emails: Email[]
  selectedId: string | null
  onSelect: (email: Email) => void
  type: 'inbox' | 'sent'
}

export function EmailList({ emails, selectedId, onSelect, type }: EmailListProps) {
  if (emails.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Mail className="h-12 w-12 mb-4 opacity-50" />
        <p className="text-sm">No messages {type === 'inbox' ? 'in your inbox' : 'sent yet'}</p>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="divide-y divide-border">
        {emails.map((email) => (
          <button
            key={email.id}
            onClick={() => onSelect(email)}
            className={cn(
              "w-full text-left p-4 hover:bg-accent/50 transition-colors",
              selectedId === email.id && "bg-accent",
              !email.read && type === 'inbox' && "bg-primary/5"
            )}
          >
            <div className="flex items-start gap-3">
              {/* Avatar placeholder */}
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                <span className="text-primary text-sm font-medium">
                  {(type === 'inbox' ? email.from : email.to).charAt(3).toUpperCase()}
                </span>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className={cn(
                    "text-sm truncate",
                    !email.read && type === 'inbox' ? "font-semibold" : "font-medium"
                  )}>
                    {formatDmailAddress(type === 'inbox' ? email.from : email.to)}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatDate(email.timestamp)}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 mt-0.5">
                  {email.encrypted && (
                    <Lock className="h-3 w-3 text-green-500 shrink-0" />
                  )}
                  <span className={cn(
                    "text-sm truncate",
                    !email.read && type === 'inbox' ? "font-medium text-foreground" : "text-muted-foreground"
                  )}>
                    {email.subject || '(No subject)'}
                  </span>
                </div>

                <p className="text-xs text-muted-foreground mt-1 truncate">
                  {email.body.slice(0, 80)}...
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>
    </ScrollArea>
  )
}
