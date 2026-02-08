import { useState } from 'react'
import { useAppKit, useAppKitAccount } from '@reown/appkit/react'
import { useSignMessage } from 'wagmi'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Mail, Wallet, Lock, Loader2, Shield } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth'

export function LoginPage() {
  const { open } = useAppKit()
  const { address, isConnected } = useAppKitAccount()
  const { signMessageAsync } = useSignMessage()
  const { setSession } = useAuthStore()

  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAuthenticate = async () => {
    if (!address) return

    setIsAuthenticating(true)
    setError(null)

    try {
      // Get challenge from server
      const { challenge, message } = await api.getChallenge(address)

      // Sign the challenge message (server provides the exact message to sign)
      const signature = await signMessageAsync({ message })

      // Send to server for verification
      const result = await api.login(address, signature, challenge)

      // Store session
      api.setToken(result.token)
      setSession(result.token, result.dmailAddress, result.walletAddress)

      // Start the P2P node for messaging
      try {
        await api.startNode()
      } catch (nodeErr) {
        console.warn('Failed to start P2P node:', nodeErr)
        // Continue anyway - node can be started later
      }
    } catch (err) {
      console.error('Authentication failed:', err)
      setError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setIsAuthenticating(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8">
        {/* Logo and Title */}
        <div className="text-center">
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-full bg-primary/10">
              <Mail className="h-12 w-12 text-primary" />
            </div>
          </div>
          <h1 className="text-3xl font-bold">Chainmail</h1>
          <p className="text-muted-foreground mt-2">
            Decentralized End-to-End Encrypted Email
          </p>
        </div>

        {/* Login Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Connect Your Wallet</CardTitle>
            <CardDescription>
              Sign in with your Ethereum wallet to access your encrypted inbox
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!isConnected ? (
              <>
                <Button onClick={() => open()} className="w-full gap-2" size="lg">
                  <Wallet className="h-5 w-5" />
                  Connect Wallet
                </Button>
                <p className="text-xs text-center text-muted-foreground">
                  Supports MetaMask, WalletConnect, Coinbase Wallet, and more
                </p>
              </>
            ) : (
              <>
                <div className="p-4 bg-muted rounded-lg">
                  <div className="text-sm text-muted-foreground mb-1">Connected as</div>
                  <div className="font-mono text-sm truncate">{address}</div>
                </div>

                <Button
                  onClick={handleAuthenticate}
                  className="w-full gap-2"
                  size="lg"
                  disabled={isAuthenticating}
                >
                  {isAuthenticating ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Authenticating...
                    </>
                  ) : (
                    <>
                      <Lock className="h-5 w-5" />
                      Sign In to Chainmail
                    </>
                  )}
                </Button>

                <Button
                  variant="ghost"
                  onClick={() => open()}
                  className="w-full text-muted-foreground"
                >
                  Switch Wallet
                </Button>

                {error && (
                  <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
                    {error}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Features */}
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="space-y-2">
            <div className="mx-auto w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
              <Shield className="h-5 w-5 text-green-500" />
            </div>
            <div className="text-xs text-muted-foreground">End-to-End Encrypted</div>
          </div>
          <div className="space-y-2">
            <div className="mx-auto w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center">
              <Wallet className="h-5 w-5 text-blue-500" />
            </div>
            <div className="text-xs text-muted-foreground">Wallet-Based Identity</div>
          </div>
          <div className="space-y-2">
            <div className="mx-auto w-10 h-10 rounded-full bg-purple-500/10 flex items-center justify-center">
              <Mail className="h-5 w-5 text-purple-500" />
            </div>
            <div className="text-xs text-muted-foreground">Decentralized Network</div>
          </div>
        </div>
      </div>
    </div>
  )
}
