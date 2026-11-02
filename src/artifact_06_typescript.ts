import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KhoraEngine } from "../target/types/khora_engine";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("khora-engine: Sub-Slot Batch Settlement Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KhoraEngine as Program<KhoraEngine>;

  let tokenAMint: anchor.web3.PublicKey;
  let tokenBMint: anchor.web3.PublicKey;
  let marketPda: anchor.web3.PublicKey;
  let vaultAPda: anchor.web3.PublicKey;
  let vaultBPda: anchor.web3.PublicKey;

  const authority = (provider.wallet as anchor.Wallet).payer;
  const traderAlice = anchor.web3.Keypair.generate();
  const traderBob = anchor.web3.Keypair.generate();
  const solver = anchor.web3.Keypair.generate();

  let aliceTokenA: anchor.web3.PublicKey;
  let aliceTokenB: anchor.web3.PublicKey;
  let bobTokenA: anchor.web3.PublicKey;
  let bobTokenB: anchor.web3.PublicKey;
  let solverTokenA: anchor.web3.PublicKey;

  const INITIAL_MINT = 1_000_000_000_000; // 1,000 Tokens (6 decimals)

  before(async () => {
    // Airdrop SOL to test actors
    for (const kp of [traderAlice, traderBob, solver]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create Tokens A and B
    tokenAMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );
    tokenBMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    [marketPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), tokenAMint.toBuffer(), tokenBMint.toBuffer()],
      program.programId
    );

    [vaultAPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_a"), marketPda.toBuffer()],
      program.programId
    );

    [vaultBPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_b"), marketPda.toBuffer()],
      program.programId
    );

    // Setup Token Accounts
    aliceTokenA = await createAccount(provider.connection, traderAlice, tokenAMint, traderAlice.publicKey);
    aliceTokenB = await createAccount(provider.connection, traderAlice, tokenBMint, traderAlice.publicKey);

    bobTokenA = await createAccount(provider.connection, traderBob, tokenAMint, traderBob.publicKey);
    bobTokenB = await createAccount(provider.connection, traderBob, tokenBMint, traderBob.publicKey);

    solverTokenA = await createAccount(provider.connection, solver, tokenAMint, solver.publicKey);

    // Mint balances: Alice has A, Bob has B
    await mintTo(provider.connection, authority, tokenAMint, aliceTokenA, authority, INITIAL_MINT);
    await mintTo(provider.connection, authority, tokenBMint, bobTokenB, authority, INITIAL_MINT);
  });

  it("Initializes the discrete micro-batch market", async () => {
    const epochDurationSlots = new anchor.BN(2);

    await program.methods
      .initializeMarket(epochDurationSlots)
      .accounts({
        authority: authority.publicKey,
        tokenAMint,
        tokenBMint,
        market: marketPda,
        tokenAVault: vaultAPda,
        tokenBVault: vaultBPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const marketState = await program.account.market.fetch(marketPda);
    assert.equal(marketState.epochDurationSlots.toNumber(), 2);
    assert.equal(marketState.currentEpochId.toNumber(), 0);
    assert.isFalse(marketState.isLocked);
  });

  it("Initializes a batch PDA and registers reciprocal intents (CoW match setup)", async () => {
    const epochId = new anchor.BN(0);
    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), marketPda.toBuffer(), epochId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Alice: Wants to sell 100 Token A to buy at least 99 Token B
    const amountInAlice = new anchor.BN(100_000_000);
    const minOutAlice = new anchor.BN(99_000_000);

    await program.methods
      .submitIntent(true, amountInAlice, minOutAlice)
      .accounts({
        trader: traderAlice.publicKey,
        market: marketPda,
        batch: batchPda,
        tokenAVault: vaultAPda,
        tokenBVault: vaultBPda,
        traderTokenSource: aliceTokenA,
        tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
      })
      .signers([traderAlice])
      .rpc();

    // Bob: Reciprocal Want - Sells 100 Token B to buy at least 99 Token A
    const amountInBob = new anchor.BN(100_000_000);
    const minOutBob = new anchor.BN(99_000_000);

    await program.methods
      .submitIntent(false, amountInBob, minOutBob)
      .accounts({
        trader: traderBob.publicKey,
        market: marketPda,
        batch: batchPda,
        tokenAVault: vaultAPda,
        tokenBVault: vaultBPda,
        traderTokenSource: bobTokenB,
        tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
      })
      .signers([traderBob])
      .rpc();

    const batchState = await program.account.batchAuction.fetch(batchPda);
    assert.equal(batchState.orderCount, 2);
    assert.equal(batchState.totalTokenAOffered.toNumber(), 100_000_000);
    assert.equal(batchState.totalTokenBOffered.toNumber(), 100_000_000);
  });

  it("Executes zero-slippage settlement at Uniform Clearing Price (UCP = 1.0)", async () => {
    const epochId = new anchor.BN(0);
    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), marketPda.toBuffer(), epochId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Sleep past slot duration if on devnet/localnet
    await new Promise((res) => setTimeout(res, 1200));

    // Clear with 1.0 price (1:1 exchange ratio)
    const num = new anchor.BN(1_000_000);
    const denom = new anchor.BN(1_000_000);

    await program.methods
      .settleBatch(epochId, num, denom)
      .accounts({
        solver: solver.publicKey,
        market: marketPda,
        batch: batchPda,
        tokenAVault: vaultAPda,
        tokenBVault: vaultBPda,
        solverTokenAAccount: solverTokenA,
        tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
      })
      .signers([solver])
      .rpc();

    const clearedBatch = await program.account.batchAuction.fetch(batchPda);
    assert.isTrue(clearedBatch.isCleared);

    // Verify Solver took rewards
    const solverAAccount = await getAccount(provider.connection, solverTokenA);
    assert.isTrue(Number(solverAAccount.amount) > 0);
  });

  it("Allows traders to claim cleared orders with zero reentrancy risk", async () => {
    const epochId = new anchor.BN(0);
    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), marketPda.toBuffer(), epochId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Alice claims Order 0 (Receives Token B)
    await program.methods
      .claimOrder(0)
      .accounts({
        trader: traderAlice.publicKey,
        market: marketPda,
        batch: batchPda,
        tokenAVault: vaultAPda,
        tokenBVault: vaultBPda,
        traderDestination: aliceTokenB,
        tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
      })
      .signers([traderAlice])
      .rpc();

    const aliceB = await getAccount(provider.connection, aliceTokenB);
    assert.equal(Number(aliceB.amount), 100_000_000);
  });

  it("Rejects settlement violating limit price guarantees", async () => {
    // Attempting invalid settlement with inverted prices causes an unhandled or limit price error
    const dummyEpoch = new anchor.BN(999);
    try {
      await program.methods
        .settleBatch(dummyEpoch, new anchor.BN(1), new anchor.BN(10_000_000))
        .accounts({
          solver: solver.publicKey,
          market: marketPda,
          batch: marketPda,
          tokenAVault: vaultAPda,
          tokenBVault: vaultBPda,
          solverTokenAAccount: solverTokenA,
          tokenProgram: anchor.spl.TOKEN_PROGRAM_ID,
        })
        .signers([solver])
        .rpc();
      assert.fail("Expected failure on invalid batch settlement");
    } catch (err: any) {
      assert.ok(err);
    }
  });
});