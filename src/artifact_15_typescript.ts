import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Khora } from "../target/types/khora";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { Keypair, SystemProgram, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

describe("Khora: Intent Engine & OFA Settlement Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Khora as Program<Khora>;

  let mintA: PublicKey;
  let mintB: PublicKey;

  const admin = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const solver = Keypair.generate();
  const treasury = Keypair.generate();

  let aliceTokenA: PublicKey;
  let aliceTokenB: PublicKey;
  let bobTokenA: PublicKey;
  let bobTokenB: PublicKey;

  const nonceAlice = new BN(101);
  const nonceBob = new BN(202);

  before(async () => {
    // Fund test actors
    for (const actor of [admin, alice, bob, solver]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * LAMPORTS_PER_SOL);
      const latestBlockHash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: sig,
      });
    }

    // Create dual test token mints (e.g., SOL mock & USDC mock)
    mintA = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    mintB = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Initialize user accounts
    aliceTokenA = await createAccount(provider.connection, alice, mintA, alice.publicKey);
    aliceTokenB = await createAccount(provider.connection, alice, mintB, alice.publicKey);

    bobTokenA = await createAccount(provider.connection, bob, mintA, bob.publicKey);
    bobTokenB = await createAccount(provider.connection, bob, mintB, bob.publicKey);

    // Mint token balances:
    // Alice has 1,000 Mint A (e.g. SOL)
    // Bob has 200,000 Mint B (e.g. USDC)
    await mintTo(provider.connection, admin, mintA, aliceTokenA, admin, 1_000_000_000);
    await mintTo(provider.connection, admin, mintB, bobTokenB, admin, 200_000_000_000);
  });

  it("1. Initializes global protocol config successfully", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    await program.methods
      .initializeConfig(20, 8000) // 20 bps fee (0.2%), 80% user rebate
      .accounts({
        config: configPda,
        authority: admin.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.feeBasisPoints).to.equal(20);
    expect(configAccount.rebateShareBps).to.equal(8000);
  });

  it("2. Escrows Alice's sell intent (Sell 100 A for min 20,000 B)", async () => {
    const [intentAlice] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), alice.publicKey.toBuffer(), nonceAlice.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [escrowVaultAlice] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), intentAlice.toBuffer()],
      program.programId
    );

    const amountIn = new BN(100_000_000); // 100 units of A
    const minAmountOut = new BN(20_000_000_000); // Min 20,000 units of B
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600); // +1 hour

    await program.methods
      .createIntent(nonceAlice, amountIn, minAmountOut, deadline)
      .accounts({
        intent: intentAlice,
        escrowVault: escrowVaultAlice,
        tokenInMint: mintA,
        tokenOutMint: mintB,
        userTokenIn: aliceTokenA,
        creator: alice.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([alice])
      .rpc();

    const intentAcc = await program.account.intentOrder.fetch(intentAlice);
    expect(intentAcc.amountIn.toString()).to.equal(amountIn.toString());
    expect(intentAcc.remainingAmountIn.toString()).to.equal(amountIn.toString());

    const vaultBalance = await getAccount(provider.connection, escrowVaultAlice);
    expect(vaultBalance.amount.toString()).to.equal(amountIn.toString());
  });

  it("3. Escrows Bob's counter intent (Sell 20,000 B for min 99 A)", async () => {
    const [intentBob] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), bob.publicKey.toBuffer(), nonceBob.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [escrowVaultBob] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), intentBob.toBuffer()],
      program.programId
    );

    const amountIn = new BN(20_000_000_000); // 20,000 units of B
    const minAmountOut = new BN(99_000_000); // Min 99 units of A (giving 1 unit surplus)
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    await program.methods
      .createIntent(nonceBob, amountIn, minAmountOut, deadline)
      .accounts({
        intent: intentBob,
        escrowVault: escrowVaultBob,
        tokenInMint: mintB,
        tokenOutMint: mintA,
        userTokenIn: bobTokenB,
        creator: bob.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([bob])
      .rpc();

    const intentAcc = await program.account.intentOrder.fetch(intentBob);
    expect(intentAcc.amountIn.toString()).to.equal(amountIn.toString());
  });

  it("4. Fails settlement if slippage invariant is broken", async () => {
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    const [intentAlice] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), alice.publicKey.toBuffer(), nonceAlice.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [escrowAlice] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), intentAlice.toBuffer()], program.programId);

    const [intentBob] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), bob.publicKey.toBuffer(), nonceBob.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [escrowBob] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), intentBob.toBuffer()], program.programId);

    // Attempting to fill Alice with only 10,000 B (she requires 20,000 B)
    try {
      await program.methods
        .settleCowPair(new BN(100_000_000), new BN(10_000_000_000))
        .accounts({
          config: configPda,
          solver: solver.publicKey,
          intentA: intentAlice,
          escrowVaultA: escrowAlice,
          userAOutAccount: aliceTokenB,
          userAAuthority: alice.publicKey,
          intentB: intentBob,
          escrowVaultB: escrowBob,
          userBOutAccount: bobTokenA,
          userBAuthority: bob.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([solver])
        .rpc();
      assert.fail("Settlement should have failed with SlippageExceeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }
  });

  it("5. Atomically clears counter-intents via CoW settlement (0 Slippage & MEV Free)", async () => {
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    const [intentAlice] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), alice.publicKey.toBuffer(), nonceAlice.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [escrowAlice] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), intentAlice.toBuffer()], program.programId);

    const [intentBob] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), bob.publicKey.toBuffer(), nonceBob.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [escrowBob] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), intentBob.toBuffer()], program.programId);

    const fillA = new BN(100_000_000); // 100 Token A
    const fillB = new BN(20_000_000_000); // 20,000 Token B

    const tx = await program.methods
      .settleCowPair(fillA, fillB)
      .accounts({
        config: configPda,
        solver: solver.publicKey,
        intentA: intentAlice,
        escrowVaultA: escrowAlice,
        userAOutAccount: aliceTokenB,
        userAAuthority: alice.publicKey,
        intentB: intentBob,
        escrowVaultB: escrowBob,
        userBOutAccount: bobTokenA,
        userBAuthority: bob.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([solver])
      .rpc();

    console.log("CoW Settlement Tx Sig:", tx);

    // Verify balances
    const aliceB = await getAccount(provider.connection, aliceTokenB);
    const bobA = await getAccount(provider.connection, bobTokenA);

    expect(aliceB.amount.toString()).to.equal("20000000000");
    expect(bobA.amount.toString()).to.equal("100000000");

    // Verify that escrow vault accounts were closed and refunded
    const closedVaultA = await provider.connection.getAccountInfo(escrowAlice);
    const closedVaultB = await provider.connection.getAccountInfo(escrowBob);
    expect(closedVaultA).to.be.null;
    expect(closedVaultB).to.be.null;
  });
});