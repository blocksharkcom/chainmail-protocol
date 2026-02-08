import { useState, useEffect } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { EmailList } from '@/components/mail/EmailList'
import { EmailView } from '@/components/mail/EmailView'
import { ComposeModal } from '@/components/mail/ComposeModal'
import { useMailStore, type Email } from '@/store/mail'
import { useAuthStore } from '@/store/auth'
import { api } from '@/lib/api'
import { Loader2 } from 'lucide-react'

export function MailPage() {
  const [activeView, setActiveView] = useState<'inbox' | 'sent'>('inbox')
  const [showCompose, setShowCompose] = useState(false)
  const [replyTo, setReplyTo] = useState<string | undefined>()
  const [replySubject, setReplySubject] = useState<string | undefined>()

  const { sessionToken, dmailAddress } = useAuthStore()
  const {
    inbox,
    sent,
    selectedEmail,
    isLoading,
    setInbox,
    setSent,
    selectEmail,
    markAsRead,
    setLoading,
  } = useMailStore()

  // Set token and dmail address on mount
  useEffect(() => {
    if (sessionToken) {
      api.setToken(sessionToken)
    }
    if (dmailAddress) {
      api.setDmailAddress(dmailAddress)
    }
  }, [sessionToken, dmailAddress])

  // Fetch messages when dmailAddress is set
  useEffect(() => {
    if (!dmailAddress) return

    const fetchMessages = async () => {
      setLoading(true)
      try {
        const [inboxRes, sentRes] = await Promise.all([
          api.getInbox(),
          api.getSent(),
        ])

        // Sort messages by timestamp descending (newest first)
        const sortByNewest = (a: Email, b: Email) => b.timestamp - a.timestamp
        setInbox(inboxRes.messages.map(transformMessage).sort(sortByNewest))
        setSent(sentRes.messages.map(transformMessage).sort(sortByNewest))
      } catch (err) {
        console.error('Failed to fetch messages:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchMessages()
  }, [dmailAddress])

  const transformMessage = (msg: any): Email => ({
    id: msg.id,
    from: msg.from,
    to: msg.to,
    subject: msg.subject || '',
    body: msg.body || '',
    timestamp: msg.timestamp,
    read: msg.read ?? false,
    encrypted: msg.encrypted ?? true,
  })

  const currentEmails = activeView === 'inbox' ? inbox : sent
  const unreadCount = inbox.filter((e) => !e.read).length

  const handleSelectEmail = async (email: Email) => {
    selectEmail(email)
    if (!email.read && activeView === 'inbox') {
      markAsRead(email.id)
      // Persist to backend
      try {
        await api.markAsRead(email.id)
      } catch (err) {
        console.error('Failed to mark as read:', err)
      }
    }
  }

  const handleReply = () => {
    if (selectedEmail) {
      setReplyTo(selectedEmail.from)
      setReplySubject(selectedEmail.subject)
      setShowCompose(true)
    }
  }

  const handleCloseCompose = () => {
    setShowCompose(false)
    setReplyTo(undefined)
    setReplySubject(undefined)
  }

  if (isLoading && inbox.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="h-screen flex">
      {/* Sidebar */}
      <Sidebar
        activeView={activeView}
        onViewChange={(view) => {
          setActiveView(view)
          selectEmail(null)
        }}
        onCompose={() => setShowCompose(true)}
        unreadCount={unreadCount}
      />

      {/* Main Content */}
      <div className="flex-1 flex">
        {/* Email List */}
        <div className="w-96 border-r">
          <div className="h-14 flex items-center px-4 border-b">
            <h2 className="font-semibold">
              {activeView === 'inbox' ? 'Inbox' : 'Sent'}
            </h2>
            <span className="ml-2 text-sm text-muted-foreground">
              ({currentEmails.length})
            </span>
          </div>
          <div className="h-[calc(100%-3.5rem)]">
            <EmailList
              emails={currentEmails}
              selectedId={selectedEmail?.id || null}
              onSelect={handleSelectEmail}
              type={activeView}
            />
          </div>
        </div>

        {/* Email View */}
        <div className="flex-1 bg-muted/30">
          {selectedEmail ? (
            <EmailView
              email={selectedEmail}
              onBack={() => selectEmail(null)}
              onReply={handleReply}
              type={activeView}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
              <div className="text-6xl mb-4">📬</div>
              <p>Select an email to read</p>
            </div>
          )}
        </div>
      </div>

      {/* Compose Modal */}
      <ComposeModal
        isOpen={showCompose}
        onClose={handleCloseCompose}
        replyTo={replyTo}
        replySubject={replySubject}
      />
    </div>
  )
}
