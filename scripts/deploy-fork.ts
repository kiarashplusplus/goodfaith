// Plants the built program at its declared id on a local Surfpool fork, so no program keypair is needed.
// Uses the `surfnet_writeProgram` cheatcode (program and program-data accounts are created on the fly).
// The program is also deployed on devnet, and the fork clones remote accounts on first read, so the devnet pool (same
// mint, same address) and everything under it would leak into the fork. Before planting, the program and every
// account it owns are taken offline, and so are the token accounts at its PDAs (each pool's vault, each loan's escrow)
// for every account the program owns on the remote cluster (`REMOTE_RPC_URL`, devnet by default).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeyPairSignerFromBytes, createSolanaRpc, type Address } from '@solana/kit';
import { cheat, gf, PROGRAM, rpc } from './lib.ts';

const remote = createSolanaRpc(process.env.REMOTE_RPC_URL ?? 'https://api.devnet.solana.com');
await cheat('surfnet_offlineAccount', [PROGRAM, { includeOwnedAccounts: true }]);
const owned = await remote.getProgramAccounts(PROGRAM, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }).send();
for (const { pubkey } of owned) {
  const [vault] = await gf.findVaultPda({ pool: pubkey as Address });
  const [escrow] = await gf.findEscrowPda({ loan: pubkey as Address });
  await cheat('surfnet_offlineAccount', [vault]);
  await cheat('surfnet_offlineAccount', [escrow]);
}
console.log(`kept ${owned.length} remote program accounts and their vault and escrow addresses off the fork`);

const here = path.dirname(new URL(import.meta.url).pathname);
const so = process.env.PROGRAM_SO ?? path.join(here, '..', 'target', 'deploy', 'goodfaith.so');
if (!fs.existsSync(so)) throw new Error(`${so} not found: run \`anchor build --arch v2\` at the repo root first`);
const bytes = fs.readFileSync(so);
const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));

const CHUNK = 256 * 1024;
for (let offset = 0; offset < bytes.length; offset += CHUNK) {
  const part = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
  await cheat('surfnet_writeProgram', [PROGRAM, part.toString('hex'), offset, admin.address]);
  console.log(`wrote ${offset + part.length}/${bytes.length} bytes`);
}
const info = await rpc.getAccountInfo(PROGRAM, { encoding: 'base64' }).send();
if (!info.value?.executable) throw new Error(`program account at ${PROGRAM} is not executable after write`);
console.log(`program ${PROGRAM} is live on the fork (owner ${info.value.owner}, upgrade authority ${admin.address})`);
console.log('DEPLOY-FORK PASS');
