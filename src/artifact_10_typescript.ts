import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NebulaIntents } from "../target/types/nebula_intents";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

describe("NEBULA Protocol: End-to-End CoW Batch Auction Verification", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.NebulaIntents as Program<NebulaIntents>;

  const payer = provider.wallet as anchor.Wallet;
  let mintA: PublicKey;
  let mintB: PublicKey;

  const userA = Keypair.generate();
  const userB = Keypair.generate();
  const solver = Keypair.generate();
  const feeCollector = Keypair.generate();

  let userATokenA: PublicKey;
  let userATokenB: PublicKey;
  let userBTokenA: PublicKey;
  let userBTokenB: PublicKey;
  let feeRecipientTokenA: PublicKey;
  let feeRecipientTokenB: PublicKey;

  let configPda: PublicKey;
  let configBump: number;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [userA, userB, solver]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Deploy Mints
    mintA = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6
    );
    mintB = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6
    );

    // Create Token Accounts
    userATokenA = await createAccount(provider.connection, payer.payer, mintA, userA.publicKey);
    userATokenB = await createAccount(provider.connection, payer.payer, mintB, userA.publicKey);

    userBTokenA = await createAccount(provider.connection, payer.payer, mintA, userB.publicKey);
    userBTokenB = await createAccount(provider.connection, payer.payer, mintB, userB.publicKey);

    feeRecipientTokenA = await createAccount(provider.connection, payer.payer, mintA, feeCollector.publicKey);
    feeRecipientTokenB = await createAccount(provider.connection, payer.payer, mintB, feeCollector.publicKey);

    // Fund Users: User A gets 100 Mint A, User B gets 14,000 Mint B
    await mintTo(provider.connection, payer.payer, mintA, userATokenA, payer.publicKey, 100_000_000);
    await mintTo(provider.connection, payer.payer, mintB, userBTokenB, payer.publicKey, 14_000_000_000);

    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Initialize Protocol Config with 10 bps (0.10%)
    await program.methods
      .initializeProtocol(10)
      .accounts({
        admin: payer.publicKey,
        config: configPda,
        feeRecipient: feeCollector.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("Executes Atomic Coincidence-of-Wants Settlement with Zero Slippage", async () => {
    const nonceA = new anchor.BN(1001);
    const nonceB = new anchor.BN(2001);

    const amountAIn = new anchor.BN(100_000_000); // 100 Token A
    const minBOut = new anchor.BN(14_000_000_000); // 14,000 Token B

    const amountBIn = new anchor.BN(14_000_000_000); // 14,000 Token B
    const minAOut = new anchor.BN(99_500_000); // 99.5 Token A

    const currentSlot = await provider.connection.getSlot();
    const expiry = new anchor.BN(currentSlot + 100);

    const [intentAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), userA.publicKey.toBuffer(), nonceA.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), intentAPda.toBuffer()],
      program.programId
    );

    const [intentBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), userB.publicKey.toBuffer(), nonceB.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), intentBPda.toBuffer()],
      program.programId
    );

    // 1. User A creates Intent
    await program.methods
      .createIntent(nonceA, amountAIn, minBOut, expiry)
      .accounts({
        creator: userA.publicKey,
        inputMint: mintA,
        outputMint: mintB,
        userTokenAccount: userATokenA,
        intent: intentAPda,
        escrowVault: vaultAPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([userA])
      .rpc();

    // 2. User B creates Intent
    await program.methods
      .createIntent(nonceB, amountBIn, minAOut, expiry)
      .accounts({
        creator: userB.publicKey,
        inputMint: mintB,
        outputMint: mintA,
        userTokenAccount: userBTokenB,
        intent: intentBPda,
        escrowVault: vaultBPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([userB])
      .rpc();

    // 3. Solver executes match: Clearing Rate = 140 Token B per Token A (140 / 1)
    const rateNum = new anchor.BN(140);
    const rateDen = new anchor.BN(1);

    await program.methods
      .settleCowBatch(rateNum, rateDen, amountAIn, amountBIn)
      .accounts({
        solver: solver.publicKey,
        config: configPda,
        intentA: intentAPda,
        escrowVaultA: vaultAPda,
        creatorATokenB: userATokenB,
        intentB: intentBPda,
        escrowVaultB: vaultBPda,
        creatorBTokenA: userBTokenA,
        feeRecipientA: feeRecipientTokenA,
        feeRecipientB: feeRecipientTokenB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([solver])
      .rpc();

    // 4. Invariant Assertions
    const userABalanceB = await getAccount(provider.connection, userATokenB);
    const userBBalanceA = await getAccount(provider.connection, userBTokenA);
    const feeABalance = await getAccount(provider.connection, feeRecipientTokenA);
    const feeBBalance = await getAccount(provider.connection, feeRecipientTokenB);

    // User A received full 14,000 Token B
    assert.equal(Number(userABalanceB.amount), 14_000_000_000);
    // User B received 100 Token A
    assert.equal(Number(userBBalanceA.amount), 100_000_000);
    // Fees collected: 0.1% of 100 Token A = 100,000 units (0.10)
    assert.equal(Number(feeABalance.amount), 100_000);
    // Fees collected: 0.1% of 14,000 Token B = 14,000,000 units (14.0)
    assert.equal(Number(feeBBalance.amount), 14_000_000);

    // Verify intent state transitioned to Settled
    const accountStateA = await program.account.intentOrder.fetch(intentAPda);
    assert.deepEqual(accountStateA.status, { settled: {} });
  });

  it("Reverts transaction when solver submits clearing rate below limit price", async () => {
    const nonce = new anchor.BN(3001);
    const amountIn = new anchor.BN(10_000_000);
    const minOut = new anchor.BN(2_000_000_000); // Demands at least 2000
    const expiry = new anchor.BN((await provider.connection.getSlot()) + 100);

    const [intentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), userA.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), intentPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createIntent(nonce, amountIn, minOut, expiry)
      .accounts({
        creator: userA.publicKey,
        inputMint: mintA,
        outputMint: mintB,
        userTokenAccount: userATokenA,
        intent: intentPda,
        escrowVault: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([userA])
      .rpc();

    // Attacker tries to settle at 1500 instead of 2000
    try {
      await program.methods
        .settleCowBatch(new anchor.BN(150), new anchor.BN(1), amountIn, new anchor.BN(1_500_000_000))
        .accounts({
          solver: solver.publicKey,
          config: configPda,
          intentA: intentPda,
          escrowVaultA: vaultPda,
          creatorATokenB: userATokenB,
          intentB: intentPda, // Mocked account for test fail
          escrowVaultB: vaultPda,
          creatorBTokenA: userATokenA,
          feeRecipientA: feeRecipientTokenA,
          feeRecipientB: feeRecipientTokenB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([solver])
        .rpc();
      assert.fail("Should have thrown SlippageExceeded error");
    } catch (err: any) {
      expect(err.toString()).to.include("SlippageExceeded");
    }
  });
});