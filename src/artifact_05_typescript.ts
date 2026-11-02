import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Aetherflow } from "../target/types/aetherflow";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("aetherflow-lifecycle-e2e", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Aetherflow as Program<Aetherflow>;

  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  const solver = Keypair.generate();
  const maker = Keypair.generate();

  let inputMint: PublicKey;
  let outputMint: PublicKey;

  let makerInputAta: PublicKey;
  let makerOutputAta: PublicKey;
  let solverInputAta: PublicKey;
  let solverOutputAta: PublicKey;
  let treasuryOutputAta: PublicKey;

  let configPda: PublicKey;
  let solverRecordPda: PublicKey;

  before(async () => {
    // 1. Airdrop SOL
    for (const kp of [admin, solver, maker]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // 2. Create Mints
    inputMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );
    outputMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // 3. Create ATAs
    makerInputAta = await createAccount(
      provider.connection,
      maker,
      inputMint,
      maker.publicKey
    );
    makerOutputAta = await createAccount(
      provider.connection,
      maker,
      outputMint,
      maker.publicKey
    );

    solverInputAta = await createAccount(
      provider.connection,
      solver,
      inputMint,
      solver.publicKey
    );
    solverOutputAta = await createAccount(
      provider.connection,
      solver,
      outputMint,
      solver.publicKey
    );

    treasuryOutputAta = await createAccount(
      provider.connection,
      admin,
      outputMint,
      treasury.publicKey
    );

    // 4. Fund Maker with Input Mint (1,000 USDC)
    await mintTo(
      provider.connection,
      admin,
      inputMint,
      makerInputAta,
      admin.publicKey,
      1_000_000_000
    );

    // 5. Fund Solver with Output Mint (5,000 Token B)
    await mintTo(
      provider.connection,
      admin,
      outputMint,
      solverOutputAta,
      admin.publicKey,
      5_000_000_000
    );

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [solverRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("solver"), solver.publicKey.toBuffer()],
      program.programId
    );
  });

  it("Initializes protocol config with 80% user surplus rebate", async () => {
    await program.methods
      .initialize(50, 8000) // 50 bps protocol fee, 80% user surplus rebate
      .accounts({
        config: configPda,
        authority: admin.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.config.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.userSurplusShareBps).to.equal(8000);
  });

  it("Registers and bonds a Solver with 1 SOL stake", async () => {
    await program.methods
      .registerSolver(new anchor.BN(1 * LAMPORTS_PER_SOL))
      .accounts({
        solverRecord: solverRecordPda,
        solver: solver.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([solver])
      .rpc();

    const record = await program.account.solverRecord.fetch(solverRecordPda);
    expect(record.isActive).to.be.true;
    expect(record.bondedAmount.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);
  });

  it("Trader creates an intent with escrow vault", async () => {
    const nonce = new anchor.BN(1001);
    const amountIn = new anchor.BN(500_000_000); // 500 tokens
    const minAmountOut = new anchor.BN(450_000_000); // Expect at least 450 tokens
    const currentSlot = await provider.connection.getSlot();
    const expirySlot = new anchor.BN(currentSlot + 100);

    const [intentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), maker.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), intentPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createIntent(nonce, amountIn, minAmountOut, expirySlot)
      .accounts({
        intent: intentPda,
        maker: maker.publicKey,
        inputMint,
        outputMint,
        makerInputAta,
        escrowVault: escrowVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([maker])
      .rpc();

    const vaultTokenAcc = await getAccount(provider.connection, escrowVaultPda);
    expect(Number(vaultTokenAcc.amount)).to.equal(500_000_000);

    const fetchedIntent = await program.account.intentAccount.fetch(intentPda);
    expect(fetchedIntent.maker.toBase58()).to.equal(maker.publicKey.toBase58());
  });

  it("Solver settles intent with positive surplus and rebates user 80%", async () => {
    const nonce = new anchor.BN(1001);
    const [intentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), maker.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), intentPda.toBuffer()],
      program.programId
    );

    // Minimum expected was 450. Solver provides 500 (Surplus = 50 tokens)
    // User surplus rebate = 80% of 50 = 40 tokens -> User should receive 490 total
    // Treasury receives 5% of 50 = 2.5 tokens (integer 2 tokens)
    const amountOutProvided = new anchor.BN(500_000_000);

    const makerBefore = await getAccount(provider.connection, makerOutputAta);
    expect(Number(makerBefore.amount)).to.equal(0);

    await program.methods
      .executeIntent(amountOutProvided)
      .accounts({
        config: configPda,
        intent: intentPda,
        solverRecord: solverRecordPda,
        solver: solver.publicKey,
        escrowVault: escrowVaultPda,
        solverInputAta,
        solverOutputAta,
        makerOutputAta,
        treasuryOutputAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([solver])
      .rpc();

    const makerAfter = await getAccount(provider.connection, makerOutputAta);
    const solverInputAfter = await getAccount(provider.connection, solverInputAta);
    const intentAfter = await program.account.intentAccount.fetch(intentPda);

    // 450 + 40 = 490 Token B received by user
    expect(Number(makerAfter.amount)).to.equal(490_000_000);
    // Solver received escrowed 500 Token A
    expect(Number(solverInputAfter.amount)).to.equal(500_000_000);
    // Status should be set to Filled
    expect(intentAfter.status).to.deep.equal({ filled: {} });
  });

  it("Rejects double execution of already settled intent", async () => {
    const nonce = new anchor.BN(1001);
    const [intentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), maker.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), intentPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .executeIntent(new anchor.BN(500_000_000))
        .accounts({
          config: configPda,
          intent: intentPda,
          solverRecord: solverRecordPda,
          solver: solver.publicKey,
          escrowVault: escrowVaultPda,
          solverInputAta,
          solverOutputAta,
          makerOutputAta,
          treasuryOutputAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([solver])
        .rpc();
      expect.fail("Should have failed with IntentNotActive");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("IntentNotActive");
    }
  });
});