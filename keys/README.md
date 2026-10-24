# keys

`devnet-admin.json.enc` is the Solana keypair of `2agNDw6soEttnATLgkhxup22GGoeCa7KVNfxyeeuHbve`, the devnet
deploy and admin key, encrypted with AES-256-CBC and a passphrase (PBKDF2, 2,000,000 iterations). The passphrase is
not stored anywhere in this repository.

**Devnet only.** This key must never hold real money or control a real-money deployment: the ciphertext is public
and permanent, so its safety rests entirely on the passphrase. If the passphrase may have leaked, move anything of
value off this key and stop using it.

Unlock into the Solana CLI's default location:

```sh
GF_KEY_PASSPHRASE='...' bash scripts/unlock-key.sh
```
