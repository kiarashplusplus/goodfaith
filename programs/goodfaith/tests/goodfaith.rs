use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    goodfaith::{
        error::GoodFaithError,
        gateway::GATEWAY_PROGRAM_ID,
        state::{Loan, LoanRequest, LoanStatus, Member, Pool, PoolParams},
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
}

fn params(network: Pubkey, bps: u16) -> PoolParams {
    PoolParams {
        gatekeeper_network: network,
        max_loan: 1_000_000,
        max_term_days: 90,
        grace_days: 7,
        max_guarantees_per_member: 2,
        cosigner_escrow_bps: bps,
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
        let mut svm = LiteSVM::new();
        svm.add_program(
            program_id(),
            include_bytes!("../../../target/deploy/goodfaith.so"),
        )
        .unwrap();
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
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
        };
        env.set_time(T0);
        let res = env.initialize_pool(params(env.network, bps));
        res.unwrap();
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

    fn update_pool(&mut self, signer: &Keypair, p: PoolParams) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::UpdatePool { params: p }.data(),
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
        Actor { kp, token, gateway }
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
        let payer_key = payer.map_or(a.key(), |p| p.pubkey());
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::RegisterMember {}.data(),
            goodfaith::accounts::RegisterMember {
                wallet: a.key(),
                payer: payer_key,
                pool: self.pool,
                member: self.member_addr(&a.key()),
                gateway_token: gateway,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        match payer {
            Some(p) => self.send(ix, p, &[&a.kp]),
            None => self.send(ix, &a.kp, &[]),
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

    fn member(&self, a: &Actor) -> Member {
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
                borrower_member: self.member_addr(&borrower.key()),
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
                borrower_member: self.member_addr(&borrower.key()),
                cosigner_member: self.member_addr(&cosigner.key()),
                borrower_token: borrower.token,
                cosigner_token: cosigner.token,
                loan,
                escrow: self.escrow_addr(&loan),
                borrower_gateway_token: borrower.gateway,
                cosigner_gateway_token: cosigner.gateway,
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
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

    fn repay(&mut self, payer: &Actor, id: u64, amount: u64) -> Result<(), String> {
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
                cosigner_token: self.token_of(&loan.cosigner),
                borrower_member: self.member_addr(&loan.borrower),
                cosigner_member: self.member_addr(&loan.cosigner),
                rent_payer: loan.rent_payer,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        );
        self.send(ix, &payer.kp, &[])
    }

    fn mark_default(&mut self, caller: &Keypair, id: u64) -> Result<(), String> {
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
                cosigner_token: self.token_of(&loan.cosigner),
                borrower_member: self.member_addr(&loan.borrower),
                cosigner_member: self.member_addr(&loan.cosigner),
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
        let ix = Instruction::new_with_bytes(
            program_id(),
            &goodfaith::instruction::RegisterMember {}.data(),
            goodfaith::accounts::RegisterMember {
                wallet: a.key(),
                payer: a.key(),
                pool,
                member,
                gateway_token: a.gateway,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(ix, &a.kp, &[])
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
            cosigner_token: self.token_of(&loan.cosigner),
            borrower_member: self.member_addr(&loan.borrower),
            cosigner_member: self.member_addr(&loan.cosigner),
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
            cosigner_token: self.token_of(&loan.cosigner),
            borrower_member: self.member_addr(&loan.borrower),
            cosigner_member: self.member_addr(&loan.cosigner),
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
            borrower_member: self.member_addr(&borrower.key()),
            cosigner_member: self.member_addr(&cosigner.key()),
            borrower_token: borrower.token,
            cosigner_token: cosigner.token,
            loan,
            escrow: self.escrow_addr(&loan),
            borrower_gateway_token: borrower.gateway,
            cosigner_gateway_token: cosigner.gateway,
            token_program: TOKEN_PROGRAM,
            system_program: system_program::ID,
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

    let mut p = params(env.network, 5000);
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
    let m = env.member(&a);
    assert_eq!(m.wallet, a.key());
    assert_eq!(m.active_loan, None);
    assert_eq!(m.active_guarantees, 0);
    assert!(!m.ineligible);
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
    assert_eq!(env.member(&a).wallet, a.key());
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
    assert_eq!(env.member(&borrower).active_loan, Some(env.loan_addr(0)));
    assert_eq!(env.member(&cosigner).active_guarantees, 1);
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
    assert!(env.member(&borrower).active_loan.is_some());
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
    assert_eq!(env.member(&borrower).active_loan, None);
    assert_eq!(env.member(&cosigner).active_guarantees, 0);

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
    assert!(env.member(&borrower).ineligible);
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
    let (b, c) = (env.member(&borrower), env.member(&cosigner));
    assert!(b.ineligible && c.ineligible);
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
    assert_eq!(env.member(&borrower).active_loan, None);
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
    assert!(env.member(&risky).ineligible);

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
                params: params(env.network, 2500),
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
    env.update_pool(&admin, params(env.network, 10_000))
        .unwrap();
    assert_fails(
        env.cosign_loan_with(&b, &borrower, &cosigner, (900, 30, 225)),
        GoodFaithError::EscrowTooHigh,
    );
    env.update_pool(&admin, params(env.network, 2500)).unwrap();
    env.cosign_loan_with(&b, &borrower, &cosigner, (900, 30, 225))
        .unwrap();
    assert_eq!(env.loan(0).escrowed, 225);
}

#[test]
fn audit_grace_period_is_fixed_at_open() {
    let (mut env, _borrower, _cosigner, id) = setup_default(2500, 1_000);
    assert_eq!(env.loan(id).grace_days, 7);
    let admin = env.admin.insecure_clone();
    let mut p = params(env.network, 2500);
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
    let mut p = params(env.network, 0);
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
        env.update_pool(&admin, params(env.network, 1)),
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
        cosigner_token: cosigner.token,
        borrower_member: env.member_addr(&loan.borrower),
        cosigner_member: env.member_addr(&loan.cosigner),
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
        let mut bad = params(env.network, 100);
        tweak(&mut bad);
        assert_fails(env.update_pool(&admin, bad), GoodFaithError::InvalidParams);
    }
    let mut edge = params(env.network, 100);
    edge.max_term_days = goodfaith::MAX_TERM_DAYS;
    edge.grace_days = goodfaith::MAX_GRACE_DAYS;
    env.update_pool(&admin, edge).unwrap();
    assert_eq!(env.pool_state().grace_days, goodfaith::MAX_GRACE_DAYS);
}

#[test]
fn initialize_rejects_bad_params() {
    let mut env = Env::new(2500);
    let mut bad = params(env.network, 2500);
    bad.max_loan = 0;
    let (pool, res) = env.init_pool_on_new_mint(bad);
    assert_fails(res, GoodFaithError::InvalidParams);
    assert!(env.svm.get_account(&pool).is_none());
    let (pool, res) = env.init_pool_on_new_mint(params(env.network, 10_001));
    assert_fails(res, GoodFaithError::InvalidBps);
    assert!(env.svm.get_account(&pool).is_none());
    let (pool, res) = env.init_pool_on_new_mint(params(env.network, 2500));
    res.unwrap();
    let p: Pool = env.read(&pool);
    assert_eq!(p.authority, Some(env.admin.pubkey()));
    assert_eq!(p.pending_authority, None);
}

#[test]
fn initialize_twice_and_register_twice_fail() {
    let mut env = Env::new(2500);
    let before = env.pool_state();
    assert_fails(env.initialize_pool(params(env.network, 100)), 0u32);
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
    env.update_pool(&admin, params(env.network, 3000)).unwrap();
    assert_fails(
        env.accept_authority(&stranger),
        GoodFaithError::Unauthorized,
    );

    env.accept_authority(&next).unwrap();
    let p = env.pool_state();
    assert_eq!(p.authority, Some(next.pubkey()));
    assert_eq!(p.pending_authority, None);
    assert_fails(
        env.update_pool(&admin, params(env.network, 100)),
        GoodFaithError::Unauthorized,
    );
    env.update_pool(&next, params(env.network, 100)).unwrap();
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
    let (pool_b, res) = env.init_pool_on_new_mint(params(env.network, 2500));
    res.unwrap();
    let borrower = env.actor(0);
    env.register_in_pool(&borrower, pool_b).unwrap();
    let cosigner = env.member_actor(1_000);
    let member_b = Pubkey::find_program_address(
        &[b"member", pool_b.as_ref(), borrower.key().as_ref()],
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
            borrower_member: member_b,
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
    accounts = env.repay_accounts(&stranger, id);
    accounts.cosigner_token = other.token;
    assert_fails(
        env.send_repay(&accounts, &stranger, 10),
        ErrorCode::ConstraintTokenOwner,
    );

    // mark_default: same substitutions
    env.set_time(T0 + 30 * DAY + 7 * DAY + 1);
    let mut accounts = env.default_accounts(&stranger.kp, id);
    accounts.rent_payer = stranger.key();
    assert_fails(
        env.send_default(&accounts, &stranger.kp),
        ErrorCode::ConstraintAddress,
    );
    accounts = env.default_accounts(&stranger.kp, id);
    accounts.cosigner_token = other.token;
    assert_fails(
        env.send_default(&accounts, &stranger.kp),
        ErrorCode::ConstraintTokenOwner,
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
    assert_eq!(env.loan(id).repaid, 0);
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
    assert!(env.member(&borrower).ineligible && env.member(&cosigner).ineligible);

    // Repaying late, but before anyone marks the default, still closes the loan normally.
    let (mut env, borrower, cosigner, id) = setup_default(2500, 1_000);
    let payer = env.tracked_actor(5_000);
    env.set_time(T0 + 30 * DAY + 7 * DAY + 100 * DAY);
    env.repay(&payer, id, 1_000).unwrap();
    assert_eq!(env.loan(id).status, LoanStatus::Repaid);
    assert!(!env.member(&borrower).ineligible && !env.member(&cosigner).ineligible);
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

mod props {
    use super::*;
    use proptest::prelude::*;

    const ACTORS: usize = 4;
    const START: u64 = 50_000;

    #[derive(Clone, Debug)]
    enum Op {
        Donate(usize, u64),
        Request(usize, usize, u64, u16),
        Cosign(usize),
        Cancel(usize, bool),
        Repay(usize, u64, u64),
        Default(u64),
        Wait(u8),
        Update {
            bps: u16,
            grace: u16,
            max_loan: u64,
            max_g: u8,
        },
    }

    fn op() -> impl Strategy<Value = Op> {
        let a = 0..ACTORS;
        prop_oneof![
            (a.clone(), 0..5_000u64).prop_map(|(x, n)| Op::Donate(x, n)),
            (a.clone(), a.clone(), 0..4_000u64, 0..100u16)
                .prop_map(|(b, c, n, t)| Op::Request(b, c, n, t)),
            a.clone().prop_map(Op::Cosign),
            (a.clone(), any::<bool>()).prop_map(|(x, y)| Op::Cancel(x, y)),
            (a.clone(), 0..6u64, 0..4_000u64).prop_map(|(x, l, n)| Op::Repay(x, l, n)),
            (0..6u64).prop_map(Op::Default),
            (0..60u8).prop_map(Op::Wait),
            (0..=10_000u16, 0..10u16, 0..5_000u64, 0..4u8).prop_map(
                |(bps, grace, max_loan, max_g)| Op::Update {
                    bps,
                    grace,
                    max_loan,
                    max_g
                }
            ),
        ]
    }

    fn token_balance_sum(env: &Env, actors: &[Actor]) -> u64 {
        let mut total = env.balance(&env.vault);
        for a in actors {
            total += env.balance(&a.token);
        }
        let n = env.pool_state().loan_count;
        for id in 0..n {
            if let Some(acc) = env.svm.get_account(&env.escrow_addr(&env.loan_addr(id))) {
                if acc.owner == TOKEN_PROGRAM && acc.data.len() == 165 {
                    total += u64::from_le_bytes(acc.data[64..72].try_into().unwrap());
                }
            }
        }
        total
    }

    fn check(env: &Env, actors: &[Actor], supply: u64) {
        let pool = env.pool_state();
        // vault == donated + repaid + recovered - lent
        assert_eq!(
            u128::from(env.balance(&env.vault)),
            u128::from(pool.total_donated)
                + u128::from(pool.total_repaid)
                + u128::from(pool.total_recovered)
                - u128::from(pool.total_lent)
        );
        // tokens are conserved
        assert_eq!(token_balance_sum(env, actors), supply);
        let mut guarantees = vec![0u8; actors.len()];
        let mut active: Vec<Option<Pubkey>> = vec![None; actors.len()];
        for id in 0..pool.loan_count {
            let loan = env.loan(id);
            assert!(loan.repaid <= loan.principal);
            let escrow = env.escrow_addr(&env.loan_addr(id));
            let acc = env.svm.get_account(&escrow);
            let live = acc.as_ref().is_some_and(|a| !a.data.is_empty());
            if loan.status == LoanStatus::Active {
                assert!(live);
                assert_eq!(env.balance(&escrow), loan.escrowed);
                let b = actors
                    .iter()
                    .position(|a| a.key() == loan.borrower)
                    .unwrap();
                let c = actors
                    .iter()
                    .position(|a| a.key() == loan.cosigner)
                    .unwrap();
                assert!(active[b].is_none(), "two active loans for one member");
                active[b] = Some(env.loan_addr(id));
                guarantees[c] += 1;
            } else {
                assert!(!live, "escrow left open after loan closed");
            }
            if loan.status == LoanStatus::Repaid {
                assert_eq!(loan.repaid, loan.principal);
            }
        }
        for (i, a) in actors.iter().enumerate() {
            let m = env.member(a);
            assert_eq!(m.active_loan, active[i]);
            assert_eq!(m.active_guarantees, guarantees[i]);
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 24, ..ProptestConfig::default() })]
        #[test]
        fn invariants_hold(ops in proptest::collection::vec(op(), 1..40)) {
            let mut env = Env::new(2500);
            let actors: Vec<Actor> = (0..ACTORS).map(|_| env.tracked_actor(START)).collect();
            let supply = ACTORS as u64 * START;
            let admin = env.admin.insecure_clone();
            let mut now = T0;
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
                                let _ = env.cosign_loan(&kp, &actors[b], &actors[c]);
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
                    Op::Repay(p, l, n) => {
                        if l < env.pool_state().loan_count {
                            let _ = env.repay(&actors[p], l, n);
                        }
                    }
                    Op::Default(l) => {
                        if l < env.pool_state().loan_count {
                            let kp = actors[0].kp.insecure_clone();
                            let _ = env.mark_default(&kp, l);
                        }
                    }
                    Op::Wait(d) => {
                        now += i64::from(d) * DAY;
                        env.set_time(now);
                    }
                    Op::Update { bps, grace, max_loan, max_g } => {
                        let mut p = params(env.network, bps);
                        p.grace_days = grace;
                        p.max_loan = max_loan;
                        p.max_guarantees_per_member = max_g;
                        let _ = env.update_pool(&admin, p);
                    }
                }
                check(&env, &actors, supply);
            }
        }
    }
}
