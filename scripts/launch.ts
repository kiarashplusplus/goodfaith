// Creates the fund on the current cluster from launch.json, idempotently: the gatekeeper network (reusing
// gatekeeper.json / gatekeeper-network.json when present), then the pool with the launch settings and the given keys.
// Re-running against an existing pool checks it and prints the same summary. Writes launch-result.json and the env
// block the app and the services need. Pays and becomes the pool authority with ADMIN_KEYPAIR (default
// ~/.config/solana/id.json); hand the role to the multisig afterwards with `npm run admin -- propose-authority`.
//
//   npm run launch -- [--params launch.json] [--issuer <pubkey>] [--recovery <pubkey>] [--pause <pubkey>]
//                     [--network <pubkey>] [--timelock <sec>] [--recovery-delay <sec>] [--mint <pubkey>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { address, createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import { fetchPool, gf, rpc, RPC_URL, send } from './lib.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DAY = 86_400n;

type LaunchFile = {
  mint: string; decimals: number; maxLoan: number; maxTermDays: number; graceDays: number; maxGuaranteesPerMember: number; cosignerEscrowBps: number;
  timelockDays: number; recoveryDelayDays: number; requestTtlDays: number; firstLoanCap: number; loanCapStep: number; cooldownDays: number;
  maxExposurePerPerson: number; disbursementWindowDays: number; disbursementCapPerWindow: number; defaultBanDays: number; lateBanDays: number; cosignerBanDays: number;
  seasoningDays: number; capStepIntervalDays: number; maxOutstandingPrincipal: number; maxTotalLent: number;
};
const file = JSON.parse(fs.readFileSync(flag('params') ?? path.join(here, 'launch.json'), 'utf8')) as LaunchFile;
const base = (tokens: number) => BigInt(Math.round(tokens * 10 ** file.decimals));
const days = (d: number) => BigInt(d) * DAY;

const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ADMIN_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const mint = address(flag('mint') ?? file.mint);
const issuer = address(flag('issuer') ?? admin.address);
const recovery = address(flag('recovery') ?? admin.address);
const pause = address(flag('pause') ?? admin.address);
// Second signer of a wind-down announcement: the upgrade multisig at launch, the admin on a test fork.
const successorAuthority = address(flag('successor-authority') ?? admin.address);

// Gatekeeper network: an explicit key, the one gatekeeper-setup wrote, or a fresh one created now.
let network: Address;
const gkFile = path.join(here, 'gatekeeper.json');
if (flag('network')) network = address(flag('network')!);
else if (fs.existsSync(gkFile)) network = address((JSON.parse(fs.readFileSync(gkFile, 'utf8')) as { network: string }).network);
else {
  const { ensureGatekeeper, keypairFor } = await import('../app/src/lib/identity/gatekeeper.ts');
  const netFile = process.env.GATEKEEPER_NETWORK_FILE ?? path.join(here, 'gatekeeper-network.json');
  const net = fs.existsSync(netFile) ? keypairFor(Uint8Array.from(JSON.parse(fs.readFileSync(netFile, 'utf8')))) : keypairFor();
  if (!fs.existsSync(netFile)) fs.writeFileSync(netFile, JSON.stringify([...net.secret]));
  const adminSecret = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.GATEKEEPER_KEYPAIR ?? process.env.ADMIN_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json'), 'utf8')));
  const res = await ensureGatekeeper({ rpcUrl: RPC_URL, networkSecret: net.secret, gatekeeperSecret: adminSecret });
  fs.writeFileSync(gkFile, JSON.stringify(res, null, 1));
  network = res.network;
  console.log(`gatekeeper network ${res.network}, gatekeeper ${res.gatekeeper} (${res.added ? 'added' : 'already present'})`);
}

const params = {
  gatekeeperNetwork: network,
  maxLoan: base(file.maxLoan),
  maxTermDays: file.maxTermDays,
  graceDays: file.graceDays,
  maxGuaranteesPerMember: file.maxGuaranteesPerMember,
  cosignerEscrowBps: file.cosignerEscrowBps,
  issuer,
  timelockSeconds: flag('timelock') ? BigInt(flag('timelock')!) : days(file.timelockDays),
  recoveryAuthority: recovery,
  pauseAuthority: pause,
  recoveryDelaySeconds: flag('recovery-delay') ? BigInt(flag('recovery-delay')!) : days(file.recoveryDelayDays),
  requestTtlSeconds: days(file.requestTtlDays),
  firstLoanCap: base(file.firstLoanCap),
  loanCapStep: base(file.loanCapStep),
  cooldownSeconds: days(file.cooldownDays),
  maxExposurePerPerson: base(file.maxExposurePerPerson),
  disbursementWindowSeconds: days(file.disbursementWindowDays),
  disbursementCapPerWindow: base(file.disbursementCapPerWindow),
  defaultBanSeconds: days(file.defaultBanDays),
  lateBanSeconds: days(file.lateBanDays),
  cosignerBanSeconds: days(file.cosignerBanDays),
  seasoningSeconds: days(file.seasoningDays),
  capStepIntervalSeconds: days(file.capStepIntervalDays),
  maxOutstandingPrincipal: base(file.maxOutstandingPrincipal),
  successorAuthority,
  maxTotalLent: base(file.maxTotalLent),
};

const [pool] = await gf.findPoolPda({ mint });
const [vault] = await gf.findVaultPda({ pool });
const exists = (await rpc.getAccountInfo(pool, { encoding: 'base64' }).send()).value !== null;
if (!exists) {
  await send([await gf.getInitializePoolInstructionAsync({ payer: admin, mint, params })], admin, 'initialize_pool');
  console.log(`pool ${pool} created`);
} else {
  console.log(`pool ${pool} already exists; checking it`);
}
const p = await fetchPool(pool);
const problems: string[] = [];
if (p.gatekeeperNetwork !== network) problems.push(`gatekeeper network is ${p.gatekeeperNetwork}, expected ${network}`);
if (p.issuer !== issuer) problems.push(`issuer is ${p.issuer}, expected ${issuer}`);
if (p.recoveryAuthority !== recovery) problems.push(`recovery authority is ${p.recoveryAuthority}, expected ${recovery}`);
if (p.pauseAuthority !== pause) problems.push(`pause authority is ${p.pauseAuthority}, expected ${pause}`);
if (p.successorAuthority !== successorAuthority) problems.push(`successor authority is ${p.successorAuthority}, expected ${successorAuthority}`);
const authority = p.authority.__option === 'Some' ? p.authority.value : 'none';
const fmt = (n: bigint) => (Number(n) / 10 ** file.decimals).toFixed(2);
const d = (s: bigint) => (s === 9223372036854775807n ? 'for good' : s % 86_400n === 0n ? `${s / 86_400n} days` : `${s} s`);
console.log(`
pool            ${pool}
vault           ${vault}
mint            ${mint}
program         ${gf.GOODFAITH_PROGRAM_ADDRESS}
authority       ${authority}
issuer          ${p.issuer}
recovery        ${p.recoveryAuthority}
pause           ${p.pauseAuthority}
network         ${p.gatekeeperNetwork}
max loan        ${fmt(p.maxLoan)} (first ${fmt(p.firstLoanCap)}, +${fmt(p.loanCapStep)} per on-time loan held ${d(p.seasoningSeconds)}, at most one step per ${d(p.capStepIntervalSeconds)}, ${d(p.cooldownSeconds)} cooldown)
term / grace    ${p.maxTermDays} / ${p.graceDays} days, escrow ${p.cosignerEscrowBps / 100}%, ${p.maxGuaranteesPerMember} guarantees
exposure        ${fmt(p.maxExposurePerPerson)} per person; ${fmt(p.disbursementCapPerWindow)} per ${d(p.disbursementWindowSeconds)}; ${p.maxOutstandingPrincipal === 0n ? 'no ceiling' : `${fmt(p.maxOutstandingPrincipal)} ceiling`} on principal out on loan; ${p.maxTotalLent === 0n ? 'no lending budget' : `${fmt(p.maxTotalLent)} lending budget`} in total
notice          ${d(p.timelockSeconds)}; recovery delay ${d(p.recoveryDelaySeconds)}; request ttl ${d(p.requestTtlSeconds)}
bars            default ${d(p.defaultBanSeconds)}, late ${d(p.lateBanSeconds)}, co-signer ${d(p.cosignerBanSeconds)}
paused          ${p.paused}
`);
const result = { pool, vault, mint, program: gf.GOODFAITH_PROGRAM_ADDRESS, authority, issuer: p.issuer, recoveryAuthority: p.recoveryAuthority, pauseAuthority: p.pauseAuthority, network: p.gatekeeperNetwork, rpcUrl: RPC_URL, created: !exists };
fs.writeFileSync(path.join(here, 'launch-result.json'), JSON.stringify(result, null, 1));
console.log(`# app environment (NEXT_PUBLIC_* at build time)
NEXT_PUBLIC_RPC_URL=${RPC_URL}
NEXT_PUBLIC_PROGRAM_ID=${gf.GOODFAITH_PROGRAM_ADDRESS}
NEXT_PUBLIC_POOL_MINT=${mint}
NEXT_PUBLIC_POOL_ADDRESS=${pool}
NEXT_PUBLIC_POOL_AUTHORITY=${authority}
NEXT_PUBLIC_GATEKEEPER_NETWORK=${p.gatekeeperNetwork}
# the identity service holds ISSUER_SECRET for ${p.issuer} and GATEKEEPER_SECRET for a gatekeeper on ${p.gatekeeperNetwork};
# the operator's recovery CLI (scripts/recovery.ts) holds RECOVERY_KEYPAIR for ${p.recoveryAuthority}
`);
if (problems.length) {
  console.error('PROBLEMS:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('LAUNCH PASS');
