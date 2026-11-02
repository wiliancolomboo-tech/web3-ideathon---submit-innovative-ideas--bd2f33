import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Aetheris } from "../target/types/aetheris";
import {
  createMint,
  createAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("aetheris-batch-amm", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Aetheris as Program<Aetheris>;
  const wallet = provider.wallet as anchor.Wallet;

  let mintA: PublicKey;
  let mintB: PublicKey;
  let poolPda: PublicKey;
  let vaultAPda: PublicKey;
  let vaultBPda: PublicKey;
  let epoch1Pda: PublicKey;
  let epoch2Pda: PublicKey;

  let alice = Keypair.generate();
  let bob = Keypair.generate();
  let aliceTokenB: PublicKey;
  let bobTokenA: PublicKey;
  let aliceDestTokenA: PublicKey;
  let bobDestTokenB: PublicKey;

  const POOL_SEED = Buffer.from("aetheris_pool");
  const EPOCH_SEED = Buffer.from("epoch_state");
  const INTENT_SEED = Buffer.from("swap_intent");
  const VAULT_A_SEED = Buffer.from("vault_a");
  const VAULT_B_SEED = Buffer.from("vault_b");

  const saltAlice = crypto.randomBytes(32);
  const saltBob = crypto.randomBytes(32);

  const aliceAmountInB = new BN(100_000_000); // 100 Token B
  const aliceMinOutA = new BN(45_000_000);   // Min 45 Token A

  const bobAmountInA = new BN(50_000_000);    // 50 Token A
  const bobMinOutB = new BN(90_000_000);     // Min 90 Token B

  function computeCommitmentHash(
    user: PublicKey,
    amountIn: BN,
    minOut: BN,
    salt: Buffer
  ): Buffer {
    const data = Buffer.concat([
      user.toBuffer(),
      amountIn.toArrayLike(Buffer, "le", 8),
      minOut.toArrayLike(Buffer, "le", 8),
      salt,
    ]);
    return crypto.createHash("sha256").update(data).digest();
  }

  before(async () => {
    // Airdrop SOL
    for (const kp of [alice, bob]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create Token-2022 Mints
    mintA = await createMint(
      provider.connection,
      wallet.payer,
      wallet.publicKey,
      null,
      6,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    mintB = await createMint(
      provider.connection,
      wallet.payer,
      wallet.publicKey,
      null,
      6,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Derive PDAs
    [poolPda] = PublicKey.findProgramAddressSync(
      [POOL_SEED, mintA.toBuffer(), mintB.toBuffer()],
      program.programId
    );
    [vaultAPda] = PublicKey.findProgramAddressSync(
      [VAULT_A_SEED, poolPda.toBuffer()],
      program.programId
    );
    [vaultBPda] = PublicKey.findProgramAddressSync(
      [VAULT_B_SEED, poolPda.toBuffer()],
      program.programId
    );

    const epoch1Buffer = new BN(1).toArrayLike(Buffer, "le", 8);
    [epoch1Pda] = PublicKey.findProgramAddressSync(
      [EPOCH_SEED, poolPda.toBuffer(), epoch1Buffer],
      program.programId
    );

    const epoch2Buffer = new BN(2).toArrayLike(Buffer, "le", 8);
    [epoch2Pda] = PublicKey.findProgramAddressSync(
      [EPOCH_SEED, poolPda.toBuffer(), epoch2Buffer],
      program.programId
    );

    // Setup Token Accounts
    aliceTokenB = await createAccount(provider.connection, alice, mintB, alice.publicKey, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    aliceDestTokenA = await createAccount(provider.connection, alice, mintA, alice.publicKey, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    bobTokenA = await createAccount(provider.connection, bob, mintA, bob.publicKey, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    bobDestTokenB = await createAccount(provider.connection, bob, mintB, bob.publicKey, undefined, undefined, TOKEN_2022_PROGRAM_ID);

    // Mint balances
    await mintTo(provider.connection, wallet.payer, mintB, aliceTokenB, wallet.payer, 500_000_000, [], undefined, TOKEN_2022_PROGRAM_ID);
    await mintTo(provider.connection, wallet.payer, mintA, bobTokenA, wallet.payer, 500_000_000, [], undefined, TOKEN_2022_PROGRAM_ID);
  });

  it("Initializes the Aetheris Batch AMM Pool", async () => {
    const epochDurationSlots = new BN(3); // 3 slots for rapid testing
    const feeBps = 30; // 0.3%

    await program.methods
      .initializePool(epochDurationSlots, feeBps)
      .accounts({
        authority: wallet.publicKey,
        tokenAMint: mintA,
        tokenBMint: mintB,
        pool: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        epochState: epoch1Pda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const pool = await program.account.poolState.fetch(poolPda);
    expect(pool.currentEpoch.toNumber()).to.equal(1);
    expect(pool.feeBps).to.equal(30);
  });

  it("Deposits initial liquidity reserves", async () => {
    const userA = await createAccount(provider.connection, wallet.payer, mintA, wallet.publicKey, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    const userB = await createAccount(provider.connection, wallet.payer, mintB, wallet.publicKey, undefined, undefined, TOKEN_2022_PROGRAM_ID);

    await mintTo(provider.connection, wallet.payer, mintA, userA, wallet.payer, 1_000_000_000, [], undefined, TOKEN_2022_PROGRAM_ID);
    await mintTo(provider.connection, wallet.payer, mintB, userB, wallet.payer, 2_000_000_000, [], undefined, TOKEN_2022_PROGRAM_ID);

    await program.methods
      .depositInitialLiquidity(new BN(1_000_000_000), new BN(2_000_000_000))
      .accounts({
        authority: wallet.publicKey,
        pool: poolPda,
        tokenAMint: mintA,
        tokenBMint: mintB,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        userTokenA: userA,
        userTokenB: userB,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const pool = await program.account.poolState.fetch(poolPda);
    expect(pool.reserveA.toNumber()).to.equal(1_000_000_000);
    expect(pool.reserveB.toNumber()).to.equal(2_000_000_000);
  });

  it("Submits committed intents from Alice (Buyer) and Bob (Seller)", async () => {
    const epochId = new BN(1);
    const epochBuffer = epochId.toArrayLike(Buffer, "le", 8);

    // Alice Commits: Buying Token A with 100 Token B
    const aliceHash = computeCommitmentHash(alice.publicKey, aliceAmountInB, aliceMinOutA, saltAlice);
    const [aliceIntentPda] = PublicKey.findProgramAddressSync(
      [INTENT_SEED, epochBuffer, alice.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitIntent(epochId, Array.from(aliceHash), aliceAmountInB, true)
      .accounts({
        user: alice.publicKey,
        pool: poolPda,
        tokenAMint: mintA,
        tokenBMint: mintB,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        epochState: epoch1Pda,
        swapIntent: aliceIntentPda,
        userTokenAccount: aliceTokenB,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    // Bob Commits: Selling 50 Token A for Token B
    const bobHash = computeCommitmentHash(bob.publicKey, bobAmountInA, bobMinOutB, saltBob);
    const [bobIntentPda] = PublicKey.findProgramAddressSync(
      [INTENT_SEED, epochBuffer, bob.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitIntent(epochId, Array.from(bobHash), bobAmountInA, false)
      .accounts({
        user: bob.publicKey,
        pool: poolPda,
        tokenAMint: mintA,
        tokenBMint: mintB,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        epochState: epoch1Pda,
        swapIntent: bobIntentPda,
        userTokenAccount: bobTokenA,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([bob])
      .rpc();

    const epochState = await program.account.epochState.fetch(epoch1Pda);
    expect(epochState.totalInputB.toNumber()).to.equal(100_000_000);
    expect(epochState.totalInputA.toNumber()).to.equal(50_000_000);
  });

  it("Waits for commit window expiry and Keeper resolves the batch", async () => {
    // Advance slots
    await new Promise((resolve) => setTimeout(resolve, 3000));

    await program.methods
      .resolveBatch(new BN(1))
      .accounts({
        keeper: wallet.publicKey,
        pool: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        epochState: epoch1Pda,
        nextEpochState: epoch2Pda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const epoch1 = await program.account.epochState.fetch(epoch1Pda);
    expect(epoch1.status).to.deep.equal({ resolved: {} });
    expect(epoch1.clearingPriceNumerator.gt(new BN(0))).to.be.true;
  });

  it("Alice reveals commitment parameters and claims Token A proceeds", async () => {
    const epochId = new BN(1);
    const epochBuffer = epochId.toArrayLike(Buffer, "le", 8);

    const [aliceIntentPda] = PublicKey.findProgramAddressSync(
      [INTENT_SEED, epochBuffer, alice.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimProceeds(aliceMinOutA, Array.from(saltAlice))
      .accounts({
        user: alice.publicKey,
        pool: poolPda,
        tokenAMint: mintA,
        tokenBMint: mintB,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        epochState: epoch1Pda,
        swapIntent: aliceIntentPda,
        userDestination: aliceDestTokenA,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    const intent = await program.account.swapIntent.fetch(aliceIntentPda);
    expect(intent.settled).to.be.true;
  });
});