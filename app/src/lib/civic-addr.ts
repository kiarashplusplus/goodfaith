import { PublicKey } from "@solana/web3.js";
import { getGatewayTokenAddressForOwnerAndGatekeeperNetwork } from "@civic/solana-gateway-ts";
import { address, type Address } from "@solana/kit";

/** Civic gateway token account address for a wallet on a gatekeeper network. */
export function gatewayTokenAddress(wallet: Address, network: Address): Address {
  return address(getGatewayTokenAddressForOwnerAndGatekeeperNetwork(new PublicKey(wallet), new PublicKey(network)).toBase58());
}
