import { describe, expect, it } from "vitest";
import { address, type GetAccountInfoApi, type Rpc } from "@solana/kit";
import { planTokenSend } from "./send";
import { findAta } from "./program";
import { POOL_MINT } from "./config";

const A = address("2agNDw6soEttnATLgkhxup22GGoeCa7KVNfxyeeuHbve");
const B = address("uniqobk8oGh4XBLMqM68K8M2zNu3CdYX7q5go7whQiv");

const rpcWith = (existing: Set<string>) =>
  ({
    getAccountInfo: (addr: string) => ({
      send: async () => ({
        context: { slot: 0n },
        value: existing.has(addr) ? { data: ["", "base64"], executable: false, lamports: 1n, owner: A, rentEpoch: 0n, space: 0n } : null,
      }),
    }),
  }) as unknown as Rpc<GetAccountInfoApi>;

describe("planTokenSend", () => {
  it("sponsors a transfer to an existing token account, without a create prefix", async () => {
    const ata = await findAta(B, POOL_MINT);
    const plan = await planTokenSend(rpcWith(new Set([ata])), A, B, POOL_MINT, 5n);
    expect(plan).toMatchObject({ sponsor: true, createsAccount: false });
    expect(await plan.instructions(A)).toHaveLength(1);
  });
  it("makes the sender pay when the recipient's account must be created", async () => {
    const plan = await planTokenSend(rpcWith(new Set()), A, B, POOL_MINT, 5n);
    expect(plan).toMatchObject({ sponsor: false, createsAccount: true });
    const ixs = await plan.instructions(A);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.accounts![0]!.address).toBe(A); // the sender funds the new account
  });
});
