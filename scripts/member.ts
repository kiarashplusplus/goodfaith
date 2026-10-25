// A member's fallback client: every action the web app offers, from the command line against the RPC alone, so a
// member is never locked out when the app or the fee sponsor is down. Signs with MEMBER_KEYPAIR (default
// ~/.config/solana/id.json): a solana-keygen JSON file, or a file holding the key the app's "Export my wallet key"
// shows (base58, or hex). Pays its own fees. Amounts are in whole tokens (40 or 12.5).
//
//   npm run member -- status [wallet]
//   npm run member -- request <amount> <termDays> <cosignerWallet>
//   npm run member -- cancel
//   npm run member -- cosign <borrowerWallet>
//   npm run member -- repay <loanId> <amount>          (before the deadline)
//   npm run member -- pay-back <loanId> <amount>       (after it: settles the loan first when nobody has, then pays)
//   npm run member -- settle <loanId> | collect <loanId>
//   npm run member -- claim <loanId>
//   npm run member -- waive <loanId>                   (co-signer: gives up your own claim; the fund's claim stays owed)
//   npm run member -- renew                            (via the app at APP_URL: a fresh year on the pass, no new ID check)
//   npm run member -- close-expired <borrowerWallet>
//   npm run member -- veto | finalize
//   npm run member -- donate <amount>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { address, createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, createNoopSigner, getBase58Encoder, getBase64Decoder, signBytes, type Address, type Instruction } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { rpc, RPC_URL } from './lib.ts';

process.env.NEXT_PUBLIC_RPC_URL = RPC_URL;
process.env.NEXT_PUBLIC_KORA_URL = '';
const prog = await import('../app/src/lib/program.ts');
const tx = await import('../app/src/lib/tx.ts');
const cfg = await import('../app/src/lib/config.ts');
const { gatewayTokenAddress } = await import('../app/src/lib/gateway.ts');
const { escrowFor } = await import('../app/src/lib/escrow.ts');
const { loanTiming } = await import('../app/src/lib/loan-status.ts');
const { proofMessage } = await import('../app/src/lib/identity/wallet-proof.ts');

type Rpc = Parameters<typeof tx.sendInstructions>[0] & Parameters<typeof prog.fetchPool>[0] & Parameters<typeof prog.fetchLoansFor>[0];
const txRpc = rpc as unknown as Rpc;
const DECIMALS = 6n;
const amountOf = (s: string): bigint => {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error(`amount "${s}" is not a number with up to 6 decimals`);
  return BigInt(m[1]!) * 10n ** DECIMALS + BigInt((m[2] ?? '').padEnd(6, '0'));
};
const fmt = (n: bigint) => (Number(n) / 1e6).toFixed(2);
const when = (t: bigint) => (t === 0n ? '-' : t === prog.PERMANENT ? 'for good' : new Date(Number(t) * 1000).toISOString());

/** The member's key from MEMBER_KEYPAIR's text: a JSON byte array, or an exported key in base58 or hex (32 or 64 bytes). */
export async function memberSigner(text: string) {
  const t = text.trim();
  const bytes = t.startsWith('[')
    ? Uint8Array.from(JSON.parse(t) as number[])
    : /^(0x)?[0-9a-fA-F]+$/.test(t) && (t.replace(/^0x/, '').length === 64 || t.replace(/^0x/, '').length === 128)
      ? Uint8Array.from(t.replace(/^0x/, '').match(/../g)!, (h) => parseInt(h, 16))
      : new Uint8Array(getBase58Encoder().encode(t));
  if (bytes.length === 64) return createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error(`MEMBER_KEYPAIR holds a ${bytes.length}-byte key; expected 32 or 64 bytes`);
}

export async function run(argv: string[], out: (line: string) => void = console.log): Promise<void> {
  const [cmd = 'status', ...args] = argv;
  const keyPath = process.env.MEMBER_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json');
  const signer = await memberSigner(fs.readFileSync(keyPath, 'utf8'));
  const [poolAddr] = await prog.findPoolPda(cfg.POOL_MINT);
  const pool = await prog.fetchPool(txRpc, poolAddr);
  if (!pool) throw new Error(`pool ${poolAddr} not found at ${RPC_URL}`);
  const me = signer.address;
  const send = (ixs: Instruction[] | ((feePayer: Address) => Promise<Instruction[]>)) => tx.sendInstructions(txRpc, signer, ixs, { sponsor: false });
  const gw = (w: Address) => gatewayTokenAddress(w, pool.gatekeeperNetwork);
  const personOf = async (w: Address) => {
    const m = await prog.fetchMember(txRpc, pool.address, w);
    if (!m) throw new Error(`${w} is not a member`);
    if (m.retired) throw new Error(`${w} was replaced; use the wallet now linked to the membership`);
    return m;
  };
  const ataCreate = (payer: Address, ata: Address, owner: Address) =>
    getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer), ata, owner, mint: pool.mint }) as Instruction;
  const loanById = async (id: string) => {
    const l = await prog.fetchLoanById(txRpc, pool.address, BigInt(id));
    if (!l) throw new Error(`loan #${id} not found`);
    return l;
  };

  switch (cmd) {
    case 'status': {
      const w = args[0] ? address(args[0]) : me;
      const now = BigInt(Math.floor(Date.now() / 1000));
      out(`wallet      ${w}`);
      out(`pool        ${pool.address} (${pool.paused ? 'PAUSED' : prog.windingDown(pool, now) ? 'WINDING DOWN' : 'open'})`);
      const m = await prog.fetchMember(txRpc, pool.address, w);
      if (!m) {
        out('membership  none');
        return;
      }
      const p = (await prog.fetchPerson(txRpc, m.person))!;
      out(`membership  ${m.retired ? 'RETIRED (wallet replaced)' : 'active'}  person ${m.person}`);
      out(`standing    ${prog.eligibleAt(p, now) ? 'eligible' : `barred until ${when(p.ineligibleUntil)}`}  cap ${fmt(prog.loanCapAt(p, pool, now))}  completed ${p.completedLoans}  guarantees ${p.activeGuarantees} (${fmt(p.activeGuaranteeAmount)})`);
      if (p.pendingWallet) out(`recovery    moving to ${p.pendingWallet} after ${when(p.pendingWalletAt)} (veto with: member veto)`);
      const req = await prog.fetchRequest(txRpc, pool.address, w);
      if (req) out(`request     ${fmt(req.amount)} for ${req.termDays} days, co-signer ${req.cosigner}, expires ${when(req.expiresAt)}`);
      for (const r of await prog.fetchRequestsForCosigner(txRpc, pool.address, w)) out(`to co-sign  ${r.borrower} asks ${fmt(r.amount)} for ${r.termDays} days (expires ${when(r.expiresAt)})`);
      for (const l of await prog.fetchLoansFor(txRpc, pool, w)) {
        const role = l.borrowerPerson === m.person ? 'borrowed' : 'co-signed';
        const t = loanTiming(l, now);
        const owedBack = l.status === 'Defaulted'
          ? `, ${fmt(prog.owedAfterSettlement(l))} still owed: ${fmt(prog.fundClaim(l))} to the fund, ${fmt(prog.cosignerClaim(l))} to the co-signer (member pay-back ${l.id} <amount>${role === 'co-signed' && prog.cosignerClaim(l) > 0n ? `, or waive ${l.id}` : ''})`
          : [l.cosignerWaivedAt > 0n ? ', co-signer waived their claim' : '', l.fundForgivenAt > 0n ? ', fund forgave its claim' : ''].join('');
        const toCosigner = prog.owedToCosigner(l) > 0n ? `, ${fmt(prog.owedToCosigner(l))} owed to the co-signer (member claim ${l.id})` : '';
        const toFund = l.recoveryPending > 0n ? `, ${fmt(l.recoveryPending)} waiting for the fund (member collect ${l.id})` : '';
        out(`loan #${l.id}   ${role} ${fmt(l.principal)}, repaid ${fmt(l.repaid)}, ${l.status} (${t.state})${owedBack}${toCosigner}${toFund}`);
      }
      return;
    }
    case 'request': {
      const [amount, term, cosigner] = args;
      if (!amount || !term || !cosigner) throw new Error('usage: request <amount> <termDays> <cosignerWallet>');
      const m = await personOf(me);
      const sig = await send([
        await prog.requestLoanIx({ payer: me, borrower: me, borrowerPerson: m.person, pool, borrowerGatewayToken: await gw(me), amount: amountOf(amount), termDays: Number(term), cosigner: address(cosigner) }),
      ]);
      out(`requested ${amount} for ${term} days from ${cosigner}: ${sig}`);
      return;
    }
    case 'cancel': {
      const req = await prog.fetchRequest(txRpc, pool.address, me);
      if (!req) throw new Error('no open request');
      out(`cancelled: ${await send([prog.cancelRequestIx({ canceller: me, pool: pool.address, request: req })])}`);
      return;
    }
    case 'cosign': {
      const borrower = address(args[0] ?? '');
      const req = await prog.fetchRequest(txRpc, pool.address, borrower);
      if (!req) throw new Error(`${borrower} has no open request`);
      if (req.cosigner !== me) throw new Error(`that request names ${req.cosigner} as co-signer`);
      const [b, c] = await Promise.all([personOf(borrower), personOf(me)]);
      const fresh = (await prog.fetchPool(txRpc, pool.address))!;
      const escrow = escrowFor(req.amount, fresh.cosignerEscrowBps);
      out(`co-signing ${fmt(req.amount)} for ${req.termDays} days; escrow ${fmt(escrow)} leaves your wallet`);
      const sig = await send(async (feePayer) => {
        const { ix, borrowerToken } = await prog.cosignLoanIx({
          payer: feePayer, pool: fresh, request: req, borrowerPerson: b.person, cosignerPerson: c.person, borrowerGatewayToken: await gw(borrower), cosignerGatewayToken: await gw(me),
          expectedAmount: req.amount, expectedTermDays: req.termDays, maxEscrow: escrow, cosignerActiveLoan: c.activeLoan ?? undefined,
        });
        return [ataCreate(feePayer, borrowerToken, borrower), ix];
      });
      out(`co-signed loan #${fresh.loanCount}: ${sig}`);
      return;
    }
    case 'repay': {
      const [id, amount] = args;
      if (!id || !amount) throw new Error('usage: repay <loanId> <amount>');
      const loan = await loanById(id);
      out(`repaid ${amount} on loan #${id}: ${await send([await prog.repayIx({ payer: me, pool, loan, amount: amountOf(amount) })])}`);
      return;
    }
    case 'pay-back': {
      const [id, amount] = args;
      if (!id || !amount) throw new Error('usage: pay-back <loanId> <amount>');
      const loan = await loanById(id);
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (loan.status === 'Active' && loanTiming(loan, now).state !== 'defaultable') throw new Error(`loan #${id} is still repayable: use repay`);
      if (loan.status !== 'Active' && loan.status !== 'Defaulted') throw new Error(`loan #${id} is ${loan.status}: nothing is owed`);
      const ixs = loan.status === 'Active' ? [await prog.settleIx({ caller: me, pool, loan })] : [];
      ixs.push(await prog.restituteIx({ payer: me, pool, loan, amount: amountOf(amount) }));
      out(`${loan.status === 'Active' ? 'settled and ' : ''}paid back ${amount} on loan #${id}: ${await send(ixs)}`);
      return;
    }
    case 'settle': {
      const loan = await loanById(args[0] ?? '');
      out(`settled loan #${loan.id}: ${await send([await prog.settleIx({ caller: me, pool, loan })])}`);
      return;
    }
    case 'collect': {
      const loan = await loanById(args[0] ?? '');
      if (loan.recoveryPending === 0n) throw new Error(`loan #${loan.id} has nothing to collect for the fund`);
      out(`moved ${fmt(loan.recoveryPending)} to the fund: ${await send([await prog.collectRecoveryIx({ collector: me, pool, loan })])}`);
      return;
    }
    case 'claim': {
      const loan = await loanById(args[0] ?? '');
      const owed = prog.owedToCosigner(loan);
      if (owed === 0n) throw new Error(`loan #${loan.id} has nothing to claim`);
      const to = await prog.cosignerWalletOf(txRpc, loan);
      const sig = await send(async (feePayer) => {
        const { ix, cosignerToken } = await prog.claimEscrowIx({ claimer: me, pool, loan, cosignerWallet: to });
        return [ataCreate(feePayer, cosignerToken, to), ix];
      });
      out(`released ${fmt(owed)} to ${to}: ${sig}`);
      return;
    }
    case 'waive': {
      const loan = await loanById(args[0] ?? '');
      if (loan.status !== 'Defaulted') throw new Error(`loan #${loan.id} is ${loan.status}: only a settled loan with something owed can be waived`);
      const c = await personOf(me);
      if (loan.cosignerPerson !== c.person) throw new Error(`you are not the co-signer of loan #${loan.id}`);
      if (prog.cosignerClaim(loan) === 0n) throw new Error(`loan #${loan.id}: you have no claim left to waive`);
      out(`waiving your ${fmt(prog.cosignerClaim(loan))}: the fund's claim of ${fmt(prog.fundClaim(loan))} stays owed, and the bars stay as they are`);
      out(`waived: ${await send([prog.waiveReimbursementIx({ cosigner: me, pool, loan })])}`);
      return;
    }
    case 'renew': {
      const app = (process.env.APP_URL ?? process.env.IDENTITY_URL ?? '').replace(/\/$/, '');
      if (!app) throw new Error('APP_URL must point at the Good Faith app (the identity service renews passes)');
      const message = proofMessage(me, Math.floor(Date.now() / 1000));
      const signature = getBase64Decoder().decode(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message)));
      const res = await fetch(`${app}/api/identity/renew`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: me, message, signature }) });
      const body = (await res.json().catch(() => ({}))) as { expiresAt?: number; error?: string };
      if (!res.ok) throw new Error(`renew: HTTP ${res.status} ${body.error ?? ''}`.trim());
      out(`pass renewed until ${when(BigInt(body.expiresAt ?? 0))}`);
      return;
    }
    case 'close-expired': {
      const borrower = address(args[0] ?? '');
      const req = await prog.fetchRequest(txRpc, pool.address, borrower);
      if (!req) throw new Error(`${borrower} has no open request`);
      out(`closed: ${await send([prog.closeExpiredRequestIx({ closer: me, pool: pool.address, request: req })])}`);
      return;
    }
    case 'veto': {
      const m = await personOf(me);
      const p = (await prog.fetchPerson(txRpc, m.person))!;
      if (!p.pendingWallet) throw new Error('no recovery is pending for your membership');
      out(`vetoed the move to ${p.pendingWallet}: ${await send([prog.vetoRebindIx({ signer: me, pool, person: p })])}`);
      return;
    }
    case 'finalize': {
      const p = (await prog.fetchPendingRecoveries(txRpc, pool.address)).find((x) => x.pendingWallet === me);
      if (!p) throw new Error('no recovery is pending for this wallet');
      out(`finalised the move from ${p.wallet}: ${await send([await prog.finalizeRebindIx({ payer: me, pool, person: p })])}`);
      return;
    }
    case 'donate': {
      const amount = args[0];
      if (!amount) throw new Error('usage: donate <amount>');
      out(`donated ${amount}: ${await send([await prog.donateIx({ donor: me, pool, amount: amountOf(amount) })])}`);
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}"; see the header of scripts/member.ts`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  run(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
