import { address, getAddressEncoder, getProgramDerivedAddress, getUtf8Encoder, type Address } from "@solana/kit";

/** Identity.com gateway program (the on-chain check in programs/goodfaith/src/gateway.rs). */
export const GATEWAY_PROGRAM: Address = address("gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs");

/**
 * Gateway token account for a wallet on a gatekeeper network: PDA of
 * [owner, "gateway", 8-byte big-endian index (0), network] under the gateway program.
 * Same derivation as `getGatewayTokenAddressForOwnerAndGatekeeperNetwork` in @civic/solana-gateway-ts.
 */
export async function gatewayTokenAddress(wallet: Address, network: Address, index = 0): Promise<Address> {
  const idx = new Uint8Array(8);
  new DataView(idx.buffer).setBigUint64(0, BigInt(index), false);
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: GATEWAY_PROGRAM,
    seeds: [enc.encode(wallet), getUtf8Encoder().encode("gateway"), idx, enc.encode(network)],
  });
  return pda;
}

/** Gatekeeper account of an authority on a network: PDA of [authority, network, "gatekeeper"]. */
export async function gatekeeperAccountAddress(authority: Address, network: Address): Promise<Address> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: GATEWAY_PROGRAM,
    seeds: [enc.encode(authority), enc.encode(network), getUtf8Encoder().encode("gatekeeper")],
  });
  return pda;
}
