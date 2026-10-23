/** Plain token transfers from the Checking page. */
import { createNoopSigner, fetchEncodedAccount, type Address, type GetAccountInfoApi, type Instruction, type Rpc } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { TOKEN_DECIMALS } from "./config";
import { findAta } from "./program";

export async function ataExists(rpc: Rpc<GetAccountInfoApi>, ata: Address): Promise<boolean> {
  return (await fetchEncodedAccount(rpc, ata, { commitment: "confirmed" })).exists;
}

export type SendPlan = {
  /** False when the recipient's token account must be created: the sender pays that rent, not the sponsor. */
  sponsor: boolean;
  createsAccount: boolean;
  instructions: (feePayer: Address) => Promise<Instruction[]>;
};

/**
 * A sponsored transfer only when the recipient already has a token account. Otherwise anyone could farm
 * the sponsor for token-account rent by sending dust to fresh wallets, so the sender pays fee and rent.
 */
export async function planTokenSend(
  rpc: Rpc<GetAccountInfoApi>,
  from: Address,
  to: Address,
  mint: Address,
  amount: bigint,
): Promise<SendPlan> {
  const [source, destination] = await Promise.all([findAta(from, mint), findAta(to, mint)]);
  const exists = await ataExists(rpc, destination);
  const transfer = getTransferCheckedInstruction({
    source,
    mint,
    destination,
    authority: createNoopSigner(from),
    amount,
    decimals: TOKEN_DECIMALS,
  });
  if (exists) return { sponsor: true, createsAccount: false, instructions: async () => [transfer] };
  return {
    sponsor: false,
    createsAccount: true,
    instructions: async (feePayer) => [
      getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(feePayer), ata: destination, owner: to, mint }),
      transfer,
    ],
  };
}
