use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    goodfaith::{
        error::GoodFaithError,
        gateway::GATEWAY_PROGRAM_ID,
        state::{Loan, LoanRequest, LoanStatus, Member, Person, Pool, PoolParams},
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_transaction::Transaction,
};

const T0: i64 = 1_700_000_000;
const DAY: i64 = 86_400;
const TOKEN_PROGRAM: Pubkey = anchor_spl::token::ID;

fn program_id() -> Pubkey {
    goodfaith::id()
}

struct Actor {
    kp: Keypair,
    token: Pubkey,
    gateway: Pubkey,
    /// What the issuer vouches for: one opaque id per human, shared by a replacement wallet.
    person_id: [u8; 32],
}

impl Actor {
    fn key(&self) -> Pubkey {
        self.kp.pubkey()
    }
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    mint: Pubkey,
    pool: Pubkey,
    vault: Pubkey,
    network: Pubkey,
    issuer: Keypair,
    recovery: Keypair,
    pauser: Keypair,
    timelock: i64,
    recovery_delay: i64,
}

impl Env {
    /// Launch-style settings with this pool's keys and delays. Caps and limits are set so the classic
    /// loan tests are unaffected; the v3 tests tighten them with `tune`.
    fn params(&self, bps: u16) -> PoolParams {
        PoolParams {
            gatekeeper_network: self.network,
            max_loan: 1_000_000,
            max_term_days: 90,
            grace_days: 7,
            max_guarantees_per_member: 2,
            cosigner_escrow_bps: bps,
            issuer: self.issuer.pubkey(),
            timelock_seconds: self.timelock,
            recovery_authority: self.recovery.pubkey(),
            pause_authority: self.pauser.pubkey(),
            recovery_delay_seconds: self.recovery_delay,
            request_ttl_seconds: 7 * DAY,
            first_loan_cap: 1_000_000,
            loan_cap_step: 0,
            cooldown_seconds: 0,
            max_exposure_per_person: 10_000_000,
            disbursement_window_seconds: DAY,
            disbursement_cap_per_window: 0,
            default_ban_seconds: i64::MAX,
            late_ban_seconds: 0,
            cosigner_ban_seconds: i64::MAX,
        }
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    /// Whether a person is barred right now.
    fn barred(&self, a: &Actor) -> bool {
        !self.person(a).eligible(self.now())
    }

    /// Changes settings at once (timelock must be 0): schedule + apply of the current params with `f` applied.
    fn tune(&mut self, f: impl FnOnce(&mut PoolParams)) {
        let bps = self.pool_state().cosigner_escrow_bps;
        let mut p = self.params(bps);
        p.issuer = self.pool_state().issuer;
        f(&mut p);
        let admin = self.admin.insecure_clone();
        self.update_pool(&admin, p).unwrap();
    }
}

fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    d
}

fn mint_data() -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[44] = 6;
    d[45] = 1;
    d
}

fn gateway_data(wallet: &Pubkey, network: &Pubkey, state: u8, expiry: Option<i64>) -> Vec<u8> {
    let mut d = vec![0u8, 0u8];
    d.extend_from_slice(wallet.as_ref());
    d.push(0);
    d.extend_from_slice(network.as_ref());
    d.extend_from_slice(Pubkey::new_unique().as_ref());
    d.push(state);
    match expiry {
        None => d.push(0),
        Some(t) => {
            d.push(1);
            d.extend_from_slice(&t.to_le_bytes());
        }
    }
    d
}

/// `err` is a program error, an Anchor framework `ErrorCode`, or a raw code (0 = system "already in use").
fn assert_fails(res: Result<(), String>, err: impl Into<u32>) {
    let code: u32 = err.into();
    let msg = res.expect_err("transaction should fail");
    assert!(
        msg.contains(&format!("Custom({code})")),
        "expected error code {code}, got {msg}"
    );
}

impl Env {
    fn new(bps: u16) -> Self {
        Self::with_timelock(bps, 0)
    }

    fn with_timelock(bps: u16, timelock: i64) -> Self {
        Self::with_delays(bps, timelock, 0)
    }

    fn with_delays(bps: u16, timelock: i64, recovery_delay: i64) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(
            program_id(),
            include_bytes!("../../../target/deploy/goodfaith.so"),
        )
        .unwrap();
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
        let issuer = Keypair::new();
        svm.airdrop(&issuer.pubkey(), 1_000_000_000).unwrap();
        let recovery = Keypair::new();
        svm.airdrop(&recovery.pubkey(), 1_000_000_000).unwrap();
        let pauser = Keypair::new();
        svm.airdrop(&pauser.pubkey(), 1_000_000_000).unwrap();
        let mint = Pubkey::new_unique();
        svm.set_account(
            mint,
            Account {
                lamports: 1_000_000_000,
                data: mint_data(),
                owner: TOKEN_PROGRAM,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let (pool, _) = Pubkey::find_program_address(&[b"pool", mint.as_ref()], &program_id());
        let (vault, _) = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &program_id());
        let mut env = Env {
            svm,
            admin,
            mint,
            pool,
            vault,
            network: Pubkey::new_unique(),
            issuer,
            recovery,
            pauser,
            timelock,
            recovery_delay,
        };
        env.set_time(T0);
        let p = env.params(bps);
        env.initialize_pool(p).unwrap();
        env
    }

    fn set_time(&mut self, t: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = t;
        self.svm.set_sysvar(&clock);
    }

    fn send(&mut self, ix: Instruction, payer: &Keypair, extra: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &bh);
        let mut signers: Vec<&Keypair> = vec![payer];
        for k in extra {
            if !signers.iter().any(|s| s.pubkey() == k.pubkey()) {
                signers.push(k);
            }
        }
        let tx = Transaction::new(&signers, msg, bh);
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    fn initialize_pool(&mut self, p: PoolParams) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::InitializePool { params: p }.data(),
            goodfaith::accounts::InitializePool {
                payer: self.admin.pubkey(),
                mint: self.mint,
                pool: self.pool,
                vault: self.vault,
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let admin = self.admin.insecure_clone();
        self.send(ix, &admin, &[])
    }

    /// A settings change end to end: schedule, then apply (instant when the timelock is zero).
    fn update_pool(&mut self, signer: &Keypair, p: PoolParams) -> Result<(), String> {
        self.schedule_params(signer, p)?;
        self.apply_params()
    }

    fn schedule_params(&mut self, signer: &Keypair, p: PoolParams) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::ScheduleParams { params: p }.data(),
            goodfaith::accounts::UpdatePool {
                authority: signer.pubkey(),
                pool: self.pool,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer, &[])
    }

    fn freeze_pool(&mut self, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::FreezePool {}.data(),
            goodfaith::accounts::UpdatePool {
                authority: signer.pubkey(),
                pool: self.pool,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer, &[])
    }

    fn set_gateway(&mut self, addr: Pubkey, data: Vec<u8>) {
        self.svm
            .set_account(
                addr,
                Account {
                    lamports: 1_000_000,
                    data,
                    owner: GATEWAY_PROGRAM_ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    /// New wallet with SOL, a token account and a valid gateway token (not yet a member).
    fn actor(&mut self, tokens: u64) -> Actor {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 5_000_000_000).unwrap();
        let token = Pubkey::new_unique();
        self.svm
            .set_account(
                token,
                Account {
                    lamports: 2_000_000,
                    data: token_account_data(&self.mint, &kp.pubkey(), tokens),
                    owner: TOKEN_PROGRAM,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let gateway = Pubkey::new_unique();
        self.set_gateway(gateway, gateway_data(&kp.pubkey(), &self.network, 0, None));
        Actor {
            kp,
            token,
            gateway,
            person_id: Pubkey::new_unique().to_bytes(),
        }
    }

    /// A fresh wallet (SOL, tokens, gateway token) for the same person as `a`, tracked for `token_of`.
    fn new_wallet_for(&mut self, a: &Actor, tokens: u64) -> Actor {
        let mut n = self.actor(tokens);
        n.person_id = a.person_id;
        TOKEN_ACCOUNTS.with(|m| m.borrow_mut().insert(n.key(), n.token));
        n
    }

    fn person_addr(&self, hash: &[u8; 32]) -> Pubkey {
        Pubkey::find_program_address(
            &[b"person", self.pool.as_ref(), hash.as_ref()],
            &program_id(),
        )
        .0
    }

    /// The wallet currently bound to a person account.
    fn wallet_of(&self, person: &Pubkey) -> Pubkey {
        self.read::<Person>(person).wallet
    }

    fn member_addr(&self, wallet: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[b"member", self.pool.as_ref(), wallet.as_ref()],
            &program_id(),
        )
        .0
    }

    fn register(&mut self, a: &Actor) -> Result<(), String> {
        self.register_with(a, a.gateway)
    }

    fn register_with(&mut self, a: &Actor, gateway: Pubkey) -> Result<(), String> {
        self.register_paid(a, gateway, None)
    }

    fn register_paid(
        &mut self,
        a: &Actor,
        gateway: Pubkey,
        payer: Option<&Keypair>,
    ) -> Result<(), String> {
        let issuer = self.issuer.insecure_clone();
        self.register_full(a, gateway, payer, &issuer)
    }

    fn register_as(&mut self, a: &Actor, issuer: &Keypair) -> Result<(), String> {
        self.register_full(a, a.gateway, None, issuer)
    }

    fn register_full(
        &mut self,
        a: &Actor,
        gateway: Pubkey,
        payer: Option<&Keypair>,
        issuer: &Keypair,
    ) -> Result<(), String> {
        let payer_key = payer.map_or(a.key(), |p| p.pubkey());
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::RegisterMember {
                person_id: a.person_id,
            }
            .data(),
            goodfaith::accounts::RegisterMember {
                wallet: a.key(),
                payer: payer_key,
                issuer: issuer.pubkey(),
                pool: self.pool,
                person: self.person_addr(&a.person_id),
                member: self.member_addr(&a.key()),
                gateway_token: gateway,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        match payer {
            Some(p) => self.send(ix, p, &[&a.kp, issuer]),
            None => self.send(ix, &a.kp, &[issuer]),
        }
    }

    fn member_actor(&mut self, tokens: u64) -> Actor {
        let a = self.actor(tokens);
        self.register(&a).unwrap();
        a
    }

    fn donate(&mut self, a: &Actor, amount: u64) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::Donate { amount }.data(),
            goodfaith::accounts::Donate {
                donor: a.key(),
                pool: self.pool,
                mint: self.mint,
                vault: self.vault,
                donor_token: a.token,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        );
        self.send(ix, &a.kp, &[])
    }

    fn fund(&mut self, amount: u64) {
        let donor = self.actor(amount);
        self.donate(&donor, amount).unwrap();
    }

    fn pool_state(&self) -> Pool {
        self.read(&self.pool)
    }

    /// The person behind an actor: eligibility, open loan and guarantees live here.
    fn person(&self, a: &Actor) -> Person {
        self.read(&self.person_addr(&a.person_id))
    }

    fn member_of(&self, a: &Actor) -> Member {
        self.read(&self.member_addr(&a.key()))
    }

    fn loan_addr(&self, id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"loan", self.pool.as_ref(), id.to_le_bytes().as_ref()],
            &program_id(),
        )
        .0
    }

    fn escrow_addr(&self, loan: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"escrow", loan.as_ref()], &program_id()).0
    }

    fn loan(&self, id: u64) -> Loan {
        self.read(&self.loan_addr(id))
    }

    fn read<T: AccountDeserialize>(&self, addr: &Pubkey) -> T {
        let acc = self.svm.get_account(addr).expect("account missing");
        T::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    fn balance(&self, token: &Pubkey) -> u64 {
        let acc = self.svm.get_account(token).expect("token account missing");
        u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
    }

    fn request_addr(&self, borrower: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[b"request", self.pool.as_ref(), borrower.as_ref()],
            &program_id(),
        )
        .0
    }

    fn request_loan(
        &mut self,
        payer: &Keypair,
        borrower: &Actor,
        cosigner: &Pubkey,
        amount: u64,
        term_days: u16,
    ) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::RequestLoan {
                amount,
                term_days,
                cosigner: *cosigner,
            }
            .data(),
            goodfaith::accounts::RequestLoan {
                payer: payer.pubkey(),
                borrower: borrower.key(),
                pool: self.pool,
                mint: self.mint,
                borrower_person: self.person_addr(&borrower.person_id),
                cosigner_member: self.member_addr(cosigner),
                borrower_gateway_token: borrower.gateway,
                request: self.request_addr(&borrower.key()),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(ix, payer, &[&borrower.kp])
    }

    fn cosign_loan(
        &mut self,
        payer: &Keypair,
        borrower: &Actor,
        cosigner: &Actor,
    ) -> Result<(), String> {
        let req = self.read::<LoanRequest>(&self.request_addr(&borrower.key()));
        self.cosign_loan_with(
            payer,
            borrower,
            cosigner,
            (req.amount, req.term_days, u64::MAX),
        )
    }

    fn cosign_loan_with(
        &mut self,
        payer: &Keypair,
        borrower: &Actor,
        cosigner: &Actor,
        (expected_amount, expected_term_days, max_escrow): (u64, u16, u64),
    ) -> Result<(), String> {
        let loan = self.loan_addr(self.pool_state().loan_count);
        let request_addr = self.request_addr(&borrower.key());
        let rent_payer = self.read::<LoanRequest>(&request_addr).rent_payer;
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::CosignLoan {
                expected_amount,
                expected_term_days,
                max_escrow,
            }
            .data(),
            goodfaith::accounts::CosignLoan {
                payer: payer.pubkey(),
                cosigner: cosigner.key(),
                pool: self.pool,
                mint: self.mint,
                vault: self.vault,
                request: request_addr,
                request_rent_payer: rent_payer,
                borrower_person: self.person_addr(&borrower.person_id),
                cosigner_person: self.person_addr(&cosigner.person_id),
                borrower_token: borrower.token,
                cosigner_token: cosigner.token,
                loan,
                escrow: self.escrow_addr(&loan),
                borrower_gateway_token: borrower.gateway,
                cosigner_gateway_token: cosigner.gateway,
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
                cosigner_active_loan: None,
            }
            .to_account_metas(None),
        );
        self.send(ix, payer, &[&cosigner.kp])
    }

    fn cancel_request(&mut self, who: &Keypair, borrower: &Pubkey) -> Result<(), String> {
        let request_addr = self.request_addr(borrower);
        let rent_payer = self.read::<LoanRequest>(&request_addr).rent_payer;
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::CancelRequest {}.data(),
            goodfaith::accounts::CancelRequest {
                canceller: who.pubkey(),
                pool: self.pool,
                request: request_addr,
                rent_payer,
            }
            .to_account_metas(None),
        );
        self.send(ix, who, &[])
    }

    /// Request (unless one is already pending) and co-sign, both paid by `payer`.
    fn open_loan(
        &mut self,
        payer: &Keypair,
        borrower: &Actor,
        cosigner: &Actor,
        amount: u64,
        term_days: u16,
    ) -> Result<(), String> {
        if self
            .svm
            .get_account(&self.request_addr(&borrower.key()))
            .is_none()
        {
            self.request_loan(payer, borrower, &cosigner.key(), amount, term_days)?;
        }
        self.cosign_loan(payer, borrower, cosigner)
    }

    /// Opens a loan paid for by the borrower and returns its id.
    fn open_simple(&mut self, borrower: &Actor, cosigner: &Actor, amount: u64) -> u64 {
        let id = self.pool_state().loan_count;
        self.open_loan(
            &borrower.kp.insecure_clone(),
            borrower,
            cosigner,
            amount,
            30,
        )
        .unwrap();
        id
    }

    /// Repays and, when that closes the loan with escrow left over, claims it for the co-signer at once
    /// (what the app and the cranker do), so balance assertions read the end state.
    fn repay(&mut self, payer: &Actor, id: u64, amount: u64) -> Result<(), String> {
        self.repay_only(payer, id, amount)?;
        self.claim_if_pending(id)
    }

    fn claim_if_pending(&mut self, id: u64) -> Result<(), String> {
        let loan = self.loan(id);
        if loan.status != LoanStatus::Active && loan.refund_pending > 0 {
            let admin = self.admin.insecure_clone();
            self.claim_by(&admin, id)?;
        }
        Ok(())
    }

    fn repay_only(&mut self, payer: &Actor, id: u64, amount: u64) -> Result<(), String> {
        let loan = self.loan(id);
        let loan_addr = self.loan_addr(id);
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::Repay { amount }.data(),
            goodfaith::accounts::Repay {
                payer: payer.key(),
                pool: self.pool,
                mint: self.mint,
                vault: self.vault,
                loan: loan_addr,
                escrow: self.escrow_addr(&loan_addr),
                payer_token: payer.token,
                borrower_person: loan.borrower_person,
                cosigner_person: loan.cosigner_person,
                rent_payer: loan.rent_payer,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        );
        self.send(ix, &payer.kp, &[])
    }

    /// Marks the default and claims any leftover escrow for the co-signer (see `repay`).
    fn mark_default(&mut self, caller: &Keypair, id: u64) -> Result<(), String> {
        self.mark_default_only(caller, id)?;
        self.claim_if_pending(id)
    }

    fn mark_default_only(&mut self, caller: &Keypair, id: u64) -> Result<(), String> {
        let loan = self.loan(id);
        let loan_addr = self.loan_addr(id);
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::MarkDefault {}.data(),
            goodfaith::accounts::MarkDefault {
                caller: caller.pubkey(),
                pool: self.pool,
                mint: self.mint,
                vault: self.vault,
                loan: loan_addr,
                escrow: self.escrow_addr(&loan_addr),
                borrower_person: loan.borrower_person,
                cosigner_person: loan.cosigner_person,
                rent_payer: loan.rent_payer,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        );
        self.send(ix, caller, &[])
    }

    /// Finds the token account created for a wallet by `actor`.
    fn token_of(&self, wallet: &Pubkey) -> Pubkey {
        TOKEN_ACCOUNTS.with(|m| *m.borrow().get(wallet).expect("unknown wallet"))
    }

    fn tracked_actor(&mut self, tokens: u64) -> Actor {
        let a = self.member_actor(tokens);
        TOKEN_ACCOUNTS.with(|m| m.borrow_mut().insert(a.key(), a.token));
        a
    }

    fn propose_authority(&mut self, signer: &Keypair, new: Pubkey) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::ProposeAuthority { new_authority: new }.data(),
            goodfaith::accounts::UpdatePool {
                authority: signer.pubkey(),
                pool: self.pool,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer, &[])
    }

    fn cancel_authority_proposal(&mut self, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::CancelAuthorityProposal {}.data(),
            goodfaith::accounts::UpdatePool {
                authority: signer.pubkey(),
                pool: self.pool,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer, &[])
    }

    fn accept_authority(&mut self, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::AcceptAuthority {}.data(),
            goodfaith::accounts::AcceptAuthority {
                new_authority: signer.pubkey(),
                pool: self.pool,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer, &[])
    }

    /// Plants a classic mint and initialises a pool for it with `p`. Returns the pool address and the result.
    fn init_pool_on_new_mint(&mut self, p: PoolParams) -> (Pubkey, Result<(), String>) {
        let mint = Pubkey::new_unique();
        self.svm
            .set_account(
                mint,
                Account {
                    lamports: 1_000_000_000,
                    data: mint_data(),
                    owner: TOKEN_PROGRAM,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let (pool, _) = Pubkey::find_program_address(&[b"pool", mint.as_ref()], &program_id());
        let (vault, _) = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &program_id());
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::InitializePool { params: p }.data(),
            goodfaith::accounts::InitializePool {
                payer: self.admin.pubkey(),
                mint,
                pool,
                vault,
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let admin = self.admin.insecure_clone();
        let res = self.send(ix, &admin, &[]);
        (pool, res)
    }

    fn register_in_pool(&mut self, a: &Actor, pool: Pubkey) -> Result<(), String> {
        let member = Pubkey::find_program_address(
            &[b"member", pool.as_ref(), a.key().as_ref()],
            &program_id(),
        )
        .0;
        let person = Pubkey::find_program_address(
            &[b"person", pool.as_ref(), a.person_id.as_ref()],
            &program_id(),
        )
        .0;
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::RegisterMember {
                person_id: a.person_id,
            }
            .data(),
            goodfaith::accounts::RegisterMember {
                wallet: a.key(),
                payer: a.key(),
                issuer: self.issuer.pubkey(),
                pool,
                person,
                member,
                gateway_token: a.gateway,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let issuer = self.issuer.insecure_clone();
        self.send(ix, &a.kp, &[&issuer])
    }

    fn repay_accounts(&self, payer: &Actor, id: u64) -> goodfaith::accounts::Repay {
        let loan = self.loan(id);
        let loan_addr = self.loan_addr(id);
        goodfaith::accounts::Repay {
            payer: payer.key(),
            pool: self.pool,
            mint: self.mint,
            vault: self.vault,
            loan: loan_addr,
            escrow: self.escrow_addr(&loan_addr),
            payer_token: payer.token,
            borrower_person: loan.borrower_person,
            cosigner_person: loan.cosigner_person,
            rent_payer: loan.rent_payer,
            token_program: TOKEN_PROGRAM,
        }
    }

    fn send_repay(
        &mut self,
        accounts: &goodfaith::accounts::Repay,
        payer: &Actor,
        amount: u64,
    ) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::Repay { amount }.data(),
            accounts.to_account_metas(None),
        );
        self.send(ix, &payer.kp, &[])
    }

    fn default_accounts(&self, caller: &Keypair, id: u64) -> goodfaith::accounts::MarkDefault {
        let loan = self.loan(id);
        let loan_addr = self.loan_addr(id);
        goodfaith::accounts::MarkDefault {
            caller: caller.pubkey(),
            pool: self.pool,
            mint: self.mint,
            vault: self.vault,
            loan: loan_addr,
            escrow: self.escrow_addr(&loan_addr),
            borrower_person: loan.borrower_person,
            cosigner_person: loan.cosigner_person,
            rent_payer: loan.rent_payer,
            token_program: TOKEN_PROGRAM,
        }
    }

    fn send_default(
        &mut self,
        accounts: &goodfaith::accounts::MarkDefault,
        caller: &Keypair,
    ) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::MarkDefault {}.data(),
            accounts.to_account_metas(None),
        );
        self.send(ix, caller, &[])
    }

    fn cosign_accounts(
        &self,
        payer: &Keypair,
        borrower: &Actor,
        cosigner: &Actor,
    ) -> goodfaith::accounts::CosignLoan {
        let loan = self.loan_addr(self.pool_state().loan_count);
        let request_addr = self.request_addr(&borrower.key());
        let rent_payer = self.read::<LoanRequest>(&request_addr).rent_payer;
        goodfaith::accounts::CosignLoan {
            payer: payer.pubkey(),
            cosigner: cosigner.key(),
            pool: self.pool,
            mint: self.mint,
            vault: self.vault,
            request: request_addr,
            request_rent_payer: rent_payer,
            borrower_person: self.person_addr(&borrower.person_id),
            cosigner_person: self.person_addr(&cosigner.person_id),
            borrower_token: borrower.token,
            cosigner_token: cosigner.token,
            loan,
            escrow: self.escrow_addr(&loan),
            borrower_gateway_token: borrower.gateway,
            cosigner_gateway_token: cosigner.gateway,
            token_program: TOKEN_PROGRAM,
            system_program: system_program::ID,
            cosigner_active_loan: None,
        }
    }

    fn send_cosign(
        &mut self,
        accounts: &goodfaith::accounts::CosignLoan,
        payer: &Keypair,
        cosigner: &Actor,
    ) -> Result<(), String> {
        let req = self.read::<LoanRequest>(&accounts.request);
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::CosignLoan {
                expected_amount: req.amount,
                expected_term_days: req.term_days,
                max_escrow: u64::MAX,
            }
            .data(),
            accounts.to_account_metas(None),
        );
        self.send(ix, payer, &[&cosigner.kp])
    }
}

impl Env {
    fn apply_params(&mut self) -> Result<(), String> {
        let admin = self.admin.insecure_clone();
        self.apply_params_by(&admin)
    }

    /// Anyone may apply a scheduled change; `payer` only covers the fee.
    fn apply_params_by(&mut self, payer: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::ApplyParams {}.data(),
            goodfaith::accounts::ApplyParams { pool: self.pool }.to_account_metas(None),
        );
        self.send(ix, payer, &[])
    }

    fn authority_ix(&self, signer: &Keypair, data: Vec<u8>) -> Instruction {
        Instruction::new_with_bytes(
            program_id(),
            &data,
            goodfaith::accounts::UpdatePool {
                authority: signer.pubkey(),
                pool: self.pool,
            }
            .to_account_metas(None),
        )
    }

    fn cancel_params(&mut self, signer: &Keypair) -> Result<(), String> {
        let ix = self.authority_ix(signer, goodfaith::instruction::CancelParams {}.data());
        self.send(ix, signer, &[])
    }

    fn suspend_issuer(&mut self, signer: &Keypair) -> Result<(), String> {
        let ix = self.authority_ix(signer, goodfaith::instruction::SuspendIssuer {}.data());
        self.send(ix, signer, &[])
    }

    /// A token account of the pool mint owned by a fresh key: a valid successor.
    fn successor_token(&mut self) -> Pubkey {
        self.token_for_mint(self.mint)
    }

    fn token_for_mint(&mut self, mint: Pubkey) -> Pubkey {
        let token = Pubkey::new_unique();
        self.svm
            .set_account(
                token,
                Account {
                    lamports: 2_000_000,
                    data: token_account_data(&mint, &Pubkey::new_unique(), 0),
                    owner: TOKEN_PROGRAM,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        token
    }

    fn announce_wind_down(&mut self, signer: &Keypair, successor: Pubkey) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::AnnounceWindDown {}.data(),
            goodfaith::accounts::AnnounceWindDown {
                authority: signer.pubkey(),
                pool: self.pool,
                successor_vault: successor,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer, &[])
    }

    fn cancel_wind_down(&mut self, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::CancelWindDown {}.data(),
            goodfaith::accounts::CancelWindDown {
                authority: signer.pubkey(),
                pool: self.pool,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer, &[])
    }

    fn sweep(&mut self, successor: Pubkey) -> Result<(), String> {
        let admin = self.admin.insecure_clone();
        self.sweep_by(&admin, successor)
    }

    fn sweep_by(&mut self, payer: &Keypair, successor: Pubkey) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::SweepToSuccessor {}.data(),
            goodfaith::accounts::SweepToSuccessor {
                pool: self.pool,
                mint: self.mint,
                vault: self.vault,
                successor_vault: successor,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        );
        self.send(ix, payer, &[])
    }

    /// Full recovery for tests with a zero recovery delay: propose (issuer + recovery authority) then finalize.
    fn rebind_wallet(&mut self, new: &Actor) -> Result<(), String> {
        let issuer = self.issuer.insecure_clone();
        self.rebind_wallet_as(new, &issuer)
    }

    fn rebind_wallet_as(&mut self, new: &Actor, issuer: &Keypair) -> Result<(), String> {
        let recovery = self.recovery.insecure_clone();
        self.propose_rebind_as(new, issuer, &recovery)?;
        self.finalize_rebind(&new.kp.insecure_clone(), new)
    }

    fn propose_rebind(&mut self, new: &Actor) -> Result<(), String> {
        let issuer = self.issuer.insecure_clone();
        let recovery = self.recovery.insecure_clone();
        self.propose_rebind_as(new, &issuer, &recovery)
    }

    fn propose_rebind_as(
        &mut self,
        new: &Actor,
        issuer: &Keypair,
        recovery: &Keypair,
    ) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::ProposeRebind {}.data(),
            goodfaith::accounts::ProposeRebind {
                new_wallet: new.key(),
                issuer: issuer.pubkey(),
                recovery_authority: recovery.pubkey(),
                pool: self.pool,
                person: self.person_addr(&new.person_id),
                gateway_token: new.gateway,
            }
            .to_account_metas(None),
        );
        self.send(ix, &new.kp, &[issuer, recovery])
    }

    /// `signer` is the old wallet or the authority.
    fn veto_rebind(&mut self, signer: &Keypair, person_id: &[u8; 32]) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::VetoRebind {}.data(),
            goodfaith::accounts::VetoRebind {
                signer: signer.pubkey(),
                pool: self.pool,
                person: self.person_addr(person_id),
            }
            .to_account_metas(None),
        );
        self.send(ix, signer, &[])
    }

    fn finalize_rebind(&mut self, payer: &Keypair, new: &Actor) -> Result<(), String> {
        let person = self.person_addr(&new.person_id);
        let old_wallet = self
            .svm
            .get_account(&person)
            .filter(|a| !a.data.is_empty())
            .map_or(Pubkey::new_unique(), |_| self.wallet_of(&person));
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::FinalizeRebind {}.data(),
            goodfaith::accounts::FinalizeRebind {
                payer: payer.pubkey(),
                pool: self.pool,
                person,
                new_wallet: new.key(),
                old_member: self.member_addr(&old_wallet),
                new_member: self.member_addr(&new.key()),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(ix, payer, &[])
    }

    /// Claims a closed loan's leftover escrow for the co-signer's current wallet.
    fn claim_by(&mut self, claimer: &Keypair, id: u64) -> Result<(), String> {
        let accounts = self.claim_accounts(claimer, id);
        self.send_claim(&accounts, claimer)
    }

    fn claim_accounts(&self, claimer: &Keypair, id: u64) -> goodfaith::accounts::ClaimEscrow {
        let loan = self.loan(id);
        let loan_addr = self.loan_addr(id);
        goodfaith::accounts::ClaimEscrow {
            claimer: claimer.pubkey(),
            pool: self.pool,
            mint: self.mint,
            loan: loan_addr,
            escrow: self.escrow_addr(&loan_addr),
            cosigner_person: loan.cosigner_person,
            cosigner_token: self.token_of(&self.wallet_of(&loan.cosigner_person)),
            rent_payer: loan.rent_payer,
            token_program: TOKEN_PROGRAM,
        }
    }

    fn send_claim(
        &mut self,
        accounts: &goodfaith::accounts::ClaimEscrow,
        claimer: &Keypair,
    ) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::ClaimEscrow {}.data(),
            accounts.to_account_metas(None),
        );
        self.send(ix, claimer, &[])
    }

    fn close_expired_request(&mut self, closer: &Keypair, borrower: &Pubkey) -> Result<(), String> {
        let request_addr = self.request_addr(borrower);
        let rent_payer = self.read::<LoanRequest>(&request_addr).rent_payer;
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::CloseExpiredRequest {}.data(),
            goodfaith::accounts::CloseExpiredRequest {
                closer: closer.pubkey(),
                pool: self.pool,
                request: request_addr,
                rent_payer,
            }
            .to_account_metas(None),
        );
        self.send(ix, closer, &[])
    }

    fn pause(&mut self, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::PauseLending {}.data(),
            goodfaith::accounts::PauseLending {
                signer: signer.pubkey(),
                pool: self.pool,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer, &[])
    }

    fn resume(&mut self, signer: &Keypair) -> Result<(), String> {
        let ix = self.authority_ix(signer, goodfaith::instruction::ResumeLending {}.data());
        self.send(ix, signer, &[])
    }

    /// Co-sign passing the co-signer's own open loan (needed when they are borrowing too).
    fn cosign_with_cosigner_loan(
        &mut self,
        payer: &Keypair,
        borrower: &Actor,
        cosigner: &Actor,
    ) -> Result<(), String> {
        let mut accounts = self.cosign_accounts(payer, borrower, cosigner);
        accounts.cosigner_active_loan = self.person(cosigner).active_loan;
        self.send_cosign(&accounts, payer, cosigner)
    }

    fn after_grace(&mut self, id: u64) {
        let loan = self.loan(id);
        self.set_time(loan.due_at + i64::from(loan.grace_days) * DAY + 1);
    }
}

thread_local! {
    static TOKEN_ACCOUNTS: std::cell::RefCell<std::collections::HashMap<Pubkey, Pubkey>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

#[test]
fn init_update_freeze() {
    let mut env = Env::new(2500);
    let pool = env.pool_state();
    assert_eq!(pool.authority, Some(env.admin.pubkey()));
    assert_eq!(pool.mint, env.mint);
    assert_eq!(pool.vault, env.vault);
    assert_eq!(pool.cosigner_escrow_bps, 2500);
    assert_eq!(pool.loan_count, 0);

    let mut p = env.params(5000);
    p.max_loan = 42;
    let admin = env.admin.insecure_clone();
    env.update_pool(&admin, p).unwrap();
    assert_eq!(env.pool_state().max_loan, 42);
    assert_eq!(env.pool_state().cosigner_escrow_bps, 5000);

    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    assert_fails(env.update_pool(&stranger, p), GoodFaithError::Unauthorized);
    assert_fails(env.freeze_pool(&stranger), GoodFaithError::Unauthorized);

    let mut bad = p;
    bad.cosigner_escrow_bps = 10_001;
    assert_fails(env.update_pool(&admin, bad), GoodFaithError::InvalidBps);

    env.freeze_pool(&admin).unwrap();
    assert_eq!(env.pool_state().authority, None);
    assert_fails(env.update_pool(&admin, p), GoodFaithError::Unauthorized);
    assert_fails(env.freeze_pool(&admin), GoodFaithError::Unauthorized);
}

#[test]
fn donate_moves_tokens() {
    let mut env = Env::new(2500);
    let donor = env.actor(5_000);
    env.donate(&donor, 3_000).unwrap();
    assert_eq!(env.balance(&donor.token), 2_000);
    assert_eq!(env.balance(&env.vault), 3_000);
    assert_eq!(env.pool_state().total_donated, 3_000);
    assert_fails(env.donate(&donor, 0), GoodFaithError::AmountZero);
}

#[test]
fn register_with_valid_token() {
    let mut env = Env::new(2500);
    let a = env.actor(0);
    env.register(&a).unwrap();
    let m = env.person(&a);
    assert_eq!(m.wallet, a.key());
    assert_eq!(m.active_loan, None);
    assert_eq!(m.active_guarantees, 0);
    assert_eq!(m.ineligible_until, 0);
}

#[test]
fn register_with_separate_payer() {
    let mut env = Env::new(2500);
    let a = env.actor(0);
    let sponsor = Keypair::new();
    env.svm.airdrop(&sponsor.pubkey(), 1_000_000_000).unwrap();
    let wallet_before = env.svm.get_balance(&a.key());
    let sponsor_before = env.svm.get_balance(&sponsor.pubkey());
    env.register_paid(&a, a.gateway, Some(&sponsor)).unwrap();
    assert_eq!(env.svm.get_balance(&a.key()), wallet_before);
    assert!(env.svm.get_balance(&sponsor.pubkey()) < sponsor_before);
    assert_eq!(env.person(&a).wallet, a.key());
}

#[test]
fn register_rejects_bad_gateway_tokens() {
    let mut env = Env::new(2500);

    let expired = env.actor(0);
    env.set_gateway(
        expired.gateway,
        gateway_data(&expired.key(), &env.network, 0, Some(T0 - 1)),
    );
    assert_fails(env.register(&expired), GoodFaithError::InvalidGatewayToken);

    let future = env.actor(0);
    env.set_gateway(
        future.gateway,
        gateway_data(&future.key(), &env.network, 0, Some(T0 + 100)),
    );
    env.register(&future).unwrap();

    let wrong_network = env.actor(0);
    env.set_gateway(
        wrong_network.gateway,
        gateway_data(&wrong_network.key(), &Pubkey::new_unique(), 0, None),
    );
    assert_fails(
        env.register(&wrong_network),
        GoodFaithError::InvalidGatewayToken,
    );

    let frozen = env.actor(0);
    env.set_gateway(
        frozen.gateway,
        gateway_data(&frozen.key(), &env.network, 1, None),
    );
    assert_fails(env.register(&frozen), GoodFaithError::InvalidGatewayToken);

    let someone_else = env.actor(0);
    let other = env.actor(0);
    assert_fails(
        env.register_with(&someone_else, other.gateway),
        GoodFaithError::InvalidGatewayToken,
    );

    let missing = env.actor(0);
    assert_fails(
        env.register_with(&missing, Pubkey::new_unique()),
        GoodFaithError::InvalidGatewayToken,
    );

    let wrong_owner = env.actor(0);
    env.svm
        .set_account(
            wrong_owner.gateway,
            Account {
                lamports: 1_000_000,
                data: gateway_data(&wrong_owner.key(), &env.network, 0, None),
                owner: system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    assert_fails(
        env.register(&wrong_owner),
        GoodFaithError::InvalidGatewayToken,
    );
}

#[test]
fn open_loan_within_cap() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(1_000);
    let payer = env.actor(0);
    let rent_before = env.svm.get_account(&payer.key()).unwrap().lamports;
    env.open_loan(&payer.kp, &borrower, &cosigner, 1_000, 30)
        .unwrap();
    assert!(env.svm.get_account(&payer.key()).unwrap().lamports < rent_before);

    let loan = env.loan(0);
    assert_eq!(loan.borrower, borrower.key());
    assert_eq!(loan.cosigner, cosigner.key());
    assert_eq!(loan.rent_payer, payer.key());
    assert_eq!(loan.principal, 1_000);
    assert_eq!(loan.escrowed, 250);
    assert_eq!(loan.repaid, 0);
    assert_eq!(loan.opened_at, T0);
    assert_eq!(loan.due_at, T0 + 30 * DAY);
    assert_eq!(loan.status, LoanStatus::Active);

    assert_eq!(env.balance(&borrower.token), 1_000);
    assert_eq!(env.balance(&cosigner.token), 750);
    assert_eq!(env.balance(&env.escrow_addr(&env.loan_addr(0))), 250);
    assert_eq!(env.balance(&env.vault), 9_000);
    assert_eq!(env.pool_state().loan_count, 1);
    assert_eq!(env.pool_state().total_lent, 1_000);
    assert_eq!(env.person(&borrower).active_loan, Some(env.loan_addr(0)));
    assert_eq!(env.person(&cosigner).active_guarantees, 1);
}

#[test]
fn open_loan_limits() {
    let mut env = Env::new(2500);
    env.fund(5_000_000);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(10_000_000);
    let b = borrower.kp.insecure_clone();

    assert_fails(
        env.open_loan(&b, &borrower, &cosigner, 1_000_001, 30),
        GoodFaithError::OverLoanCap,
    );
    assert_fails(
        env.open_loan(&b, &borrower, &cosigner, 1_000, 91),
        GoodFaithError::TermTooLong,
    );
    assert_fails(
        env.open_loan(&b, &borrower, &cosigner, 1_000, 0),
        GoodFaithError::TermTooLong,
    );
    assert_fails(
        env.open_loan(&b, &borrower, &cosigner, 0, 30),
        GoodFaithError::AmountZero,
    );
    // exactly at the limits is fine
    env.open_loan(&b, &borrower, &cosigner, 1_000_000, 90)
        .unwrap();
}

#[test]
fn open_loan_self_cosign() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let a = env.member_actor(1_000);
    let k = a.kp.insecure_clone();
    assert_fails(
        env.open_loan(&k, &a, &a, 100, 30),
        GoodFaithError::SelfCosign,
    );
}

#[test]
fn open_loan_borrower_has_loan() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(1_000);
    let other = env.member_actor(1_000);
    env.open_simple(&borrower, &cosigner, 100);
    let b = borrower.kp.insecure_clone();
    assert_fails(
        env.open_loan(&b, &borrower, &other, 100, 30),
        GoodFaithError::BorrowerHasLoan,
    );
}

#[test]
fn open_loan_cosigner_limit() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let cosigner = env.member_actor(1_000);
    let b1 = env.member_actor(0);
    let b2 = env.member_actor(0);
    let b3 = env.member_actor(0);
    env.open_simple(&b1, &cosigner, 100);
    env.open_simple(&b2, &cosigner, 100);
    let k = b3.kp.insecure_clone();
    assert_fails(
        env.open_loan(&k, &b3, &cosigner, 100, 30),
        GoodFaithError::CosignerLimit,
    );
}

#[test]
fn open_loan_requires_registered_valid_members() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(1_000);
    let b = borrower.kp.insecure_clone();

    // gateway token expires after registration
    env.set_gateway(
        borrower.gateway,
        gateway_data(&borrower.key(), &env.network, 0, Some(T0 + 10)),
    );
    env.set_time(T0 + 11);
    assert_fails(
        env.open_loan(&b, &borrower, &cosigner, 100, 30),
        GoodFaithError::InvalidGatewayToken,
    );
    env.set_gateway(
        borrower.gateway,
        gateway_data(&borrower.key(), &env.network, 2, None),
    );
    assert_fails(
        env.open_loan(&b, &borrower, &cosigner, 100, 30),
        GoodFaithError::InvalidGatewayToken,
    );
    env.set_gateway(
        borrower.gateway,
        gateway_data(&borrower.key(), &env.network, 0, None),
    );
    env.set_gateway(
        cosigner.gateway,
        gateway_data(&cosigner.key(), &Pubkey::new_unique(), 0, None),
    );
    assert_fails(
        env.open_loan(&b, &borrower, &cosigner, 100, 30),
        GoodFaithError::InvalidGatewayToken,
    );

    // not a member: account does not exist
    let outsider = env.actor(0);
    let o = outsider.kp.insecure_clone();
    let cosigner2 = env.member_actor(1_000);
    assert!(env.open_loan(&o, &outsider, &cosigner2, 100, 30).is_err());
}

#[test]
fn open_loan_insufficient_fund() {
    let mut env = Env::new(2500);
    env.fund(500);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(1_000);
    let b = borrower.kp.insecure_clone();
    assert_fails(
        env.open_loan(&b, &borrower, &cosigner, 501, 30),
        GoodFaithError::InsufficientFund,
    );
    env.cancel_request(&b, &borrower.key()).unwrap();
    env.open_loan(&b, &borrower, &cosigner, 500, 30).unwrap();
    assert_eq!(env.balance(&env.vault), 0);
}

#[test]
fn escrow_math() {
    // (amount, bps, expected escrow)
    let cases = [
        (1_001u64, 2500u16, 251u64),
        (1_000, 2500, 250),
        (1, 1, 1),
        (3, 3333, 1),
        (1_000, 0, 0),
        (1_000, 10_000, 1_000),
        (999_999, 9_999, 999_900),
    ];
    for (amount, bps, expected) in cases {
        let mut env = Env::new(bps);
        env.fund(2_000_000);
        let borrower = env.member_actor(0);
        let cosigner = env.member_actor(2_000_000);
        let id = env.open_simple(&borrower, &cosigner, amount);
        assert_eq!(env.loan(id).escrowed, expected, "amount {amount} bps {bps}");
        assert_eq!(env.balance(&env.escrow_addr(&env.loan_addr(id))), expected);
        assert_eq!(env.balance(&cosigner.token), 2_000_000 - expected);
    }
}

#[test]
fn escrow_larger_than_cosigner_balance_fails() {
    let mut env = Env::new(10_000);
    env.fund(1_000);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(10);
    let b = borrower.kp.insecure_clone();
    assert!(env.open_loan(&b, &borrower, &cosigner, 100, 30).is_err());
}

#[test]
fn partial_then_full_repay_by_third_party() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(1_000);
    let payer = env.actor(0);
    let id = {
        env.open_loan(&payer.kp, &borrower, &cosigner, 1_000, 30)
            .unwrap();
        0
    };
    let stranger = env.actor(5_000);
    let borrower_pays = borrower.token;
    // borrower pays 400 out of the 1000 received
    env.repay(&borrower, id, 400).unwrap();
    let loan = env.loan(id);
    assert_eq!(loan.repaid, 400);
    assert_eq!(loan.status, LoanStatus::Active);
    assert_eq!(env.balance(&borrower_pays), 600);
    assert_eq!(env.balance(&env.vault), 9_400);
    assert!(env.person(&borrower).active_loan.is_some());
    assert!(env
        .svm
        .get_account(&env.escrow_addr(&env.loan_addr(id)))
        .is_some());

    // over-payment and zero are rejected
    assert_fails(env.repay(&stranger, id, 601), GoodFaithError::OverRepay);
    assert_fails(env.repay(&stranger, id, 0), GoodFaithError::AmountZero);

    // a third party pays the rest
    let payer_lamports = env.svm.get_account(&payer.key()).unwrap().lamports;
    env.repay(&stranger, id, 600).unwrap();
    let loan = env.loan(id);
    assert_eq!(loan.repaid, 1_000);
    assert_eq!(loan.status, LoanStatus::Repaid);
    assert_eq!(env.balance(&stranger.token), 4_400);
    assert_eq!(env.balance(&env.vault), 10_000);
    assert_eq!(env.pool_state().total_repaid, 1_000);

    // escrow returned, account closed, rent back to whoever paid for it
    assert_eq!(env.balance(&cosigner.token), 1_000);
    assert!(env
        .svm
        .get_account(&env.escrow_addr(&env.loan_addr(id)))
        .is_none());
    assert!(env.svm.get_account(&payer.key()).unwrap().lamports > payer_lamports);
    assert_eq!(env.person(&borrower).active_loan, None);
    assert_eq!(env.person(&cosigner).active_guarantees, 0);

    // the loan is finished; paying again fails
    assert!(env.repay(&stranger, id, 1).is_err());
}

#[test]
fn borrower_can_borrow_again_after_repaying() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(1_000);
    let top_up = env.actor(1_000);
    let id = env.open_simple(&borrower, &cosigner, 500);
    env.repay(&top_up, id, 500).unwrap();
    let id2 = env.open_simple(&borrower, &cosigner, 300);
    assert_eq!(id2, 1);
}

#[test]
fn full_repay_with_no_escrow() {
    let mut env = Env::new(0);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(0);
    let id = env.open_simple(&borrower, &cosigner, 700);
    env.repay(&borrower, id, 700).unwrap();
    assert_eq!(env.loan(id).status, LoanStatus::Repaid);
    assert!(env
        .svm
        .get_account(&env.escrow_addr(&env.loan_addr(id)))
        .is_none());
}

fn setup_default(bps: u16, amount: u64) -> (Env, Actor, Actor, u64) {
    let mut env = Env::new(bps);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(10_000);
    let id = env.open_simple(&borrower, &cosigner, amount);
    (env, borrower, cosigner, id)
}

#[test]
fn default_only_after_grace() {
    let (mut env, borrower, _cosigner, id) = setup_default(2500, 1_000);
    let caller = env.actor(0);
    let due = T0 + 30 * DAY;
    env.set_time(due - 1);
    assert_fails(
        env.mark_default(&caller.kp, id),
        GoodFaithError::NotYetDefaultable,
    );
    env.set_time(due + 7 * DAY);
    assert_fails(
        env.mark_default(&caller.kp, id),
        GoodFaithError::NotYetDefaultable,
    );
    env.set_time(due + 7 * DAY + 1);
    env.mark_default(&caller.kp, id).unwrap();
    assert_eq!(env.loan(id).status, LoanStatus::Defaulted);
    assert!(env.barred(&borrower));
    assert!(env.mark_default(&caller.kp, id).is_err());
}

#[test]
fn default_escrow_fully_covers() {
    let (mut env, borrower, cosigner, id) = setup_default(10_000, 1_000);
    let caller = env.actor(0);
    env.set_time(T0 + 30 * DAY + 7 * DAY + 1);
    env.mark_default(&caller.kp, id).unwrap();
    let pool = env.pool_state();
    assert_eq!(pool.total_recovered, 1_000);
    assert_eq!(pool.total_lost, 0);
    assert_eq!(env.balance(&env.vault), 10_000);
    assert_eq!(env.balance(&cosigner.token), 9_000);
    assert!(env
        .svm
        .get_account(&env.escrow_addr(&env.loan_addr(id)))
        .is_none());
    let (b, c) = (env.person(&borrower), env.person(&cosigner));
    // The escrow made the fund whole, so only the borrower loses access.
    assert!(env.barred(&borrower) && !env.barred(&cosigner));
    assert_eq!(b.active_loan, None);
    assert_eq!(c.active_guarantees, 0);
}

#[test]
fn default_escrow_partially_covers() {
    let (mut env, _borrower, cosigner, id) = setup_default(2500, 1_000);
    let caller = env.actor(0);
    env.set_time(T0 + 30 * DAY + 7 * DAY + 1);
    env.mark_default(&caller.kp, id).unwrap();
    let pool = env.pool_state();
    assert_eq!(pool.total_recovered, 250);
    assert_eq!(pool.total_lost, 750);
    assert_eq!(env.balance(&env.vault), 9_000 + 250);
    assert_eq!(env.balance(&cosigner.token), 10_000 - 250);
}

#[test]
fn default_escrow_exceeds_shortfall() {
    let (mut env, borrower, cosigner, id) = setup_default(10_000, 1_000);
    let helper = env.actor(0);
    env.repay(&borrower, id, 600).unwrap();
    env.set_time(T0 + 30 * DAY + 7 * DAY + 1);
    env.mark_default(&helper.kp, id).unwrap();
    let pool = env.pool_state();
    assert_eq!(pool.total_recovered, 400);
    assert_eq!(pool.total_lost, 0);
    // vault: 10_000 - 1_000 lent + 600 repaid + 400 recovered
    assert_eq!(env.balance(&env.vault), 10_000);
    // cosigner gets back the 600 not needed
    assert_eq!(env.balance(&cosigner.token), 10_000 - 400);
    assert!(env.barred(&borrower));
    assert!(!env.barred(&cosigner));
}

#[test]
fn ineligible_members_cannot_take_part_in_new_loans() {
    let (mut env, borrower, cosigner, id) = setup_default(2500, 1_000);
    let caller = env.actor(0);
    env.set_time(T0 + 30 * DAY + 7 * DAY + 1);
    env.mark_default(&caller.kp, id).unwrap();

    let fresh = env.member_actor(1_000);
    let fresh_borrower = env.member_actor(0);
    let b = borrower.kp.insecure_clone();
    assert_fails(
        env.open_loan(&b, &borrower, &fresh, 100, 30),
        GoodFaithError::Ineligible,
    );
    let f = fresh_borrower.kp.insecure_clone();
    assert_fails(
        env.open_loan(&f, &fresh_borrower, &cosigner, 100, 30),
        GoodFaithError::Ineligible,
    );
    assert_eq!(env.person(&borrower).active_loan, None);
}

#[test]
fn request_creates_pending_request_without_moving_funds() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(1_000);
    let payer = env.actor(0);
    env.request_loan(&payer.kp, &borrower, &cosigner.key(), 1_000, 30)
        .unwrap();
    let req: LoanRequest = env.read(&env.request_addr(&borrower.key()));
    assert_eq!(req.borrower, borrower.key());
    assert_eq!(req.cosigner, cosigner.key());
    assert_eq!(req.amount, 1_000);
    assert_eq!(req.term_days, 30);
    assert_eq!(req.created_at, T0);
    assert_eq!(req.rent_payer, payer.key());
    assert_eq!(env.balance(&env.vault), 10_000);
    assert_eq!(env.balance(&cosigner.token), 1_000);
    assert_eq!(env.pool_state().loan_count, 0);
}

#[test]
fn double_request_fails() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(1_000);
    let other = env.member_actor(1_000);
    let b = borrower.kp.insecure_clone();
    env.request_loan(&b, &borrower, &cosigner.key(), 100, 30)
        .unwrap();
    assert!(env
        .request_loan(&b, &borrower, &other.key(), 200, 30)
        .is_err());
    // the original request is untouched
    let req: LoanRequest = env.read(&env.request_addr(&borrower.key()));
    assert_eq!(req.cosigner, cosigner.key());
}

#[test]
fn only_named_cosigner_can_cosign() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(1_000);
    let wrong = env.member_actor(1_000);
    let b = borrower.kp.insecure_clone();
    env.request_loan(&b, &borrower, &cosigner.key(), 100, 30)
        .unwrap();
    let w = wrong.kp.insecure_clone();
    assert_fails(
        env.cosign_loan(&w, &borrower, &wrong),
        GoodFaithError::Unauthorized,
    );
    env.cosign_loan(&b, &borrower, &cosigner).unwrap();
}

#[test]
fn cosign_uses_cosign_time_and_closes_request() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(1_000);
    let request_payer = env.actor(0);
    let cosign_payer = env.actor(0);
    env.request_loan(&request_payer.kp, &borrower, &cosigner.key(), 1_000, 30)
        .unwrap();
    let before = env.svm.get_account(&request_payer.key()).unwrap().lamports;
    env.set_time(T0 + 3_600);
    env.cosign_loan(&cosign_payer.kp, &borrower, &cosigner)
        .unwrap();

    let loan = env.loan(0);
    assert_eq!(loan.opened_at, T0 + 3_600);
    assert_eq!(loan.due_at, T0 + 3_600 + 30 * DAY);
    assert_eq!(loan.rent_payer, cosign_payer.key());
    assert_eq!(loan.escrowed, 250);
    assert!(env
        .svm
        .get_account(&env.request_addr(&borrower.key()))
        .is_none());
    assert!(env.svm.get_account(&request_payer.key()).unwrap().lamports > before);
    assert_eq!(env.balance(&borrower.token), 1_000);
}

#[test]
fn cancel_by_borrower_or_cosigner_only() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(1_000);
    let stranger = env.actor(0);
    let payer = env.actor(0);
    env.request_loan(&payer.kp, &borrower, &cosigner.key(), 100, 30)
        .unwrap();
    assert_fails(
        env.cancel_request(&stranger.kp, &borrower.key()),
        GoodFaithError::Unauthorized,
    );
    let before = env.svm.get_account(&payer.key()).unwrap().lamports;
    env.cancel_request(&cosigner.kp, &borrower.key()).unwrap();
    assert!(env
        .svm
        .get_account(&env.request_addr(&borrower.key()))
        .is_none());
    assert!(env.svm.get_account(&payer.key()).unwrap().lamports > before);

    // borrower can cancel too, and may ask again afterwards
    env.request_loan(&payer.kp, &borrower, &cosigner.key(), 100, 30)
        .unwrap();
    env.cancel_request(&borrower.kp, &borrower.key()).unwrap();
    env.request_loan(&payer.kp, &borrower, &cosigner.key(), 100, 30)
        .unwrap();
    env.cosign_loan(&payer.kp, &borrower, &cosigner).unwrap();
}

#[test]
fn stale_request_after_borrower_became_ineligible() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    env.tune(|p| p.request_ttl_seconds = 90 * DAY);
    // `risky` guarantees a loan that will default, and also asks for one.
    let first_borrower = env.tracked_actor(0);
    let risky = env.tracked_actor(1_000);
    let helper = env.member_actor(1_000);
    let id = env.open_simple(&first_borrower, &risky, 500);
    env.request_loan(&risky.kp, &risky, &helper.key(), 100, 30)
        .unwrap();

    let caller = env.actor(0);
    env.set_time(T0 + 30 * DAY + 7 * DAY + 1);
    env.mark_default(&caller.kp, id).unwrap();
    assert!(env.barred(&risky));

    let h = helper.kp.insecure_clone();
    assert_fails(
        env.cosign_loan(&h, &risky, &helper),
        GoodFaithError::Ineligible,
    );
    // the request can still be cleaned up
    env.cancel_request(&risky.kp, &risky.key()).unwrap();
}

#[test]
fn stale_request_after_borrower_got_a_loan() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.member_actor(0);
    let c1 = env.member_actor(1_000);
    let c2 = env.member_actor(1_000);
    let b = borrower.kp.insecure_clone();
    env.request_loan(&b, &borrower, &c1.key(), 100, 30).unwrap();
    env.cosign_loan(&b, &borrower, &c1).unwrap();
    // request PDA is free again; a new one for the same borrower is rejected by the rule
    assert_fails(
        env.request_loan(&b, &borrower, &c2.key(), 100, 30),
        GoodFaithError::BorrowerHasLoan,
    );
}

#[test]
fn cosign_rechecks_vault_and_gateway() {
    let mut env = Env::new(2500);
    env.fund(100);
    let borrower = env.member_actor(0);
    let cosigner = env.member_actor(1_000);
    let b = borrower.kp.insecure_clone();
    env.request_loan(&b, &borrower, &cosigner.key(), 500, 30)
        .unwrap();
    assert_fails(
        env.cosign_loan(&b, &borrower, &cosigner),
        GoodFaithError::InsufficientFund,
    );
    env.fund(1_000);
    env.set_gateway(
        borrower.gateway,
        gateway_data(&borrower.key(), &env.network, 0, Some(T0 + 10)),
    );
    env.set_time(T0 + 11);
    assert_fails(
        env.cosign_loan(&b, &borrower, &cosigner),
        GoodFaithError::InvalidGatewayToken,
    );
}

// ---- audit regression tests ----

#[test]
fn audit_pool_rejects_token_2022_mints() {
    let mut env = Env::new(2500);
    let mint = Pubkey::new_unique();
    env.svm
        .set_account(
            mint,
            Account {
                lamports: 1_000_000_000,
                data: mint_data(),
                owner: anchor_spl::token_2022::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let (pool, _) = Pubkey::find_program_address(&[b"pool", mint.as_ref()], &program_id());
    let (vault, _) = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &program_id());
    for token_program in [anchor_spl::token_2022::ID, TOKEN_PROGRAM] {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::InitializePool {
                params: env.params(2500),
            }
            .data(),
            goodfaith::accounts::InitializePool {
                payer: env.admin.pubkey(),
                mint,
                pool,
                vault,
                token_program,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let admin = env.admin.insecure_clone();
        assert!(env.send(ix, &admin, &[]).is_err());
        assert!(env.svm.get_account(&pool).is_none());
    }
}

#[test]
fn audit_cosign_binds_to_approved_terms() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(10_000);
    let b = borrower.kp.insecure_clone();
    env.request_loan(&b, &borrower, &cosigner.key(), 900, 30)
        .unwrap();
    // Cosigner approved 100 over 30 days; the request now says 900.
    assert_fails(
        env.cosign_loan_with(&b, &borrower, &cosigner, (100, 30, u64::MAX)),
        GoodFaithError::RequestMismatch,
    );
    assert_fails(
        env.cosign_loan_with(&b, &borrower, &cosigner, (900, 90, u64::MAX)),
        GoodFaithError::RequestMismatch,
    );
    // Escrow for 900 at 25% is 225.
    assert_fails(
        env.cosign_loan_with(&b, &borrower, &cosigner, (900, 30, 224)),
        GoodFaithError::EscrowTooHigh,
    );
    // Pool raises the escrow rate after the cosigner looked.
    let admin = env.admin.insecure_clone();
    env.update_pool(&admin, env.params(10_000)).unwrap();
    assert_fails(
        env.cosign_loan_with(&b, &borrower, &cosigner, (900, 30, 225)),
        GoodFaithError::EscrowTooHigh,
    );
    env.update_pool(&admin, env.params(2500)).unwrap();
    env.cosign_loan_with(&b, &borrower, &cosigner, (900, 30, 225))
        .unwrap();
    assert_eq!(env.loan(0).escrowed, 225);
}

#[test]
fn audit_grace_period_is_fixed_at_open() {
    let (mut env, _borrower, _cosigner, id) = setup_default(2500, 1_000);
    assert_eq!(env.loan(id).grace_days, 7);
    let admin = env.admin.insecure_clone();
    let mut p = env.params(2500);
    p.grace_days = 0;
    env.update_pool(&admin, p).unwrap();
    let caller = env.actor(0);
    env.set_time(T0 + 30 * DAY + 1);
    assert_fails(
        env.mark_default(&caller.kp, id),
        GoodFaithError::NotYetDefaultable,
    );
    env.set_time(T0 + 37 * DAY + 1);
    env.mark_default(&caller.kp, id).unwrap();
}

#[test]
fn audit_lowering_limits_mid_loan_keeps_loan_repayable() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(10_000);
    let id = env.open_simple(&borrower, &cosigner, 1_000);
    let admin = env.admin.insecure_clone();
    let mut p = env.params(0);
    p.max_loan = 1;
    p.max_term_days = 1;
    p.max_guarantees_per_member = 1;
    env.update_pool(&admin, p).unwrap();
    env.repay(&cosigner, id, 1_000).unwrap();
    assert_eq!(env.loan(id).status, LoanStatus::Repaid);
    // Paid 1_000 back, got the 250 escrow returned.
    assert_eq!(env.balance(&cosigner.token), 9_000);
}

#[test]
fn audit_escrow_topup_and_prefunded_pdas_do_not_block() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(10_000);
    // Pre-fund the next loan and escrow PDAs with lamports.
    let loan = env.loan_addr(0);
    let escrow = env.escrow_addr(&loan);
    for a in [loan, escrow] {
        env.svm
            .set_account(
                a,
                Account {
                    lamports: 5_000_000,
                    data: vec![],
                    owner: system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
    let id = env.open_simple(&borrower, &cosigner, 1_000);
    // A stranger sends extra tokens straight to the escrow.
    let mut acc = env.svm.get_account(&escrow).unwrap();
    let extra = u64::from_le_bytes(acc.data[64..72].try_into().unwrap()) + 77;
    acc.data[64..72].copy_from_slice(&extra.to_le_bytes());
    env.svm.set_account(escrow, acc).unwrap();
    env.repay(&cosigner, id, 1_000).unwrap();
    assert_eq!(env.loan(id).status, LoanStatus::Repaid);
    assert!(env.svm.get_account(&escrow).is_none());
}

#[test]
fn audit_frozen_pool_cannot_be_updated_or_refrozen() {
    let mut env = Env::new(2500);
    let admin = env.admin.insecure_clone();
    env.freeze_pool(&admin).unwrap();
    assert_fails(
        env.update_pool(&admin, env.params(1)),
        GoodFaithError::Unauthorized,
    );
    assert_fails(env.freeze_pool(&admin), GoodFaithError::Unauthorized);
    assert!(env.pool_state().authority.is_none());
}

#[test]
fn audit_cannot_substitute_vault_escrow_or_mint() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(10_000);
    let id = env.open_simple(&borrower, &cosigner, 1_000);
    // Repay naming the borrower's own token account as the vault.
    let loan = env.loan(id);
    let loan_addr = env.loan_addr(id);
    let mut accounts = goodfaith::accounts::Repay {
        payer: cosigner.key(),
        pool: env.pool,
        mint: env.mint,
        vault: env.vault,
        loan: loan_addr,
        escrow: env.escrow_addr(&loan_addr),
        payer_token: cosigner.token,
        borrower_person: loan.borrower_person,
        cosigner_person: loan.cosigner_person,
        rent_payer: loan.rent_payer,
        token_program: TOKEN_PROGRAM,
    };
    for fake in [borrower.token, cosigner.token] {
        accounts.vault = fake;
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::Repay { amount: 10 }.data(),
            accounts.to_account_metas(None),
        );
        assert!(env.send(ix, &cosigner.kp, &[]).is_err());
    }
    accounts.vault = env.vault;
    accounts.escrow = cosigner.token;
    let ix = Instruction::new_with_bytes(
        program_id(),
        &goodfaith::instruction::Repay { amount: 10 }.data(),
        accounts.to_account_metas(None),
    );
    assert!(env.send(ix, &cosigner.kp, &[]).is_err());
    assert_eq!(env.loan(id).repaid, 0);
}

#[test]
fn update_rejects_bad_params() {
    let mut env = Env::new(2500);
    let admin = env.admin.insecure_clone();
    let cases: [fn(&mut PoolParams); 5] = [
        |p| p.max_loan = 0,
        |p| p.max_term_days = 0,
        |p| p.max_guarantees_per_member = 0,
        |p| p.max_term_days = goodfaith::MAX_TERM_DAYS + 1,
        |p| p.grace_days = goodfaith::MAX_GRACE_DAYS + 1,
    ];
    for tweak in cases {
        let mut bad = env.params(100);
        tweak(&mut bad);
        assert_fails(env.update_pool(&admin, bad), GoodFaithError::InvalidParams);
    }
    let mut edge = env.params(100);
    edge.max_term_days = goodfaith::MAX_TERM_DAYS;
    edge.grace_days = goodfaith::MAX_GRACE_DAYS;
    env.update_pool(&admin, edge).unwrap();
    assert_eq!(env.pool_state().grace_days, goodfaith::MAX_GRACE_DAYS);
}

#[test]
fn initialize_rejects_bad_params() {
    let mut env = Env::new(2500);
    let mut bad = env.params(2500);
    bad.max_loan = 0;
    let (pool, res) = env.init_pool_on_new_mint(bad);
    assert_fails(res, GoodFaithError::InvalidParams);
    assert!(env.svm.get_account(&pool).is_none());
    let (pool, res) = env.init_pool_on_new_mint(env.params(10_001));
    assert_fails(res, GoodFaithError::InvalidBps);
    assert!(env.svm.get_account(&pool).is_none());
    let (pool, res) = env.init_pool_on_new_mint(env.params(2500));
    res.unwrap();
    let p: Pool = env.read(&pool);
    assert_eq!(p.authority, Some(env.admin.pubkey()));
    assert_eq!(p.pending_authority, None);
}

#[test]
fn initialize_twice_and_register_twice_fail() {
    let mut env = Env::new(2500);
    let before = env.pool_state();
    assert_fails(env.initialize_pool(env.params(100)), 0u32);
    assert_eq!(env.pool_state().authority, before.authority);
    let a = env.member_actor(0);
    assert_fails(env.register(&a), 0u32);
}

#[test]
fn authority_handover_is_two_step() {
    let mut env = Env::new(2500);
    let admin = env.admin.insecure_clone();
    let next = Keypair::new();
    env.svm.airdrop(&next.pubkey(), 1_000_000_000).unwrap();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

    assert_fails(
        env.propose_authority(&stranger, next.pubkey()),
        GoodFaithError::Unauthorized,
    );
    assert_fails(
        env.propose_authority(&admin, Pubkey::default()),
        GoodFaithError::InvalidParams,
    );
    assert_fails(
        env.propose_authority(&admin, admin.pubkey()),
        GoodFaithError::InvalidParams,
    );
    assert_fails(
        env.cancel_authority_proposal(&admin),
        GoodFaithError::InvalidParams,
    );
    assert_fails(env.accept_authority(&next), GoodFaithError::Unauthorized);

    env.propose_authority(&admin, next.pubkey()).unwrap();
    assert_eq!(env.pool_state().pending_authority, Some(next.pubkey()));
    assert_eq!(env.pool_state().authority, Some(admin.pubkey()));
    // Still the admin's pool until the new key accepts.
    env.update_pool(&admin, env.params(3000)).unwrap();
    assert_fails(
        env.accept_authority(&stranger),
        GoodFaithError::Unauthorized,
    );

    env.accept_authority(&next).unwrap();
    let p = env.pool_state();
    assert_eq!(p.authority, Some(next.pubkey()));
    assert_eq!(p.pending_authority, None);
    assert_fails(
        env.update_pool(&admin, env.params(100)),
        GoodFaithError::Unauthorized,
    );
    env.update_pool(&next, env.params(100)).unwrap();
    assert_fails(env.accept_authority(&next), GoodFaithError::Unauthorized);

    // A proposal can be withdrawn, after which the named key can no longer accept.
    env.propose_authority(&next, admin.pubkey()).unwrap();
    env.cancel_authority_proposal(&next).unwrap();
    assert_eq!(env.pool_state().pending_authority, None);
    assert_fails(env.accept_authority(&admin), GoodFaithError::Unauthorized);
}

#[test]
fn freeze_clears_pending_handover() {
    let mut env = Env::new(2500);
    let admin = env.admin.insecure_clone();
    let next = Keypair::new();
    env.svm.airdrop(&next.pubkey(), 1_000_000_000).unwrap();
    env.propose_authority(&admin, next.pubkey()).unwrap();
    env.freeze_pool(&admin).unwrap();
    let p = env.pool_state();
    assert_eq!(p.authority, None);
    assert_eq!(p.pending_authority, None);
    assert_fails(env.accept_authority(&next), GoodFaithError::Unauthorized);
    assert_fails(
        env.propose_authority(&admin, next.pubkey()),
        GoodFaithError::Unauthorized,
    );
}

#[test]
fn member_from_another_pool_is_rejected() {
    use anchor_lang::error::ErrorCode;
    let mut env = Env::new(2500);
    env.fund(10_000);
    let (pool_b, res) = env.init_pool_on_new_mint(env.params(2500));
    res.unwrap();
    let borrower = env.actor(0);
    env.register_in_pool(&borrower, pool_b).unwrap();
    let cosigner = env.member_actor(1_000);
    let person_b = Pubkey::find_program_address(
        &[b"person", pool_b.as_ref(), borrower.person_id.as_ref()],
        &program_id(),
    )
    .0;
    let ix = Instruction::new_with_bytes(
        program_id(),
        &goodfaith::instruction::RequestLoan {
            amount: 100,
            term_days: 10,
            cosigner: cosigner.key(),
        }
        .data(),
        goodfaith::accounts::RequestLoan {
            payer: borrower.key(),
            borrower: borrower.key(),
            pool: env.pool,
            mint: env.mint,
            borrower_person: person_b,
            cosigner_member: env.member_addr(&cosigner.key()),
            borrower_gateway_token: borrower.gateway,
            request: env.request_addr(&borrower.key()),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let res = env.send(ix, &borrower.kp, &[]);
    assert_fails(res, ErrorCode::ConstraintSeeds);
}

#[test]
fn finished_loans_are_not_active() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(10_000);
    let stranger = env.tracked_actor(5_000);
    let id = env.open_simple(&borrower, &cosigner, 1_000);
    env.repay(&stranger, id, 1_000).unwrap();
    // The escrow is closed, so a plain repeat fails on the missing account; naming a live
    // token account instead reaches the status check.
    let mut accounts = env.repay_accounts(&stranger, id);
    accounts.escrow = borrower.token;
    assert_fails(
        env.send_repay(&accounts, &stranger, 1),
        GoodFaithError::LoanNotActive,
    );

    let id2 = env.open_simple(&borrower, &cosigner, 1_000);
    env.set_time(T0 + 30 * DAY + 7 * DAY + 1);
    env.mark_default(&stranger.kp, id2).unwrap();
    let mut accounts = env.default_accounts(&stranger.kp, id2);
    accounts.escrow = borrower.token;
    assert_fails(
        env.send_default(&accounts, &stranger.kp),
        GoodFaithError::LoanNotActive,
    );
    let mut repay_accounts = env.repay_accounts(&stranger, id2);
    repay_accounts.escrow = borrower.token;
    assert_fails(
        env.send_repay(&repay_accounts, &stranger, 1),
        GoodFaithError::LoanNotActive,
    );
}

#[test]
fn substituted_accounts_are_rejected() {
    use anchor_lang::error::ErrorCode;
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(10_000);
    let stranger = env.tracked_actor(5_000);
    let other = env.actor(100);

    // cosign: wrong rent recipient for the request, wrong borrower token account
    let payer = borrower.kp.insecure_clone();
    env.request_loan(&payer, &borrower, &cosigner.key(), 1_000, 30)
        .unwrap();
    let mut accounts = env.cosign_accounts(&payer, &borrower, &cosigner);
    accounts.request_rent_payer = stranger.key();
    assert_fails(
        env.send_cosign(&accounts, &payer, &cosigner),
        ErrorCode::ConstraintAddress,
    );
    accounts = env.cosign_accounts(&payer, &borrower, &cosigner);
    accounts.borrower_token = other.token;
    assert_fails(
        env.send_cosign(&accounts, &payer, &cosigner),
        ErrorCode::ConstraintTokenOwner,
    );
    let accounts = env.cosign_accounts(&payer, &borrower, &cosigner);
    env.send_cosign(&accounts, &payer, &cosigner).unwrap();
    let id = 0;

    // repay: wrong rent recipient, wrong co-signer token account
    let mut accounts = env.repay_accounts(&stranger, id);
    accounts.rent_payer = stranger.key();
    assert_fails(
        env.send_repay(&accounts, &stranger, 10),
        ErrorCode::ConstraintAddress,
    );

    // mark_default: same substitution (900 repaid first, so 150 of escrow is left to claim afterwards)
    env.repay_only(&stranger, id, 900).unwrap();
    env.set_time(T0 + 30 * DAY + 7 * DAY + 1);
    let mut accounts = env.default_accounts(&stranger.kp, id);
    accounts.rent_payer = stranger.key();
    assert_fails(
        env.send_default(&accounts, &stranger.kp),
        ErrorCode::ConstraintAddress,
    );
    env.mark_default_only(&stranger.kp, id).unwrap();

    // claim: wrong co-signer token account, wrong rent recipient
    let mut claim = env.claim_accounts(&stranger.kp, id);
    claim.cosigner_token = other.token;
    assert_fails(
        env.send_claim(&claim, &stranger.kp),
        ErrorCode::ConstraintTokenOwner,
    );
    claim = env.claim_accounts(&stranger.kp, id);
    claim.rent_payer = stranger.key();
    assert_fails(
        env.send_claim(&claim, &stranger.kp),
        ErrorCode::ConstraintAddress,
    );

    // donate: a token account that is not the vault
    let donor = env.actor(1_000);
    let ix = Instruction::new_with_bytes(
        program_id(),
        &goodfaith::instruction::Donate { amount: 10 }.data(),
        goodfaith::accounts::Donate {
            donor: donor.key(),
            pool: env.pool,
            mint: env.mint,
            vault: other.token,
            donor_token: donor.token,
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    );
    let res = env.send(ix, &donor.kp, &[]);
    assert_fails(res, ErrorCode::ConstraintAddress);
    assert_eq!(env.loan(id).repaid, 900);
}

#[test]
fn default_with_zero_escrow_and_repay_after_grace() {
    let (mut env, borrower, cosigner, id) = setup_default(0, 1_000);
    let caller = env.actor(0);
    env.set_time(T0 + 30 * DAY + 7 * DAY + 1);
    let rent_payer = env.loan(id).rent_payer;
    let before = env.svm.get_account(&rent_payer).unwrap().lamports;
    env.mark_default(&caller.kp, id).unwrap();
    let p = env.pool_state();
    assert_eq!(p.total_recovered, 0);
    assert_eq!(p.total_lost, 1_000);
    assert!(env
        .svm
        .get_account(&env.escrow_addr(&env.loan_addr(id)))
        .is_none());
    assert!(env.svm.get_account(&rent_payer).unwrap().lamports > before);
    assert!(env.barred(&borrower) && env.barred(&cosigner));

    // Repaying late, but before anyone marks the default, still settles the loan: it is recorded as late,
    // the co-signer gets the escrow back, and with a zero late ban nobody is barred.
    let (mut env, borrower, cosigner, id) = setup_default(2500, 1_000);
    let payer = env.tracked_actor(5_000);
    env.set_time(T0 + 30 * DAY + 7 * DAY + 100 * DAY);
    env.repay(&payer, id, 1_000).unwrap();
    assert_eq!(env.loan(id).status, LoanStatus::RepaidLate);
    assert!(!env.barred(&borrower) && !env.barred(&cosigner));
    assert_eq!(env.balance(&cosigner.token), 10_000);
}

#[test]
fn malformed_gateway_data_is_rejected() {
    let mut env = Env::new(2500);
    let a = env.actor(0);
    let good = gateway_data(&a.key(), &env.network, 0, Some(T0 + DAY));
    let mut truncated_expiry = good.clone();
    truncated_expiry.truncate(good.len() - 3);
    let mut parent_tag = good.clone();
    parent_tag[1] = 2;
    let mut identity_tag = good.clone();
    identity_tag[34] = 2;
    let mut expiry_tag = good.clone();
    expiry_tag[100] = 2;
    for (name, bytes) in [
        ("empty", vec![]),
        ("short", good[..10].to_vec()),
        ("parent tag 2", parent_tag),
        ("identity tag 2", identity_tag),
        ("expiry tag 2", expiry_tag),
        ("truncated expiry", truncated_expiry),
    ] {
        let gw = Pubkey::new_unique();
        env.set_gateway(gw, bytes);
        let res = env.register_with(&a, gw);
        assert!(res.is_err(), "{name} should be rejected");
        assert_fails(res, GoodFaithError::InvalidGatewayToken);
    }
    env.register(&a).unwrap();
}

// ---- property tests (random instruction sequences over LiteSVM) ----

#[test]
fn register_binds_wallet_to_person_and_needs_the_issuer() {
    let mut env = Env::new(2500);
    let a = env.actor(0);
    let impostor = Keypair::new();
    env.svm.airdrop(&impostor.pubkey(), 1_000_000_000).unwrap();
    assert_fails(env.register_as(&a, &impostor), GoodFaithError::Unauthorized);
    env.register(&a).unwrap();
    let person = env.person(&a);
    assert_eq!(person.person_id, a.person_id);
    assert_eq!(person.wallet, a.key());
    let member = env.member_of(&a);
    assert_eq!(member.wallet, a.key());
    assert_eq!(member.person, env.person_addr(&a.person_id));
    assert!(!member.retired);
    assert_eq!(env.pool_state().issuer, env.issuer.pubkey());
}

#[test]
fn one_person_one_wallet_in_both_directions() {
    let mut env = Env::new(2500);
    let a = env.member_actor(0);
    // Same person, second wallet: the Person account already exists.
    let second = env.new_wallet_for(&a, 0);
    assert!(env.register(&second).is_err());
    // Same wallet, different person: the Member account already exists.
    let mut again = env.actor(0);
    again.kp = a.kp.insecure_clone();
    again.gateway = a.gateway;
    assert!(env.register(&again).is_err());
    assert_eq!(env.person(&a).wallet, a.key());
}

#[test]
fn rebind_moves_the_person_and_their_open_loan_to_a_new_wallet() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(10_000);
    let id = env.open_simple(&borrower, &cosigner, 1_000);

    let borrower2 = env.new_wallet_for(&borrower, 0);
    let cosigner2 = env.new_wallet_for(&cosigner, 0);
    env.rebind_wallet(&borrower2).unwrap();
    env.rebind_wallet(&cosigner2).unwrap();
    assert_eq!(env.person(&borrower).wallet, borrower2.key());
    assert!(env.member_of(&borrower).retired);
    assert!(!env.member_of(&borrower2).retired);
    assert_eq!(
        env.member_of(&borrower2).person,
        env.person_addr(&borrower.person_id)
    );
    // The loan still belongs to the person: the new wallet cannot borrow again.
    let b2 = borrower2.kp.insecure_clone();
    assert_fails(
        env.request_loan(&b2, &borrower2, &cosigner2.key(), 100, 30),
        GoodFaithError::BorrowerHasLoan,
    );
    // Retired wallets are out: as borrower (no longer the person's wallet) and as co-signer.
    let b = borrower.kp.insecure_clone();
    assert_fails(
        env.request_loan(&b, &borrower, &cosigner2.key(), 100, 30),
        GoodFaithError::WalletNotBound,
    );
    let fresh = env.member_actor(0);
    let f = fresh.kp.insecure_clone();
    assert_fails(
        env.request_loan(&f, &fresh, &cosigner.key(), 100, 30),
        GoodFaithError::WalletRetired,
    );
    // Repayment by a third party returns the escrow to the co-signer's new wallet.
    let payer = env.tracked_actor(5_000);
    env.repay(&payer, id, 1_000).unwrap();
    assert_eq!(env.balance(&cosigner2.token), 250);
    assert_eq!(env.balance(&cosigner.token), 10_000 - 250);
    assert_eq!(env.person(&borrower).active_loan, None);
    assert_eq!(env.person(&cosigner).active_guarantees, 0);
    // Both people can take part again, from their new wallets.
    env.open_loan(&b2, &borrower2, &cosigner2, 500, 30).unwrap();
    assert_eq!(env.pool_state().active_loans, 1);
}

#[test]
fn rebind_default_pays_the_new_wallet_and_follows_the_policy() {
    let mut env = Env::new(10_000);
    env.fund(10_000);
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(10_000);
    let id = env.open_simple(&borrower, &cosigner, 1_000);
    env.repay(&borrower, id, 400).unwrap();
    let cosigner2 = env.new_wallet_for(&cosigner, 0);
    env.rebind_wallet(&cosigner2).unwrap();
    env.after_grace(id);
    let caller = env.actor(0);
    env.mark_default(&caller.kp, id).unwrap();
    // 600 owed came from the 1_000 escrow; the 400 left goes to the current wallet.
    assert_eq!(env.balance(&cosigner2.token), 400);
    assert_eq!(env.balance(&cosigner.token), 9_000);
    assert_eq!(env.pool_state().total_lost, 0);
    assert!(env.barred(&borrower));
    assert!(!env.barred(&cosigner));
    assert_eq!(env.pool_state().active_loans, 0);
}

#[test]
fn rebind_rejections() {
    let mut env = Env::new(2500);
    let a = env.member_actor(0);
    let other = env.member_actor(0);
    let impostor = Keypair::new();
    env.svm.airdrop(&impostor.pubkey(), 1_000_000_000).unwrap();

    let new = env.new_wallet_for(&a, 0);
    assert_fails(
        env.rebind_wallet_as(&new, &impostor),
        GoodFaithError::Unauthorized,
    );

    // A wallet that already belongs to someone cannot be bound to a second person.
    let mut taken = env.new_wallet_for(&a, 0);
    taken.kp = other.kp.insecure_clone();
    taken.gateway = other.gateway;
    assert!(env.rebind_wallet(&taken).is_err());
    // The proposal went through (the Member clash is only found at finalisation); the old wallet withdraws it.
    env.veto_rebind(&a.kp.insecure_clone(), &a.person_id)
        .unwrap();

    // The new wallet needs its own valid gateway token.
    let mut untokened = env.new_wallet_for(&a, 0);
    untokened.gateway = Pubkey::new_unique();
    assert_fails(
        env.rebind_wallet(&untokened),
        GoodFaithError::InvalidGatewayToken,
    );

    // Unknown person.
    let nobody = env.actor(0);
    assert!(env.rebind_wallet(&nobody).is_err());

    env.rebind_wallet(&new).unwrap();
    // The retired wallet cannot be re-bound: its Member stays retired for good.
    let mut back = env.new_wallet_for(&a, 0);
    back.kp = a.kp.insecure_clone();
    back.gateway = a.gateway;
    assert!(env.rebind_wallet(&back).is_err());
    assert!(env.member_of(&a).retired);
    assert_eq!(env.person(&a).wallet, new.key());
    // Only the current wallet (or the authority) can withdraw the leftover proposal.
    assert_fails(
        env.veto_rebind(&a.kp.insecure_clone(), &a.person_id),
        GoodFaithError::Unauthorized,
    );
    env.veto_rebind(&new.kp.insecure_clone(), &a.person_id)
        .unwrap();
}

#[test]
fn covered_default_leaves_the_cosigner_in_good_standing() {
    let (mut env, borrower, cosigner, id) = setup_default(10_000, 1_000);
    env.after_grace(id);
    let caller = env.actor(0);
    env.mark_default(&caller.kp, id).unwrap();
    assert!(!env.barred(&cosigner));
    // ... and they can co-sign again, while the borrower cannot borrow.
    let next = env.member_actor(0);
    let n = next.kp.insecure_clone();
    env.open_loan(&n, &next, &cosigner, 500, 30).unwrap();
    let b = borrower.kp.insecure_clone();
    assert_fails(
        env.open_loan(&b, &borrower, &cosigner, 100, 30),
        GoodFaithError::Ineligible,
    );
}

#[test]
fn timelock_lifecycle() {
    let mut env = Env::with_timelock(2500, 3 * DAY);
    let admin = env.admin.insecure_clone();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    assert_eq!(env.pool_state().timelock_seconds, 3 * DAY);

    assert_fails(env.apply_params(), GoodFaithError::NothingPending);
    assert_fails(env.cancel_params(&admin), GoodFaithError::NothingPending);

    let mut p = env.params(5000);
    p.max_loan = 42;
    assert_fails(
        env.schedule_params(&stranger, p),
        GoodFaithError::Unauthorized,
    );
    env.schedule_params(&admin, p).unwrap();
    let pool = env.pool_state();
    assert_eq!(pool.max_loan, 1_000_000, "nothing changes at scheduling");
    assert_eq!(pool.pending_params, Some(p));
    assert_eq!(pool.params_effective_at, T0 + 3 * DAY);

    env.set_time(T0 + 3 * DAY - 1);
    assert_fails(env.apply_params(), GoodFaithError::TimelockNotElapsed);
    assert_fails(env.cancel_params(&stranger), GoodFaithError::Unauthorized);
    env.set_time(T0 + 3 * DAY);
    env.apply_params_by(&stranger).unwrap();
    let pool = env.pool_state();
    assert_eq!(pool.max_loan, 42);
    assert_eq!(pool.cosigner_escrow_bps, 5000);
    assert_eq!(pool.pending_params, None);
    assert_fails(env.apply_params(), GoodFaithError::NothingPending);

    // Rescheduling replaces the pending change; cancelling drops it.
    let mut q = p;
    q.max_loan = 7;
    env.schedule_params(&admin, q).unwrap();
    q.max_loan = 8;
    env.set_time(T0 + 4 * DAY);
    env.schedule_params(&admin, q).unwrap();
    assert_eq!(env.pool_state().pending_params, Some(q));
    assert_eq!(env.pool_state().params_effective_at, T0 + 7 * DAY);
    env.cancel_params(&admin).unwrap();
    assert_eq!(env.pool_state().pending_params, None);
    assert_eq!(env.pool_state().max_loan, 42);

    // Lowering the timelock itself waits the old delay, and it can never go below the minimum.
    let mut fast = q;
    fast.timelock_seconds = 0;
    assert_fails(
        env.schedule_params(&admin, fast),
        GoodFaithError::TimelockBelowMinimum,
    );
    fast.timelock_seconds = goodfaith::MIN_TIMELOCK_SECONDS;
    env.schedule_params(&admin, fast).unwrap();
    assert_fails(env.apply_params(), GoodFaithError::TimelockNotElapsed);
    env.set_time(T0 + 7 * DAY);
    env.apply_params().unwrap();
    assert_eq!(
        env.pool_state().timelock_seconds,
        goodfaith::MIN_TIMELOCK_SECONDS
    );
    fast.max_loan = 9;
    env.schedule_params(&admin, fast).unwrap();
    env.set_time(T0 + 9 * DAY);
    env.apply_params().unwrap();
    assert_eq!(env.pool_state().max_loan, 9);

    // Bounds: the timelock has a ceiling and cannot be negative.
    let mut too_long = fast;
    too_long.timelock_seconds = goodfaith::MAX_TIMELOCK_SECONDS + 1;
    assert_fails(
        env.schedule_params(&admin, too_long),
        GoodFaithError::InvalidParams,
    );
    let mut negative = fast;
    negative.timelock_seconds = -1;
    assert_fails(
        env.schedule_params(&admin, negative),
        GoodFaithError::InvalidParams,
    );
    let mut max = fast;
    max.timelock_seconds = goodfaith::MAX_TIMELOCK_SECONDS;
    env.schedule_params(&admin, max).unwrap();
    env.set_time(T0 + 11 * DAY);
    env.apply_params().unwrap();

    // Freezing discards a scheduled change.
    let mut pending = max;
    pending.max_loan = 1;
    env.schedule_params(&admin, pending).unwrap();
    env.freeze_pool(&admin).unwrap();
    assert_eq!(env.pool_state().pending_params, None);
    env.set_time(T0 + 200 * DAY);
    assert_fails(env.apply_params(), GoodFaithError::NothingPending);
    assert_eq!(env.pool_state().max_loan, 9);
}

#[test]
fn wind_down_lifecycle() {
    let mut env = Env::with_timelock(2500, 3 * DAY);
    env.fund(10_000);
    let admin = env.admin.insecure_clone();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let successor = env.successor_token();
    let borrower = env.tracked_actor(0);
    let cosigner = env.tracked_actor(10_000);

    assert_fails(env.cancel_wind_down(&admin), GoodFaithError::NotWindingDown);
    // No successor named yet: the account check fires before the state check.
    assert_fails(env.sweep(successor), GoodFaithError::InvalidSuccessor);
    assert_fails(
        env.announce_wind_down(&stranger, successor),
        GoodFaithError::Unauthorized,
    );
    // The vault, an escrow, or an account of another mint are not successors.
    let vault = env.vault;
    assert_fails(
        env.announce_wind_down(&admin, vault),
        GoodFaithError::InvalidSuccessor,
    );
    let id = env.open_simple(&borrower, &cosigner, 1_000);
    let escrow = env.escrow_addr(&env.loan_addr(id));
    assert_fails(
        env.announce_wind_down(&admin, escrow),
        GoodFaithError::InvalidSuccessor,
    );
    let other_mint = env.token_for_mint(Pubkey::new_unique());
    assert_fails(
        env.announce_wind_down(&admin, other_mint),
        GoodFaithError::InvalidSuccessor,
    );

    env.announce_wind_down(&admin, successor).unwrap();
    let pool = env.pool_state();
    assert_eq!(pool.wind_down_at, Some(T0 + 3 * DAY));
    assert_eq!(pool.successor, Some(successor));
    assert_fails(
        env.announce_wind_down(&admin, successor),
        GoodFaithError::InvalidParams,
    );
    // Before it takes effect, business as usual, and the authority can change its mind.
    let donor = env.actor(500);
    env.donate(&donor, 500).unwrap();
    env.cancel_wind_down(&admin).unwrap();
    assert_eq!(env.pool_state().wind_down_at, None);
    assert_eq!(env.pool_state().successor, None);
    env.set_time(T0 + DAY);
    env.announce_wind_down(&admin, successor).unwrap();
    env.set_time(T0 + 4 * DAY - 1);
    assert_fails(env.sweep(successor), GoodFaithError::NotWindingDown);
    let b2 = env.tracked_actor(0);
    let c2 = env.tracked_actor(1_000);
    let b2k = b2.kp.insecure_clone();
    env.request_loan(&b2k, &b2, &c2.key(), 200, 30).unwrap();

    // In effect: no donations, requests or co-signs; no going back.
    env.set_time(T0 + 4 * DAY);
    assert_fails(env.donate(&donor, 1), GoodFaithError::WindingDown);
    let f = env.tracked_actor(0);
    let fk = f.kp.insecure_clone();
    assert_fails(
        env.request_loan(&fk, &f, &c2.key(), 100, 30),
        GoodFaithError::WindingDown,
    );
    let c2k = c2.kp.insecure_clone();
    assert_fails(env.cosign_loan(&c2k, &b2, &c2), GoodFaithError::WindingDown);
    env.cancel_request(&b2k, &b2.key()).unwrap();
    assert_fails(env.cancel_wind_down(&admin), GoodFaithError::WindingDown);
    assert_fails(env.sweep(successor), GoodFaithError::LoansOutstanding);
    // Members can still join and replace wallets; open loans run their course.
    let late = env.actor(0);
    env.register(&late).unwrap();
    let moved = env.new_wallet_for(&late, 0);
    env.rebind_wallet(&moved).unwrap();
    env.repay(&cosigner, id, 600).unwrap();
    env.set_time(T0 + 30 * DAY + 7 * DAY + 1);
    env.mark_default(&stranger, id).unwrap();
    assert_eq!(env.pool_state().active_loans, 0);

    // Everyone can see it is over; anyone can move the balance on.
    let wrong = env.successor_token();
    assert_fails(env.sweep(wrong), GoodFaithError::InvalidSuccessor);
    let before = env.balance(&env.vault);
    assert_eq!(before, 10_000 + 500 - 1_000 + 600 + 250);
    env.sweep_by(&stranger, successor).unwrap();
    assert_eq!(env.balance(&env.vault), 0);
    assert_eq!(env.balance(&successor), before);
    assert_eq!(env.pool_state().total_swept, before);
    assert_fails(env.sweep(successor), GoodFaithError::AmountZero);
}

#[test]
fn frozen_pool_keeps_an_announced_wind_down() {
    let mut env = Env::with_timelock(2500, 3 * DAY);
    env.fund(1_000);
    let admin = env.admin.insecure_clone();
    let successor = env.successor_token();
    env.announce_wind_down(&admin, successor).unwrap();
    env.freeze_pool(&admin).unwrap();
    assert_eq!(env.pool_state().wind_down_at, Some(T0 + 3 * DAY));
    assert_fails(env.cancel_wind_down(&admin), GoodFaithError::Unauthorized);
    env.set_time(T0 + 3 * DAY);
    env.sweep(successor).unwrap();
    assert_eq!(env.balance(&successor), 1_000);
}

#[test]
fn suspending_the_issuer_stops_joins_until_a_new_issuer_is_set() {
    let mut env = Env::with_timelock(2500, DAY);
    let admin = env.admin.insecure_clone();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let existing = env.member_actor(1_000);
    let other = env.member_actor(0);
    assert_fails(env.suspend_issuer(&stranger), GoodFaithError::Unauthorized);
    env.suspend_issuer(&admin).unwrap();
    assert_eq!(env.pool_state().issuer, Pubkey::default());
    let a = env.actor(0);
    assert_fails(env.register(&a), GoodFaithError::Unauthorized);
    let moved = env.new_wallet_for(&existing, 0);
    assert_fails(env.rebind_wallet(&moved), GoodFaithError::Unauthorized);
    // Existing members are unaffected.
    env.fund(1_000);
    let ok = other.kp.insecure_clone();
    env.open_loan(&ok, &other, &existing, 100, 30).unwrap();
    // A replacement issuer goes through the timelock like any setting.
    let fresh = Keypair::new();
    env.svm.airdrop(&fresh.pubkey(), 1_000_000_000).unwrap();
    let mut p = env.params(2500);
    p.issuer = fresh.pubkey();
    env.schedule_params(&admin, p).unwrap();
    assert_fails(env.register(&a), GoodFaithError::Unauthorized);
    env.set_time(T0 + DAY);
    env.apply_params().unwrap();
    assert_fails(env.register(&a), GoodFaithError::Unauthorized);
    env.register_as(&a, &fresh).unwrap();
    assert_eq!(env.person(&a).wallet, a.key());
}

#[test]
fn active_loans_counts_open_loans() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let b1 = env.tracked_actor(0);
    let b2 = env.tracked_actor(0);
    let c = env.tracked_actor(10_000);
    let id1 = env.open_simple(&b1, &c, 1_000);
    assert_eq!(env.pool_state().active_loans, 1);
    let id2 = env.open_simple(&b2, &c, 1_000);
    assert_eq!(env.pool_state().active_loans, 2);
    env.repay(&c, id1, 1_000).unwrap();
    assert_eq!(env.pool_state().active_loans, 1);
    env.after_grace(id2);
    env.mark_default(&c.kp.insecure_clone(), id2).unwrap();
    assert_eq!(env.pool_state().active_loans, 0);
}

#[test]
fn recovery_is_two_step_with_a_veto_window() {
    let mut env = Env::with_delays(2500, 0, 3 * DAY);
    env.fund(10_000);
    let a = env.tracked_actor(1_000);
    let c = env.tracked_actor(10_000);
    let id = env.open_simple(&a, &c, 1_000);
    let new = env.new_wallet_for(&a, 0);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

    // Both the issuer and the recovery authority must sign.
    let issuer = env.issuer.insecure_clone();
    let recovery = env.recovery.insecure_clone();
    assert_fails(
        env.propose_rebind_as(&new, &stranger, &recovery),
        GoodFaithError::Unauthorized,
    );
    assert_fails(
        env.propose_rebind_as(&new, &issuer, &stranger),
        GoodFaithError::Unauthorized,
    );
    assert_fails(
        env.finalize_rebind(&stranger, &new),
        GoodFaithError::RecoveryNotPending,
    );
    assert_fails(
        env.veto_rebind(&a.kp.insecure_clone(), &a.person_id),
        GoodFaithError::RecoveryNotPending,
    );
    env.propose_rebind(&new).unwrap();
    let p = env.person(&a);
    assert_eq!(p.pending_wallet, Some(new.key()));
    assert_eq!(p.pending_wallet_at, T0 + 3 * DAY);
    assert_eq!(p.wallet, a.key(), "nothing moves at proposal");
    assert_fails(env.propose_rebind(&new), GoodFaithError::RecoveryPending);
    // Too early, and only the old wallet or the authority may veto.
    assert_fails(
        env.finalize_rebind(&stranger, &new),
        GoodFaithError::RecoveryDelayNotElapsed,
    );
    assert_fails(
        env.veto_rebind(&stranger, &a.person_id),
        GoodFaithError::Unauthorized,
    );
    assert_fails(
        env.veto_rebind(&new.kp.insecure_clone(), &a.person_id),
        GoodFaithError::Unauthorized,
    );
    env.veto_rebind(&a.kp.insecure_clone(), &a.person_id)
        .unwrap();
    assert_eq!(env.person(&a).pending_wallet, None);
    assert_eq!(env.person(&a).wallet, a.key());

    // Proposed again, vetoed by the authority this time, then proposed and finalized by a stranger after the delay.
    env.propose_rebind(&new).unwrap();
    let admin = env.admin.insecure_clone();
    env.veto_rebind(&admin, &a.person_id).unwrap();
    env.propose_rebind(&new).unwrap();
    env.set_time(T0 + 3 * DAY - 1);
    assert_fails(
        env.finalize_rebind(&stranger, &new),
        GoodFaithError::RecoveryDelayNotElapsed,
    );
    env.set_time(T0 + 3 * DAY);
    env.finalize_rebind(&stranger, &new).unwrap();
    let p = env.person(&a);
    assert_eq!(p.wallet, new.key());
    assert_eq!(p.pending_wallet, None);
    assert_eq!(
        p.active_loan,
        Some(env.loan_addr(id)),
        "the open loan followed the person"
    );
    assert!(env.member_of(&a).retired);
    assert_eq!(env.member_of(&new).person, env.person_addr(&a.person_id));
    // The old wallet cannot veto anything any more, and cannot be recovered back to.
    assert_fails(
        env.veto_rebind(&a.kp.insecure_clone(), &a.person_id),
        GoodFaithError::Unauthorized,
    );
    let mut back = env.new_wallet_for(&a, 0);
    back.kp = a.kp.insecure_clone();
    back.gateway = a.gateway;
    env.propose_rebind(&back).unwrap();
    env.set_time(T0 + 6 * DAY);
    assert!(
        env.finalize_rebind(&stranger, &back).is_err(),
        "retired member cannot be re-created"
    );
    env.veto_rebind(&admin, &a.person_id).unwrap();
    // Repayment from the new wallet closes the loan; the escrow is claimed for the co-signer.
    let payer = env.tracked_actor(5_000);
    env.repay(&payer, id, 1_000).unwrap();
    assert_eq!(env.person(&a).active_loan, None);
}

#[test]
fn recovered_and_new_memberships_sit_on_the_first_loan_cap_for_the_cooldown() {
    let mut env = Env::new(2500);
    env.fund(100_000);
    env.tune(|p| {
        p.first_loan_cap = 300;
        p.loan_cap_step = 200;
        p.cooldown_seconds = 10 * DAY;
    });
    let a = env.tracked_actor(0);
    let c = env.tracked_actor(10_000);
    let ak = a.kp.insecure_clone();
    assert_eq!(env.person(&a).restricted_until, T0 + 10 * DAY);
    assert_fails(
        env.request_loan(&ak, &a, &c.key(), 301, 10),
        GoodFaithError::OverPersonalCap,
    );
    env.open_loan(&ak, &a, &c, 300, 10).unwrap();
    env.repay(&a, 0, 300).unwrap();
    assert_eq!(env.person(&a).completed_loans, 1);
    // Still in the cooldown: the completed loan does not raise the cap yet.
    assert_fails(
        env.request_loan(&ak, &a, &c.key(), 301, 10),
        GoodFaithError::OverPersonalCap,
    );
    env.set_time(T0 + 10 * DAY);
    // After the cooldown: first cap + one step.
    assert_fails(
        env.request_loan(&ak, &a, &c.key(), 501, 10),
        GoodFaithError::OverPersonalCap,
    );
    env.open_loan(&ak, &a, &c, 500, 10).unwrap();
    env.repay(&a, 1, 500).unwrap();
    assert_eq!(env.person(&a).completed_loans, 2);
    // A recovery restarts the cooldown.
    let new = env.new_wallet_for(&a, 0);
    env.rebind_wallet(&new).unwrap();
    assert_eq!(env.person(&a).restricted_until, T0 + 20 * DAY);
    let nk = new.kp.insecure_clone();
    assert_fails(
        env.request_loan(&nk, &new, &c.key(), 301, 10),
        GoodFaithError::OverPersonalCap,
    );
    env.set_time(T0 + 20 * DAY);
    env.open_loan(&nk, &new, &c, 700, 10).unwrap();
    // The cap never exceeds the pool's max loan, and the request also checks it.
    env.repay(&new, 2, 700).unwrap();
    env.tune(|p| {
        p.max_loan = 800;
        p.first_loan_cap = 300;
        p.loan_cap_step = 200;
        p.cooldown_seconds = 10 * DAY;
        p.max_exposure_per_person = 800;
    });
    env.set_time(T0 + 40 * DAY);
    assert_fails(
        env.request_loan(&nk, &new, &c.key(), 801, 10),
        GoodFaithError::OverLoanCap,
    );
    env.request_loan(&nk, &new, &c.key(), 800, 10).unwrap();
}

#[test]
fn late_repayment_settles_the_loan_but_is_recorded_and_bars_the_borrower_for_a_while() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    env.tune(|p| p.late_ban_seconds = 5 * DAY);
    let a = env.tracked_actor(0);
    let c = env.tracked_actor(10_000);
    let id = env.open_simple(&a, &c, 1_000);
    let deadline = env.loan(id).deadline().unwrap();
    // One second past the deadline the loan is late whoever moves first.
    env.set_time(deadline + 1);
    env.repay(&a, id, 400).unwrap();
    assert_eq!(
        env.loan(id).status,
        LoanStatus::Active,
        "a partial payment keeps the loan open"
    );
    env.repay(&a, id, 600).unwrap();
    let l = env.loan(id);
    assert_eq!(l.status, LoanStatus::RepaidLate);
    assert_eq!(l.closed_at, deadline + 1);
    assert_eq!(l.refund_pending, 0, "claimed by the harness");
    assert_eq!(
        env.balance(&c.token),
        10_000,
        "the co-signer got the whole escrow back"
    );
    let p = env.person(&a);
    assert_eq!(p.completed_loans, 0, "a late loan does not raise the cap");
    assert_eq!(p.ineligible_until, deadline + 1 + 5 * DAY);
    assert!(env.barred(&a));
    let ak = a.kp.insecure_clone();
    assert_fails(
        env.request_loan(&ak, &a, &c.key(), 100, 10),
        GoodFaithError::Ineligible,
    );
    env.set_time(deadline + 1 + 5 * DAY);
    assert!(!env.barred(&a));
    env.request_loan(&ak, &a, &c.key(), 100, 10).unwrap();
    // The co-signer was never barred and their guarantee count went back down.
    assert!(!env.barred(&c));
    assert_eq!(env.person(&c).active_guarantees, 0);
    assert_eq!(env.person(&c).active_guarantee_amount, 0);
}

#[test]
fn eligibility_bars_are_time_bounded_and_never_shorten() {
    let mut env = Env::new(10_000);
    env.fund(10_000);
    env.tune(|p| {
        p.default_ban_seconds = 30 * DAY;
        p.cosigner_ban_seconds = 10 * DAY;
        p.late_ban_seconds = 20 * DAY;
    });
    let a = env.tracked_actor(0);
    let c = env.tracked_actor(10_000);
    // Default with full cover: borrower barred 30 days, co-signer not barred at all.
    let id = env.open_simple(&a, &c, 1_000);
    env.after_grace(id);
    let t1 = env.now();
    let caller = env.actor(0);
    env.mark_default(&caller.kp, id).unwrap();
    assert_eq!(env.person(&a).ineligible_until, t1 + 30 * DAY);
    assert_eq!(env.person(&c).ineligible_until, 0);
    // The bar expires: the borrower is back, with the first loan cap unaffected (cooldown 0).
    env.set_time(t1 + 30 * DAY);
    assert!(!env.barred(&a));
    // Default with a loss: both barred; a longer existing bar is never shortened by a shorter one.
    env.tune(|p| {
        p.cosigner_escrow_bps = 1000;
        p.default_ban_seconds = 30 * DAY;
        p.cosigner_ban_seconds = 10 * DAY;
        p.late_ban_seconds = 20 * DAY;
    });
    let b = env.tracked_actor(0);
    let id2 = env.open_simple(&b, &c, 1_000);
    env.after_grace(id2);
    let t2 = env.now();
    env.mark_default(&caller.kp, id2).unwrap();
    assert_eq!(env.person(&c).ineligible_until, t2 + 10 * DAY);
    // A second loss for the same co-signer while barred? They cannot co-sign while barred, so set a
    // permanent bar through settings and check that a later shorter bar does not reduce it.
    env.set_time(t2 + 10 * DAY);
    env.tune(|p| {
        p.cosigner_escrow_bps = 1000;
        p.default_ban_seconds = i64::MAX;
        p.cosigner_ban_seconds = i64::MAX;
    });
    let d = env.tracked_actor(0);
    let id3 = env.open_simple(&d, &c, 1_000);
    env.after_grace(id3);
    env.mark_default(&caller.kp, id3).unwrap();
    assert_eq!(env.person(&c).ineligible_until, i64::MAX);
    assert_eq!(env.person(&d).ineligible_until, i64::MAX);
    env.set_time(T0 + 3650 * DAY);
    assert!(env.barred(&c) && env.barred(&d));
    // Zero means no consequence at all.
    env.tune(|p| {
        p.default_ban_seconds = 0;
        p.cosigner_ban_seconds = 0;
    });
    let e = env.tracked_actor(0);
    let f = env.tracked_actor(10_000);
    let id4 = env.open_simple(&e, &f, 1_000);
    env.after_grace(id4);
    env.mark_default(&caller.kp, id4).unwrap();
    assert!(!env.barred(&e) && !env.barred(&f));
}

#[test]
fn exposure_limits_and_reciprocal_guarantees() {
    let mut env = Env::new(2500);
    env.fund(100_000);
    env.tune(|p| {
        p.max_loan = 1_000;
        p.first_loan_cap = 1_000;
        p.max_exposure_per_person = 1_500;
        p.max_guarantees_per_member = 3;
    });
    let a = env.tracked_actor(10_000);
    let b = env.tracked_actor(10_000);
    let c = env.tracked_actor(10_000);
    let (ak, bk, ck) = (
        a.kp.insecure_clone(),
        b.kp.insecure_clone(),
        c.kp.insecure_clone(),
    );
    // a borrows 1_000 from c; a now has 1_000 of exposure.
    env.open_loan(&ak, &a, &c, 1_000, 10).unwrap();
    // a may guarantee at most 500 more; c already guarantees 1_000.
    env.request_loan(&bk, &b, &a.key(), 600, 10).unwrap();
    // a's own open loan must be passed, and then the exposure check fails.
    assert_fails(
        env.cosign_loan(&ak, &b, &a),
        GoodFaithError::MissingCosignerLoan,
    );
    assert_fails(
        env.cosign_with_cosigner_loan(&ak, &b, &a),
        GoodFaithError::OverExposure,
    );
    env.cancel_request(&bk, &b.key()).unwrap();
    env.request_loan(&bk, &b, &a.key(), 500, 10).unwrap();
    env.cosign_with_cosigner_loan(&ak, &b, &a).unwrap();
    assert_eq!(env.person(&a).active_guarantee_amount, 500);
    // c cannot borrow 600 from b: c guarantees 1_000 already (exposure 1_600).
    assert_fails(
        env.request_loan(&ck, &c, &b.key(), 600, 10),
        GoodFaithError::OverExposure,
    );
    env.request_loan(&ck, &c, &b.key(), 500, 10).unwrap();
    // b's open loan is co-signed by a, not by c, so this is not reciprocal.
    env.cosign_with_cosigner_loan(&bk, &c, &b).unwrap();
    // Reciprocity: b borrowed with a as co-signer; a borrowing with b as co-signer is refused.
    let d = env.tracked_actor(10_000);
    let dk = d.kp.insecure_clone();
    // free a first: repay a's loan from c (a still guarantees b)
    env.repay(&a, 0, 1_000).unwrap();
    env.request_loan(&ak, &a, &b.key(), 100, 10).unwrap();
    assert_fails(
        env.cosign_with_cosigner_loan(&bk, &a, &b),
        GoodFaithError::ReciprocalGuarantee,
    );
    env.cancel_request(&ak, &a.key()).unwrap();
    // The optional account must be the co-signer's actual loan.
    env.request_loan(&dk, &d, &b.key(), 100, 10).unwrap();
    let mut accounts = env.cosign_accounts(&bk, &d, &b);
    accounts.cosigner_active_loan = Some(env.loan_addr(0));
    assert_fails(
        env.send_cosign(&accounts, &bk, &b),
        GoodFaithError::MissingCosignerLoan,
    );
    env.cosign_with_cosigner_loan(&bk, &d, &b).unwrap();
}

#[test]
fn disbursement_window_caps_lending_per_period() {
    let mut env = Env::new(2500);
    env.fund(100_000);
    env.tune(|p| {
        p.disbursement_window_seconds = DAY;
        p.disbursement_cap_per_window = 1_500;
    });
    let c = env.tracked_actor(10_000);
    let a = env.tracked_actor(0);
    let b = env.tracked_actor(0);
    env.open_simple(&a, &c, 1_000);
    assert_eq!(env.pool_state().window_disbursed, 1_000);
    let bk = b.kp.insecure_clone();
    env.request_loan(&bk, &b, &c.key(), 600, 10).unwrap();
    assert_fails(
        env.cosign_loan(&bk, &b, &c),
        GoodFaithError::OverDisbursementCap,
    );
    // The window rolls after a day; the request is still valid (7-day TTL).
    env.set_time(T0 + DAY);
    env.cosign_loan(&bk, &b, &c).unwrap();
    let p = env.pool_state();
    assert_eq!(p.window_start, T0 + DAY);
    assert_eq!(p.window_disbursed, 600);
    // Zero cap turns the limit off.
    env.tune(|p| p.disbursement_cap_per_window = 0);
    let d = env.tracked_actor(0);
    env.repay(&a, 0, 1_000).unwrap();
    env.open_simple(&d, &c, 1_000);
}

#[test]
fn requests_expire_and_anyone_closes_them() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    env.tune(|p| p.request_ttl_seconds = 2 * DAY);
    let a = env.tracked_actor(0);
    let c = env.tracked_actor(10_000);
    let ak = a.kp.insecure_clone();
    let stranger = env.actor(0);
    env.request_loan(&ak, &a, &c.key(), 500, 10).unwrap();
    let req: LoanRequest = env.read(&env.request_addr(&a.key()));
    assert_eq!(req.expires_at, T0 + 2 * DAY);
    assert_fails(
        env.close_expired_request(&stranger.kp, &a.key()),
        GoodFaithError::RequestNotExpired,
    );
    env.set_time(T0 + 2 * DAY);
    let ck = c.kp.insecure_clone();
    env.cosign_loan(&ck, &a, &c).unwrap(); // the last valid second
    env.repay(&c, 0, 500).unwrap();
    env.request_loan(&ak, &a, &c.key(), 500, 10).unwrap();
    env.set_time(T0 + 4 * DAY + 1);
    assert_fails(env.cosign_loan(&ck, &a, &c), GoodFaithError::RequestExpired);
    let rent_payer = a.key();
    let before = env.svm.get_balance(&rent_payer).unwrap();
    env.close_expired_request(&stranger.kp, &a.key()).unwrap();
    assert!(env.svm.get_account(&env.request_addr(&a.key())).is_none());
    assert!(
        env.svm.get_balance(&rent_payer).unwrap() > before,
        "rent went back to the request's payer"
    );
    // A fresh request is possible straight away.
    env.request_loan(&ak, &a, &c.key(), 500, 10).unwrap();
}

#[test]
fn escrow_refunds_are_claimed_not_pushed() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let a = env.tracked_actor(0);
    let c = env.tracked_actor(10_000);
    let stranger = env.actor(0);
    // On-time repayment: the loan closes, the escrow waits, anyone claims it to the co-signer's wallet.
    let id = env.open_simple(&a, &c, 1_000);
    assert_fails(
        env.claim_by(&stranger.kp, id),
        GoodFaithError::LoanNotActive,
    );
    env.repay_only(&a, id, 1_000).unwrap();
    let l = env.loan(id);
    assert_eq!(l.status, LoanStatus::Repaid);
    assert_eq!(l.refund_pending, 250);
    assert_eq!(env.pool_state().pending_claims, 250);
    assert_eq!(env.balance(&c.token), 10_000 - 250, "nothing pushed yet");
    assert_eq!(env.balance(&env.escrow_addr(&env.loan_addr(id))), 250);
    assert_eq!(env.pool_state().active_loans, 0);
    env.claim_by(&stranger.kp, id).unwrap();
    assert_eq!(env.balance(&c.token), 10_000);
    assert_eq!(env.loan(id).refund_pending, 0);
    assert_eq!(env.pool_state().pending_claims, 0);
    assert!(
        env.svm
            .get_account(&env.escrow_addr(&env.loan_addr(id)))
            .is_none(),
        "escrow closed on claim"
    );
    assert_fails(
        env.claim_by(&stranger.kp, id),
        3012u32, // the escrow account is gone; Anchor reports that before the status
    );
    // Default with leftover: the leftover waits too; a claim after a wallet recovery goes to the new wallet.
    let id2 = env.open_simple(&a, &c, 1_000);
    env.repay_only(&a, id2, 900).unwrap();
    env.after_grace(id2);
    env.mark_default_only(&stranger.kp, id2).unwrap();
    let l2 = env.loan(id2);
    assert_eq!(l2.status, LoanStatus::Defaulted);
    assert_eq!(l2.refund_pending, 150);
    assert_eq!(env.pool_state().pending_claims, 150);
    let c2 = env.new_wallet_for(&c, 0);
    env.rebind_wallet(&c2).unwrap();
    env.claim_by(&stranger.kp, id2).unwrap();
    assert_eq!(env.balance(&c2.token), 150);
    assert_eq!(env.balance(&c.token), 10_000 - 250);
    // Nothing left over: the escrow closes at settlement and there is nothing to claim.
    env.tune(|p| p.cosigner_escrow_bps = 0);
    let b = env.tracked_actor(0);
    let id3 = env.open_simple(&b, &c2, 1_000);
    env.repay_only(&b, id3, 1_000).unwrap();
    assert!(env
        .svm
        .get_account(&env.escrow_addr(&env.loan_addr(id3)))
        .is_none());
    assert_fails(
        env.claim_by(&stranger.kp, id3),
        3012u32, // the escrow account is gone; Anchor reports that before the status
    );
    // With an escrow account still there, the status check speaks: an Active loan has nothing to claim yet.
    let id4 = env.open_simple(&b, &c2, 1_000);
    assert_fails(
        env.claim_by(&stranger.kp, id4),
        GoodFaithError::LoanNotActive,
    );
}

#[test]
fn pending_claims_never_block_a_wind_down() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let a = env.tracked_actor(0);
    let c = env.tracked_actor(10_000);
    let id = env.open_simple(&a, &c, 1_000);
    env.repay_only(&a, id, 1_000).unwrap();
    assert_eq!(env.pool_state().pending_claims, 250);
    let admin = env.admin.insecure_clone();
    let successor = env.successor_token();
    env.announce_wind_down(&admin, successor).unwrap();
    env.sweep(successor).unwrap();
    assert_eq!(env.balance(&successor), 10_000);
    assert_eq!(
        env.balance(&env.escrow_addr(&env.loan_addr(id))),
        250,
        "escrow untouched by the sweep"
    );
    let stranger = env.actor(0);
    env.claim_by(&stranger.kp, id).unwrap();
    assert_eq!(env.balance(&c.token), 10_000);
}

#[test]
fn pause_stops_new_lending_only() {
    let mut env = Env::new(2500);
    env.fund(10_000);
    let a = env.tracked_actor(0);
    let b = env.tracked_actor(0);
    let c = env.tracked_actor(10_000);
    let id = env.open_simple(&a, &c, 1_000);
    let bk = b.kp.insecure_clone();
    env.request_loan(&bk, &b, &c.key(), 500, 10).unwrap();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    assert_fails(env.pause(&stranger), GoodFaithError::Unauthorized);
    let pauser = env.pauser.insecure_clone();
    env.pause(&pauser).unwrap();
    assert!(env.pool_state().paused);
    // No new requests or co-signs...
    let ck = c.kp.insecure_clone();
    assert_fails(env.cosign_loan(&ck, &b, &c), GoodFaithError::Paused);
    let d = env.tracked_actor(0);
    let dk = d.kp.insecure_clone();
    assert_fails(
        env.request_loan(&dk, &d, &c.key(), 100, 10),
        GoodFaithError::Paused,
    );
    // ...but repayments, donations, defaults, claims, cancellations and joins continue.
    env.repay_only(&a, id, 1_000).unwrap();
    env.claim_by(&stranger, id).unwrap();
    let donor = env.actor(100);
    env.donate(&donor, 100).unwrap();
    env.cancel_request(&bk, &b.key()).unwrap();
    env.member_actor(0);
    // Only the authority resumes.
    assert_fails(env.resume(&pauser), GoodFaithError::Unauthorized);
    let admin = env.admin.insecure_clone();
    env.resume(&admin).unwrap();
    env.open_loan(&dk, &d, &c, 100, 10).unwrap();
    // The authority can pause too.
    env.pause(&admin).unwrap();
    assert!(env.pool_state().paused);
}

#[test]
fn notice_period_cannot_be_scheduled_below_the_minimum() {
    use goodfaith::MIN_TIMELOCK_SECONDS;
    // A test pool (0) may stay low or rise; once at or above the minimum it can never go below again.
    let mut env = Env::new(2500);
    let admin = env.admin.insecure_clone();
    let mut p = env.params(2500);
    p.timelock_seconds = 3600;
    env.update_pool(&admin, p).unwrap();
    p.timelock_seconds = MIN_TIMELOCK_SECONDS;
    env.schedule_params(&admin, p).unwrap();
    env.set_time(T0 + 3600);
    env.apply_params().unwrap();
    p.timelock_seconds = 0;
    assert_fails(
        env.schedule_params(&admin, p),
        GoodFaithError::TimelockBelowMinimum,
    );
    p.timelock_seconds = MIN_TIMELOCK_SECONDS - 1;
    assert_fails(
        env.schedule_params(&admin, p),
        GoodFaithError::TimelockBelowMinimum,
    );
    p.timelock_seconds = MIN_TIMELOCK_SECONDS + 1;
    env.schedule_params(&admin, p).unwrap();
}

mod props {
    use super::*;
    use proptest::prelude::*;

    const ACTORS: usize = 4;
    const START: u64 = 50_000;
    const REBIND_TOKENS: u64 = 1_000;
    const TIMELOCK: i64 = 3 * DAY;
    const RECOVERY_DELAY: i64 = DAY;
    const EXPOSURE: u64 = 6_000;
    const WINDOW_CAP: u64 = 7_000;
    const DEFAULT_BAN: i64 = 30 * DAY;
    const COSIGNER_BAN: i64 = 10 * DAY;
    const LATE_BAN: i64 = 5 * DAY;

    #[derive(Clone, Debug)]
    enum Op {
        Donate(usize, u64),
        Request(usize, usize, u64, u16),
        Cosign(usize),
        Cancel(usize, bool),
        CloseExpired(usize),
        Repay(usize, u64, u64),
        Default(u64),
        Claim(u64),
        Wait(u8),
        Schedule {
            bps: u16,
            grace: u16,
            max_loan: u64,
            max_g: u8,
            restore_issuer: bool,
        },
        Apply,
        CancelParams,
        ProposeRebind(usize),
        Veto(usize),
        Finalize(usize),
        Pause,
        Resume,
        AnnounceWindDown,
        CancelWindDown,
        Sweep,
        SuspendIssuer,
    }

    fn op() -> impl Strategy<Value = Op> {
        let a = 0..ACTORS;
        prop_oneof![
            4 => (a.clone(), 0..5_000u64).prop_map(|(x, n)| Op::Donate(x, n)),
            7 => (a.clone(), a.clone(), 0..4_000u64, 0..100u16)
                .prop_map(|(b, c, n, t)| Op::Request(b, c, n, t)),
            7 => a.clone().prop_map(Op::Cosign),
            2 => (a.clone(), any::<bool>()).prop_map(|(x, y)| Op::Cancel(x, y)),
            1 => a.clone().prop_map(Op::CloseExpired),
            6 => (a.clone(), 0..8u64, 0..4_000u64).prop_map(|(x, l, n)| Op::Repay(x, l, n)),
            3 => (0..8u64).prop_map(Op::Default),
            3 => (0..8u64).prop_map(Op::Claim),
            6 => (0..40u8).prop_map(Op::Wait),
            3 => (0..=10_000u16, 0..10u16, 1..5_000u64, 1..4u8, any::<bool>()).prop_map(
                |(bps, grace, max_loan, max_g, restore_issuer)| Op::Schedule {
                    bps,
                    grace,
                    max_loan,
                    max_g,
                    restore_issuer,
                }
            ),
            3 => Just(Op::Apply),
            1 => Just(Op::CancelParams),
            2 => a.clone().prop_map(Op::ProposeRebind),
            1 => a.clone().prop_map(Op::Veto),
            2 => a.clone().prop_map(Op::Finalize),
            1 => Just(Op::Pause),
            1 => Just(Op::Resume),
            1 => Just(Op::AnnounceWindDown),
            1 => Just(Op::CancelWindDown),
            2 => Just(Op::Sweep),
            1 => Just(Op::SuspendIssuer),
        ]
    }

    fn escrow_balance(env: &Env, id: u64) -> Option<u64> {
        let acc = env.svm.get_account(&env.escrow_addr(&env.loan_addr(id)))?;
        (acc.owner == TOKEN_PROGRAM && acc.data.len() == 165)
            .then(|| u64::from_le_bytes(acc.data[64..72].try_into().unwrap()))
    }

    /// Everything the harness has handed tokens to, plus the vault, escrows and the successor.
    fn token_balance_sum(env: &Env, tokens: &[Pubkey]) -> u64 {
        let mut total = env.balance(&env.vault);
        for t in tokens {
            total += env.balance(t);
        }
        for id in 0..env.pool_state().loan_count {
            total += escrow_balance(env, id).unwrap_or(0);
        }
        total
    }

    fn live_params(pool: &Pool) -> PoolParams {
        PoolParams {
            gatekeeper_network: pool.gatekeeper_network,
            max_loan: pool.max_loan,
            max_term_days: pool.max_term_days,
            grace_days: pool.grace_days,
            max_guarantees_per_member: pool.max_guarantees_per_member,
            cosigner_escrow_bps: pool.cosigner_escrow_bps,
            issuer: pool.issuer,
            timelock_seconds: pool.timelock_seconds,
            recovery_authority: pool.recovery_authority,
            pause_authority: pool.pause_authority,
            recovery_delay_seconds: pool.recovery_delay_seconds,
            request_ttl_seconds: pool.request_ttl_seconds,
            first_loan_cap: pool.first_loan_cap,
            loan_cap_step: pool.loan_cap_step,
            cooldown_seconds: pool.cooldown_seconds,
            max_exposure_per_person: pool.max_exposure_per_person,
            disbursement_window_seconds: pool.disbursement_window_seconds,
            disbursement_cap_per_window: pool.disbursement_cap_per_window,
            default_ban_seconds: pool.default_ban_seconds,
            late_ban_seconds: pool.late_ban_seconds,
            cosigner_ban_seconds: pool.cosigner_ban_seconds,
        }
    }

    struct Model {
        /// Settings as last applied; the pool may only differ from these through `apply_params`.
        applied: PoolParams,
        /// Loan count and donations frozen the moment the wind-down took effect.
        closed_at: Option<(u64, u64)>,
        /// Loan count when lending was paused; unchanged while paused.
        paused_at: Option<u64>,
        /// Every token account that ever held supply (current and retired wallets, successor).
        tokens: Vec<Pubkey>,
        /// Wallets retired by a recovery.
        retired: Vec<Pubkey>,
        /// Proposed replacement wallets, per actor, until finalized or vetoed.
        pending: Vec<Option<Actor>>,
        supply: u64,
        now: i64,
    }

    fn check(env: &Env, actors: &[Actor], m: &mut Model) {
        let pool = env.pool_state();
        // vault == donated + repaid + recovered - lent - swept
        assert_eq!(
            u128::from(env.balance(&env.vault)),
            u128::from(pool.total_donated)
                + u128::from(pool.total_repaid)
                + u128::from(pool.total_recovered)
                - u128::from(pool.total_lent)
                - u128::from(pool.total_swept)
        );
        // tokens are conserved across wallets, escrows and the successor
        assert_eq!(token_balance_sum(env, &m.tokens), m.supply);
        // settings only move through apply_params
        assert_eq!(
            live_params(&pool),
            m.applied,
            "settings changed without apply_params"
        );
        if let Some(p) = pool.pending_params {
            assert!(p.validate().is_ok());
        }
        // once winding down: no new loans, no new donations, and no way back
        if pool.winding_down(m.now) {
            let snap = *m
                .closed_at
                .get_or_insert((pool.loan_count, pool.total_donated));
            assert_eq!((pool.loan_count, pool.total_donated), snap);
            assert!(pool.successor.is_some());
        } else {
            assert!(m.closed_at.is_none(), "a wind-down in effect was undone");
        }
        if pool.total_swept > 0 {
            assert_eq!(pool.active_loans, 0);
        }
        // paused: no loan opened since
        if pool.paused {
            let snap = *m.paused_at.get_or_insert(pool.loan_count);
            assert_eq!(pool.loan_count, snap, "a loan opened while paused");
        } else {
            m.paused_at = None;
        }
        if pool.disbursement_cap_per_window > 0 {
            assert!(pool.window_disbursed <= pool.disbursement_cap_per_window);
        }

        let persons: Vec<Pubkey> = actors
            .iter()
            .map(|a| env.person_addr(&a.person_id))
            .collect();
        let mut guarantees = vec![0u8; actors.len()];
        let mut guaranteed = vec![0u64; actors.len()];
        let mut borrowed = vec![0u64; actors.len()];
        let mut completed = vec![0u16; actors.len()];
        let mut active: Vec<Option<Pubkey>> = vec![None; actors.len()];
        let mut open = 0u64;
        let mut pending_claims = 0u64;
        let mut pairs: Vec<(usize, usize)> = Vec::new();
        for id in 0..pool.loan_count {
            let loan = env.loan(id);
            assert!(loan.repaid <= loan.principal);
            assert_ne!(loan.borrower_person, loan.cosigner_person);
            let b = persons
                .iter()
                .position(|p| *p == loan.borrower_person)
                .unwrap();
            let c = persons
                .iter()
                .position(|p| *p == loan.cosigner_person)
                .unwrap();
            let escrow = escrow_balance(env, id);
            let deadline = loan.deadline().unwrap();
            match loan.status {
                LoanStatus::Active => {
                    open += 1;
                    assert_eq!(escrow, Some(loan.escrowed));
                    assert!(active[b].is_none(), "two active loans for one person");
                    active[b] = Some(env.loan_addr(id));
                    guarantees[c] += 1;
                    guaranteed[c] += loan.principal;
                    borrowed[b] += loan.principal - loan.repaid;
                    assert!(!pairs.contains(&(c, b)), "reciprocal guarantee");
                    pairs.push((b, c));
                    assert_eq!(loan.refund_pending, 0);
                }
                LoanStatus::Repaid | LoanStatus::RepaidLate => {
                    assert_eq!(loan.repaid, loan.principal);
                    assert_eq!(
                        loan.status == LoanStatus::RepaidLate,
                        loan.closed_at > deadline
                    );
                    if loan.status == LoanStatus::Repaid {
                        completed[b] += 1;
                    } else {
                        assert!(
                            env.person(&actors[b]).ineligible_until >= loan.closed_at + LATE_BAN
                        );
                    }
                    // the escrow waits exactly `refund_pending`, or is gone
                    assert_eq!(
                        escrow.unwrap_or(0),
                        loan.refund_pending,
                        "escrow vs refund pending"
                    );
                    pending_claims += loan.refund_pending;
                }
                LoanStatus::Defaulted => {
                    assert!(loan.closed_at > deadline);
                    assert_eq!(
                        escrow.unwrap_or(0),
                        loan.refund_pending,
                        "escrow vs refund pending"
                    );
                    pending_claims += loan.refund_pending;
                    assert!(
                        env.person(&actors[b]).ineligible_until >= loan.closed_at + DEFAULT_BAN
                    );
                    let shortfall = loan.principal - loan.repaid;
                    if shortfall > loan.escrowed {
                        assert!(
                            env.person(&actors[c]).ineligible_until
                                >= loan.closed_at + COSIGNER_BAN
                        );
                    }
                }
            }
        }
        assert_eq!(pool.active_loans, open);
        assert_eq!(pool.pending_claims, pending_claims);
        for (i, a) in actors.iter().enumerate() {
            let p = env.person(a);
            assert_eq!(p.active_loan, active[i]);
            assert_eq!(p.active_guarantees, guarantees[i]);
            assert_eq!(p.active_guarantee_amount, guaranteed[i]);
            assert_eq!(p.completed_loans, completed[i]);
            assert!(borrowed[i] + guaranteed[i] <= EXPOSURE, "exposure limit");
            assert_eq!(p.wallet, a.key());
            let member = env.member_of(a);
            assert!(!member.retired);
            assert_eq!(member.person, persons[i]);
            match (&m.pending[i], p.pending_wallet) {
                (Some(n), Some(w)) => assert_eq!(n.key(), w),
                (None, None) => {}
                (x, y) => panic!(
                    "pending recovery mismatch: model {:?} chain {:?}",
                    x.as_ref().map(|n| n.key()),
                    y
                ),
            }
        }
        for w in &m.retired {
            let member: Member = env.read(&env.member_addr(w));
            assert!(member.retired);
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 24, ..ProptestConfig::default() })]
        #[test]
        fn invariants_hold(ops in proptest::collection::vec(op(), 1..40)) {
            let mut env = Env::with_delays(2500, 0, RECOVERY_DELAY);
            env.tune(|p| {
                p.max_exposure_per_person = EXPOSURE;
                p.disbursement_cap_per_window = WINDOW_CAP;
                p.disbursement_window_seconds = 2 * DAY;
                p.default_ban_seconds = DEFAULT_BAN;
                p.cosigner_ban_seconds = COSIGNER_BAN;
                p.late_ban_seconds = LATE_BAN;
                p.timelock_seconds = TIMELOCK;
            });
            let mut actors: Vec<Actor> = (0..ACTORS).map(|_| env.tracked_actor(START)).collect();
            let successor = env.successor_token();
            let mut m = Model {
                applied: live_params(&env.pool_state()),
                closed_at: None,
                paused_at: None,
                tokens: actors.iter().map(|a| a.token).chain([successor]).collect(),
                retired: Vec::new(),
                pending: vec![None, None, None, None],
                supply: ACTORS as u64 * START,
                now: T0,
            };
            let admin = env.admin.insecure_clone();
            let pauser = env.pauser.insecure_clone();
            for o in ops {
                match o {
                    Op::Donate(a, n) => { let _ = env.donate(&actors[a], n); }
                    Op::Request(b, c, n, t) => {
                        let kp = actors[b].kp.insecure_clone();
                        let _ = env.request_loan(&kp, &actors[b], &actors[c].key(), n, t);
                    }
                    Op::Cosign(b) => {
                        let req = env.request_addr(&actors[b].key());
                        if env.svm.get_account(&req).is_some_and(|a| !a.data.is_empty()) {
                            let r: LoanRequest = env.read(&req);
                            let c = actors.iter().position(|a| a.key() == r.cosigner);
                            if let Some(c) = c {
                                let kp = actors[c].kp.insecure_clone();
                                let _ = env.cosign_with_cosigner_loan(&kp, &actors[b], &actors[c]);
                            }
                        }
                    }
                    Op::Cancel(b, by_borrower) => {
                        let req = env.request_addr(&actors[b].key());
                        if env.svm.get_account(&req).is_some_and(|a| !a.data.is_empty()) {
                            let r: LoanRequest = env.read(&req);
                            let who = if by_borrower { r.borrower } else { r.cosigner };
                            if let Some(w) = actors.iter().find(|a| a.key() == who) {
                                let kp = w.kp.insecure_clone();
                                let _ = env.cancel_request(&kp, &r.borrower);
                            }
                        }
                    }
                    Op::CloseExpired(b) => {
                        let req = env.request_addr(&actors[b].key());
                        if env.svm.get_account(&req).is_some_and(|a| !a.data.is_empty()) {
                            let _ = env.close_expired_request(&admin, &actors[b].key());
                        }
                    }
                    Op::Repay(p, l, n) => {
                        if l < env.pool_state().loan_count {
                            let _ = env.repay_only(&actors[p], l, n);
                        }
                    }
                    Op::Default(l) => {
                        if l < env.pool_state().loan_count {
                            let _ = env.mark_default_only(&admin, l);
                        }
                    }
                    Op::Claim(l) => {
                        if l < env.pool_state().loan_count {
                            let _ = env.claim_by(&admin, l);
                        }
                    }
                    Op::Wait(d) => {
                        m.now += i64::from(d) * DAY;
                        env.set_time(m.now);
                    }
                    Op::Schedule { bps, grace, max_loan, max_g, restore_issuer } => {
                        let mut p = live_params(&env.pool_state());
                        p.cosigner_escrow_bps = bps;
                        p.grace_days = grace;
                        p.max_loan = max_loan;
                        p.first_loan_cap = max_loan;
                        p.max_guarantees_per_member = max_g;
                        if restore_issuer {
                            p.issuer = env.issuer.pubkey();
                        }
                        let _ = env.schedule_params(&admin, p);
                    }
                    Op::Apply => {
                        let pending = env.pool_state().pending_params;
                        if env.apply_params().is_ok() {
                            m.applied = pending.expect("applied without a pending change");
                        }
                    }
                    Op::CancelParams => { let _ = env.cancel_params(&admin); }
                    Op::ProposeRebind(i) => {
                        if m.pending[i].is_none() {
                            let n = env.new_wallet_for(&actors[i], REBIND_TOKENS);
                            m.tokens.push(n.token);
                            m.supply += REBIND_TOKENS;
                            if env.propose_rebind(&n).is_ok() {
                                m.pending[i] = Some(n);
                            }
                        }
                    }
                    Op::Veto(i) => {
                        let kp = actors[i].kp.insecure_clone();
                        if env.veto_rebind(&kp, &actors[i].person_id).is_ok() {
                            m.pending[i] = None;
                        }
                    }
                    Op::Finalize(i) => {
                        if let Some(n) = m.pending[i].as_ref() {
                            if env.finalize_rebind(&admin, n).is_ok() {
                                m.retired.push(actors[i].key());
                                actors[i] = m.pending[i].take().unwrap();
                            }
                        }
                    }
                    Op::Pause => { let _ = env.pause(&pauser); }
                    Op::Resume => { let _ = env.resume(&admin); }
                    Op::AnnounceWindDown => { let _ = env.announce_wind_down(&admin, successor); }
                    Op::CancelWindDown => { let _ = env.cancel_wind_down(&admin); }
                    Op::Sweep => { let _ = env.sweep(successor); }
                    Op::SuspendIssuer => {
                        if env.suspend_issuer(&admin).is_ok() {
                            m.applied.issuer = Pubkey::default();
                        }
                    }
                }
                check(&env, &actors, &mut m);
            }
        }
    }
}
