// One-time per cluster: creates (or reuses) the fund's own gatekeeper network and adds the admin key as its
// gatekeeper, using the Identity.com gateway program already deployed on devnet (and on a Surfpool fork of it).
// Writes gatekeeper.json (public) and gatekeeper-network.json (the network keypair; keep it out of git).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RPC_URL } from './lib.ts';

const { ensureGatekeeper, keypairFor } = await import('../app/src/lib/identity/gatekeeper.ts');
const here = path.dirname(new URL(import.meta.url).pathname);
const adminSecret = Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8')));
const netFile = process.env.GATEKEEPER_NETWORK_FILE ?? path.join(here, 'gatekeeper-network.json');
let network: ReturnType<typeof keypairFor>;
if (fs.existsSync(netFile)) {
  network = keypairFor(Uint8Array.from(JSON.parse(fs.readFileSync(netFile, 'utf8'))));
} else {
  network = keypairFor();
  fs.writeFileSync(netFile, JSON.stringify([...network.secret]));
  console.log(`new gatekeeper network keypair saved to ${netFile}`);
}
const res = await ensureGatekeeper({ rpcUrl: RPC_URL, networkSecret: network.secret, gatekeeperSecret: adminSecret });
fs.writeFileSync(path.join(here, 'gatekeeper.json'), JSON.stringify(res, null, 1));
console.log(`gatekeeper network ${res.network}, gatekeeper ${res.gatekeeper} (${res.added ? 'added' : 'already present'})`);
console.log('GATEKEEPER-SETUP PASS');
