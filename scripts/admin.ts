// The operator's command line for the pool authority: everything the administrator may do, and nothing else.
// Signs with ADMIN_KEYPAIR (required: the authority has a key of its own); pool from NEXT_PUBLIC_POOL_MINT (or --mint).
//
//   npm run admin -- show
//   npm run admin -- schedule --set graceDays=30 --set maxLoan=500000000 ...   (field=value, base units and seconds)
//   npm run admin -- cancel-params | apply
//   npm run admin -- propose-authority <pubkey> | cancel-proposal | accept-authority   (accept signs as the new key)
//   npm run admin -- suspend-issuer | pause | resume
//   npm run admin -- announce-wind-down <successorTokenAccount> | cancel-wind-down | sweep
//   npm run admin -- lift-bar <personAccount> <reason words...>   (public: the event carries the hash of the reason)
//   npm run admin -- announce-wind-down <successorTokenAccount>   (two keys: ADMIN_KEYPAIR and SUCCESSOR_KEYPAIR)
//   npm run admin -- freeze --yes
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { address, createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import { fetchPool, gf, rpc, RPC_URL, send } from './lib.ts';


process.env.NEXT_PUBLIC_RPC_URL = RPC_URL;
const cfg = await import('../app/src/lib/config.ts');

type Params = Parameters<typeof gf.getScheduleParamsInstruction>[0]['params'];
const FIELDS: Record<keyof Params, 'address' | 'u64' | 'i64' | 'u16' | 'u8'> = {
  gatekeeperNetwork: 'address', maxLoan: 'u64', maxTermDays: 'u16', graceDays: 'u16', maxGuaranteesPerMember: 'u8', cosignerEscrowBps: 'u16',
  issuer: 'address', timelockSeconds: 'i64', recoveryAuthority: 'address', pauseAuthority: 'address', recoveryDelaySeconds: 'i64', requestTtlSeconds: 'i64',
  firstLoanCap: 'u64', loanCapStep: 'u64', cooldownSeconds: 'i64', maxExposurePerPerson: 'u64', disbursementWindowSeconds: 'i64', disbursementCapPerWindow: 'u64',
  defaultBanSeconds: 'i64', lateBanSeconds: 'i64', cosignerBanSeconds: 'i64', seasoningSeconds: 'i64', capStepIntervalSeconds: 'i64', maxOutstandingPrincipal: 'u64',
  successorAuthority: 'address',
};
const PERMANENT = 9223372036854775807n;
const paramsOf = (p: Awaited<ReturnType<typeof fetchPool>>): Params =>
  Object.fromEntries((Object.keys(FIELDS) as (keyof Params)[]).map((k) => [k, p[k]])) as unknown as Params;

export async function run(argv: string[], out: (line: string) => void = console.log): Promise<void> {
  const [cmd = 'show', ...rest] = argv;
  const flagValues = (name: string) => rest.flatMap((a, i) => (a === `--${name}` && rest[i + 1] !== undefined ? [rest[i + 1]!] : []));
  const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1]?.startsWith('--') !== true);
  if (!process.env.ADMIN_KEYPAIR) throw new Error('ADMIN_KEYPAIR must be set: the authority signs with a key of its own, never a shared default');
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ADMIN_KEYPAIR, 'utf8'))));
  const mint = address(flagValues('mint')[0] ?? cfg.POOL_MINT);
  const [pool] = await gf.findPoolPda({ mint });
  const [vault] = await gf.findVaultPda({ pool });
  const p = await fetchPool(pool);
  const fmt = (n: bigint) => (Number(n) / 1e6).toFixed(2);
  const when = (t: bigint) => new Date(Number(t) * 1000).toISOString();
  const dur = (s: bigint) => (s === PERMANENT ? 'for good' : s % 86_400n === 0n ? `${Number(s / 86_400n)} days` : `${s}s`);
  const opt = <T>(o: { __option: 'Some'; value: T } | { __option: 'None' }) => (o.__option === 'Some' ? o.value : null);

  switch (cmd) {
    case 'show': {
      out(`pool          ${pool} (mint ${mint}, vault ${vault})`);
      out(`authority     ${opt(p.authority) ?? 'none (frozen)'}${opt(p.pendingAuthority) ? `, handover pending to ${opt(p.pendingAuthority)}` : ''}`);
      out(`issuer        ${p.issuer}${p.issuer === '11111111111111111111111111111111' ? ' (SUSPENDED)' : ''}`);
      out(`recovery      ${p.recoveryAuthority}    pause ${p.pauseAuthority}`);
      out(`network       ${p.gatekeeperNetwork}`);
      out(`lending       ${p.paused ? 'PAUSED' : 'open'}; active loans ${p.activeLoans}; outstanding ${fmt(p.outstandingPrincipal)} of ${p.maxOutstandingPrincipal === 0n ? 'no ceiling' : fmt(p.maxOutstandingPrincipal)}; window ${fmt(p.windowDisbursed)} of ${p.disbursementCapPerWindow === 0n ? 'no cap' : fmt(p.disbursementCapPerWindow)} since ${when(p.windowStart)}`);
      out(`owed          to co-signers: ${fmt(p.pendingClaims)} in escrows + ${fmt(p.vaultClaims)} in the vault; to the fund: ${fmt(p.recoveriesPending)} in escrows`);
      out(`totals        donated ${fmt(p.totalDonated)}, lent ${fmt(p.totalLent)}, repaid ${fmt(p.totalRepaid)}, recovered ${fmt(p.totalRecovered)}, lost ${fmt(p.totalLost)}, restituted ${fmt(p.totalRestituted)}, reimbursed ${fmt(p.totalReimbursed)}, swept ${fmt(p.totalSwept)}, loans ${p.loanCount}`);
      out(`settings      max loan ${fmt(p.maxLoan)}, first ${fmt(p.firstLoanCap)} +${fmt(p.loanCapStep)}/loan (held ${dur(p.seasoningSeconds)}, one step per ${dur(p.capStepIntervalSeconds)}), cooldown ${dur(p.cooldownSeconds)}, term ${p.maxTermDays}d, grace ${p.graceDays}d, escrow ${p.cosignerEscrowBps} bps, ${p.maxGuaranteesPerMember} guarantees, exposure ${fmt(p.maxExposurePerPerson)}`);
      out(`timing        notice ${dur(p.timelockSeconds)}, recovery delay ${dur(p.recoveryDelaySeconds)}, request ttl ${dur(p.requestTtlSeconds)}, bars default ${dur(p.defaultBanSeconds)} / late ${dur(p.lateBanSeconds)} / co-signer ${dur(p.cosignerBanSeconds)}`);
      const pending = opt(p.pendingParams);
      if (pending) {
        const changes = (Object.keys(FIELDS) as (keyof Params)[]).filter((k) => String(pending[k]) !== String(p[k])).map((k) => `${k}: ${String(p[k])} -> ${String(pending[k])}`);
        out(`scheduled     effective ${when(p.paramsEffectiveAt)}: ${changes.join(', ') || 'no field differs'}`);
      }
      const wd = opt(p.windDownAt);
      if (wd !== null) out(`wind-down     ${wd <= BigInt(Math.floor(Date.now() / 1000)) ? 'in effect' : `announced, effective ${when(wd)}`}; successor ${opt(p.successor)}`);
      return;
    }
    case 'schedule': {
      const next = { ...paramsOf(p) } as Record<string, unknown>;
      const sets = flagValues('set');
      if (!sets.length) throw new Error('usage: schedule --set field=value [--set ...]; fields: ' + Object.keys(FIELDS).join(', '));
      for (const s of sets) {
        const [k, v] = s.split('=') as [keyof Params, string];
        const kind = FIELDS[k];
        if (!kind || v === undefined) throw new Error(`unknown setting "${s}"`);
        next[k] = kind === 'address' ? address(v) : kind === 'u64' || kind === 'i64' ? (v === 'permanent' ? PERMANENT : BigInt(v)) : Number(v);
      }
      const sig = await send([gf.getScheduleParamsInstruction({ authority: signer, pool, params: next as Params })], signer, 'schedule_params');
      const after = await fetchPool(pool);
      out(`scheduled ${sets.join(' ')}; effective ${when(after.paramsEffectiveAt)} (${sig})`);
      return;
    }
    case 'cancel-params':
      out(`cancelled the scheduled change: ${await send([gf.getCancelParamsInstruction({ authority: signer, pool })], signer, 'cancel_params')}`);
      return;
    case 'apply':
      out(`applied: ${await send([gf.getApplyParamsInstruction({ pool })], signer, 'apply_params')}`);
      return;
    case 'propose-authority': {
      const next = address(positional[0] ?? '');
      out(`proposed ${next} as authority (it must accept): ${await send([gf.getProposeAuthorityInstruction({ authority: signer, pool, newAuthority: next })], signer, 'propose_authority')}`);
      return;
    }
    case 'cancel-proposal':
      out(`handover cancelled: ${await send([gf.getCancelAuthorityProposalInstruction({ authority: signer, pool })], signer, 'cancel_authority_proposal')}`);
      return;
    case 'accept-authority':
      out(`accepted as authority: ${await send([gf.getAcceptAuthorityInstruction({ newAuthority: signer, pool })], signer, 'accept_authority')}`);
      return;
    case 'suspend-issuer':
      out(`issuer suspended (schedule a new one with: schedule --set issuer=<pubkey>): ${await send([gf.getSuspendIssuerInstruction({ authority: signer, pool })], signer, 'suspend_issuer')}`);
      return;
    case 'pause':
      out(`new lending paused: ${await send([gf.getPauseLendingInstruction({ signer, pool })], signer, 'pause_lending')}`);
      return;
    case 'resume':
      out(`lending resumed: ${await send([gf.getResumeLendingInstruction({ authority: signer, pool })], signer, 'resume_lending')}`);
      return;
    case 'announce-wind-down': {
      // Two keys: the authority and the pool's successor authority (SUCCESSOR_KEYPAIR, or the same key
      // when the pool names the authority as both).
      const successor = address(positional[0] ?? '');
      const secondPath = process.env.SUCCESSOR_KEYPAIR;
      const second = secondPath ? await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(secondPath, 'utf8')))) : signer;
      if (second.address !== p.successorAuthority) throw new Error(`the successor authority is ${p.successorAuthority}; set SUCCESSOR_KEYPAIR to its keypair file`);
      out(`wind-down announced to ${successor}: ${await send([gf.getAnnounceWindDownInstruction({ authority: signer, successorAuthority: second, pool, successorVault: successor })], signer, 'announce_wind_down')}`);
      return;
    }
    case 'cancel-wind-down':
      out(`wind-down cancelled: ${await send([gf.getCancelWindDownInstruction({ authority: signer, pool })], signer, 'cancel_wind_down')}`);
      return;
    case 'sweep': {
      const successor = opt(p.successor);
      if (!successor) throw new Error('no successor announced');
      out(`swept to ${successor}: ${await send([await gf.getSweepToSuccessorInstructionAsync({ mint, vault, successorVault: successor })], signer, 'sweep_to_successor')}`);
      return;
    }
    case 'lift-bar': {
      const person = address(positional[0] ?? '');
      const reason = positional.slice(1).join(' ').trim();
      if (!reason) throw new Error('usage: lift-bar <personAccount> <reason words...>  (publish the reason; its hash goes on chain)');
      const hash = createHash('sha256').update(reason).digest();
      const sig = await send([gf.getLiftBarInstruction({ authority: signer, pool, person, reason: hash })], signer, 'lift_bar');
      out(`bar lifted for ${person}: ${sig}`);
      out(`reason hash   ${hash.toString('hex')}  (sha256 of: ${JSON.stringify(reason)}; publish both)`);
      // The identity service mirrors the chain's bar; tell it the bar is gone so the person's record follows.
      const url = process.env.IDENTITY_URL ?? process.env.APP_URL, key = process.env.IDENTITY_ADMIN_KEY;
      if (url && key) {
        const personId = Buffer.from((await gf.fetchPerson(rpc as any, person, { commitment: 'confirmed' })).data.personId).toString('hex');
        const res = await fetch(`${url}/api/identity/ban`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-identity-admin-key': key }, body: JSON.stringify({ personId, until: '0' }) });
        out(`identity      ${res.ok ? 'bar lifted in the identity service' : `identity service answered HTTP ${res.status}`}`);
      } else out('identity      IDENTITY_URL/APP_URL and IDENTITY_ADMIN_KEY not set; lift the bar in the identity service too (POST /api/identity/ban with until=0)');
      return;
    }
    case 'freeze':
      if (!rest.includes('--yes')) throw new Error('freeze is irreversible: the fund can never be changed, paused, resumed or wound down (unless already announced). Add --yes.');
      out(`frozen: ${await send([gf.getFreezePoolInstruction({ authority: signer, pool })], signer, 'freeze_pool')}`);
      return;
    default:
      throw new Error(`unknown command "${cmd}"; see the header of scripts/admin.ts`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  run(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
export { Address };
