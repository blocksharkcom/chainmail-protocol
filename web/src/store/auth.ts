import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthState {
  sessionToken: string | null
  dmailAddress: string | null
  walletAddress: string | null
  isAuthenticated: boolean
  setSession: (token: string, dmailAddress: string, walletAddress: string) => void
  clearSession: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      sessionToken: null,
      dmailAddress: null,
      walletAddress: null,
      isAuthenticated: false,
      setSession: (token, dmailAddress, walletAddress) =>
        set({
          sessionToken: token,
          dmailAddress,
          walletAddress,
          isAuthenticated: true,
        }),
      clearSession: () =>
        set({
          sessionToken: null,
          dmailAddress: null,
          walletAddress: null,
          isAuthenticated: false,
        }),
    }),
    {
      name: 'dmail-auth',
    }
  )
)
