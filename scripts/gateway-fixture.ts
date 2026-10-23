// Gateway tokens for e2e wallets: issued for real on the fund's own network when `gatekeeper-setup` has run
// (the token then comes from the actual gateway program), else cloned Civic bytes planted at the expected address.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { getAddressEncoder, type Address } from '@solana/kit';
import { cheat, GATEWAY_PROGRAM, RPC_URL } from './lib.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
const { Gatekeeper } = await import('../app/src/lib/identity/gatekeeper.ts');
const { gatewayTokenAddress } = await import('../app/src/lib/gateway.ts');

export type GatewayFixture = { network: Address; mode: 'issued' | 'planted'; tokenFor(owner: Address): Promise<Address>; addressOf(owner: Address): Promise<Address> };

export async function gatewayFixture(fallbackNetwork: Address): Promise<GatewayFixture> {
  const gkFile = path.join(here, 'gatekeeper.json');
  if (fs.existsSync(gkFile)) {
    const { network } = JSON.parse(fs.readFileSync(gkFile, 'utf8')) as { network: Address };
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8')));
    const gk = new Gatekeeper({ rpcUrl: RPC_URL, network, secret });
    return {
      network,
      mode: 'issued',
      tokenFor: (owner) => gk.issue(owner, Math.floor(Date.now() / 1000) + 365 * 86400),
      addressOf: (owner) => gatewayTokenAddress(owner, network),
    };
  }
  const real = JSON.parse(fs.readFileSync(path.join(here, 'civic-token.json'), 'utf8')) as { lamports: number; data: string };
  const realBytes = Buffer.from(real.data, 'hex');
  assert.equal(realBytes[1], 0, 'cloned token has no parent');
  return {
    network: fallbackNetwork,
    mode: 'planted',
    tokenFor: async (owner) => {
      const addr = await gatewayTokenAddress(owner, fallbackNetwork);
      const b = Buffer.from(realBytes);
      Buffer.from(getAddressEncoder().encode(owner)).copy(b, 2); // version(1)+parent tag(1) -> owner_wallet at offset 2
      Buffer.from(getAddressEncoder().encode(fallbackNetwork)).copy(b, 35); // then identity tag(1) -> network at offset 35
      await cheat('surfnet_setAccount', [addr, { lamports: real.lamports, owner: GATEWAY_PROGRAM, data: b.toString('hex') }]);
      return addr;
    },
    addressOf: (owner) => gatewayTokenAddress(owner, fallbackNetwork),
  };
}
