import {
  address, appendTransactionMessageInstructions, createSolanaRpc, createTransactionMessage, generateKeyPairSigner,
  getAddressEncoder, getBase64EncodedWireTransaction, getProgramDerivedAddress, getU64Encoder, getUtf8Encoder,
  pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, type Address, type Instruction, type TransactionSigner,
} from '@solana/kit';

const _gf: any = await import("../app/src/generated/index.ts");
export const gf: typeof import("../app/src/generated/index.ts") = _gf.findPoolPda ? _gf : _gf.default;
export const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
export const rpc = createSolanaRpc(RPC_URL);
export const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const GATEWAY_PROGRAM = address('gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs');
export const PROGRAM = gf.GOODFAITH_PROGRAM_ADDRESS;
export const USDC = 1_000_000n;

export async function cheat(method: string, params: unknown[]) {
  const r = await (await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as any;
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
}

export async function ata(owner: Address): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [getAddressEncoder().encode(owner), getAddressEncoder().encode(TOKEN_PROGRAM), getAddressEncoder().encode(MINT)] });
  return a;
}
export async function loanPda(pool: Address, id: bigint): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [getUtf8Encoder().encode('loan'), getAddressEncoder().encode(pool), getU64Encoder().encode(id)] });
  return a;
}

export async function send(ixs: Instruction[], feePayer: TransactionSigner, label = ''): Promise<string> {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const msg = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(bh, m), m => appendTransactionMessageInstructions(ixs, m));
  const tx = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(tx);
  const sig = await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }).send()
    .catch((e: any) => { throw new Error(`${label} failed: ${e.message} ${JSON.stringify(e.cause?.data?.logs ?? e.context?.logs ?? '')}`); });
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const s = value[0];
    if (s?.err) throw new Error(`${label} tx error ${JSON.stringify(s.err, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} not confirmed`);
}

export async function expectFail(p: Promise<unknown>, what: string): Promise<string> {
  try { await p; } catch (e: any) { return String(e.message); }
  throw new Error(`expected failure: ${what}`);
}

export async function sol(a: Address): Promise<bigint> { return (await rpc.getBalance(a, { commitment: 'confirmed' }).send()).value; }
export async function tok(a: Address): Promise<bigint> {
  try { return BigInt((await rpc.getTokenAccountBalance(a, { commitment: 'confirmed' }).send()).value.amount); } catch { return 0n; }
}
export async function fetchPool(pool: Address) { return (await gf.fetchPool(rpc as any, pool, { commitment: 'confirmed' })).data; }

export async function wallet(): Promise<TransactionSigner & { address: Address }> { return (await generateKeyPairSigner()) as any; }

export async function setSol(a: Address, lamports: bigint) { await cheat('surfnet_setAccount', [a, { lamports: Number(lamports) }]); }
export async function setUsdc(owner: Address, amount: bigint) { await cheat('surfnet_setTokenAccount', [owner, MINT, { amount: Number(amount), state: 'initialized' }]); }

export async function clockTs(): Promise<number> {
  const r = await rpc.getAccountInfo(address('SysvarC1ock11111111111111111111111111111111'), { encoding: 'base64' }).send();
  const d = Buffer.from(r.value!.data[0], 'base64');
  return Number(d.readBigInt64LE(32));
}
