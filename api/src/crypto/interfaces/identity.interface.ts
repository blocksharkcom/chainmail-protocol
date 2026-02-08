export interface Identity {
  address: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  encryptionPrivateKey: Uint8Array;
  routingToken: string;
  createdAt: number;
}

export interface SerializedIdentity {
  address: string;
  publicKey: string;
  privateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
  routingToken: string;
  createdAt: number;
}

export interface PublicIdentity {
  address: string;
  publicKey: string;
  encryptionPublicKey: string;
}
