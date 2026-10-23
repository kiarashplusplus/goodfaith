"use client";

import { RequireWallet } from "@/components/connect-button";
import { PageTitle } from "@/components/ui";
import { VerifyAndJoin } from "@/components/verify-join";

export default function JoinPage() {
  return (
    <>
      <PageTitle title="Join" sub="Verify once, then you can borrow or co-sign for a friend." />
      <RequireWallet>{(w) => <VerifyAndJoin wallet={w} />}</RequireWallet>
    </>
  );
}
