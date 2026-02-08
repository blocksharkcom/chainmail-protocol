import { create } from 'zustand'

export interface Email {
  id: string
  from: string
  to: string
  subject: string
  body: string
  timestamp: number
  read: boolean
  encrypted: boolean
}

interface MailState {
  inbox: Email[]
  sent: Email[]
  selectedEmail: Email | null
  isLoading: boolean
  error: string | null
  setInbox: (emails: Email[]) => void
  setSent: (emails: Email[]) => void
  selectEmail: (email: Email | null) => void
  markAsRead: (id: string) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  addToInbox: (email: Email) => void
  addToSent: (email: Email) => void
}

export const useMailStore = create<MailState>()((set) => ({
  inbox: [],
  sent: [],
  selectedEmail: null,
  isLoading: false,
  error: null,
  setInbox: (emails) => set({ inbox: emails }),
  setSent: (emails) => set({ sent: emails }),
  selectEmail: (email) => set({ selectedEmail: email }),
  markAsRead: (id) =>
    set((state) => ({
      inbox: state.inbox.map((email) =>
        email.id === id ? { ...email, read: true } : email
      ),
    })),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  addToInbox: (email) =>
    set((state) => ({
      inbox: [email, ...state.inbox],
    })),
  addToSent: (email) =>
    set((state) => ({
      sent: [email, ...state.sent],
    })),
}))
