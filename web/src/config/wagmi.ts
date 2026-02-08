import { createAppKit } from '@reown/appkit/react'
import { WagmiProvider } from 'wagmi'
import { mainnet, sepolia } from 'wagmi/chains'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { QueryClient } from '@tanstack/react-query'

// Get projectId from environment or use demo
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'demo-project-id'

// Create query client
export const queryClient = new QueryClient()

// Set up wagmi adapter
const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: [mainnet, sepolia],
})

// Metadata for the app
const metadata = {
  name: 'dMail',
  description: 'Decentralized End-to-End Encrypted Email',
  url: typeof window !== 'undefined' ? window.location.origin : 'https://dmail.app',
  icons: ['/dmail.svg']
}

// Create modal
createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks: [mainnet, sepolia],
  defaultNetwork: mainnet,
  metadata,
  features: {
    analytics: false,
    email: false,
    socials: false,
  },
  themeMode: 'dark',
  themeVariables: {
    '--w3m-accent': 'hsl(217.2 91.2% 59.8%)',
    '--w3m-border-radius-master': '0.5rem',
  }
})

export const wagmiConfig = wagmiAdapter.wagmiConfig

export { WagmiProvider }
