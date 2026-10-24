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

The other keypairs here use the same passphrase and the same scheme, under the same devnet-only rule:

| file | public key | what it is |
|---|---|---|
| `devnet-program.json.enc` | `BvYSoBvDqLGrnrMqSpPguFkApyNTTj219mLWQGnrkCGq` | the program keypair (`target/deploy/goodfaith-keypair.json`), the devnet program id |
| `devnet-gatekeeper-network.json.enc` | `B9p1QCuQDzj6dnds8sppuSzCjxTxyqFzCRnekEVmhnJj` | the fund's gatekeeper network (`scripts/gatekeeper-network.json`, reused by `gatekeeper-setup`) |
| `fork-kora-signer.json.enc` | `8fijqKWSgEF1puay8N6YwwzmiGFhEoUaQreovzdEfavy` | a throwaway Kora signer used on a local fork; holds nothing |

Unlock one with its name as the second argument, encrypt a new one with `lock-key.sh` (it refuses to overwrite and
checks the round trip):

```sh
GF_KEY_PASSPHRASE='...' bash scripts/unlock-key.sh target/deploy/goodfaith-keypair.json devnet-program
GF_KEY_PASSPHRASE='...' bash scripts/lock-key.sh <keypair.json> <name>
```
