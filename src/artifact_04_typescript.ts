import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Solaegis } from "../target/types/solaegis";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("SolAegis Intent Engine Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Solaegis as Program<Solaegis>;

  let mintA: PublicKey;
  let mintB: PublicKey;
  let marketPda: PublicKey;
  let vaultAPda: PublicKey;
  let vaultBPda: PublicKey;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const solver = Keypair.generate();

  let aliceTokenA: PublicKey;
  let aliceTokenB: PublicKey;
  let bobTokenA: PublicKey;
  let bobTokenB: PublicKey;

  const PRECISION = new anchor.BN("1000000000000"); // 1e12

  before(async () => {
    // Fund test actors
    for (const actor of [alice, bob, solver]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create dual mints: Token A (e.g., SOL) and Token B (e.g., USDC)
    mintA = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      9
    );
    mintB = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Derive PDAs
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), mintA.toBuffer(), mintB.toBuffer()],
      program.programId
    );
    [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_a"), marketPda.toBuffer()],
      program.programId
    );
    [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_b"), marketPda.toBuffer()],
      program.programId
    );

    // Setup Token Accounts
    aliceTokenA = await createAccount(provider.connection, alice, mintA, alice.publicKey);
    aliceTokenB = await createAccount(provider.connection, alice, mintB, alice.publicKey);
    bobTokenA = await createAccount(provider.connection, bob, mintA, bob.publicKey);
    bobTokenB = await createAccount(provider.connection, bob, mintB, bob.publicKey);

    // Mint token balances
    // Alice has 10 Token A (10 * 1e9)
    await mintTo(provider.connection, admin, mintA, aliceTokenA, admin, 10_000_000_000);
    // Bob has 2000 Token B (2000 * 1e6)
    await mintTo(provider.connection, admin, mintB, bobTokenB, admin, 2_000_000_000);
  });

  it("Initializes the SolAegis Market PDA and Escrow Vaults", async () => {
    await program.methods
      .initializeMarket(30) // 30 bps = 0.3%
      .accounts({
        admin: admin.publicKey,
        mintA: mintA,
        mintB: mintB,
        market: marketPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const marketAccount = await program.account.market.fetch(marketPda);
    expect(marketAccount.feeBps).to.equal(30);
    expect(marketAccount.mintA.toBase58()).to.equal(mintA.toBase58());
  });

  it("Submits complementary intents into the current slot bucket (Alice AtoB, Bob BtoA)", async () => {
    const currentSlot = await provider.connection.getSlot();
    const bucketSlot = Math.floor(currentSlot / 4) * 4;
    const bucketSlotBuffer = new anchor.BN(bucketSlot).toArrayLike(Buffer, "le", 8);

    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), marketPda.toBuffer(), bucketSlotBuffer],
      program.programId
    );

    const [aliceIntentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), batchPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    const [bobIntentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), batchPda.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );

    // Alice intends to swap 2 Token A for at least 380 Token B (Price >= 190 B/A)
    const amountInAlice = new anchor.BN(2_000_000_000);
    const minOutAlice = new anchor.BN(380_000_000);

    await program.methods
      .depositIntent(amountInAlice, minOutAlice, { atoB: {} })
      .accounts({
        user: alice.publicKey,
        market: marketPda,
        batch: batchPda,
        intent: aliceIntentPda,
        userTokenAccount: aliceTokenA,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    // Bob intends to swap 400 Token B for at least 1.9 Token A (Price <= 210.5 B/A)
    const amountInBob = new anchor.BN(400_000_000);
    const minOutBob = new anchor.BN(1_900_000_000);

    await program.methods
      .depositIntent(amountInBob, minOutBob, { btoA: {} })
      .accounts({
        user: bob.publicKey,
        market: marketPda,
        batch: batchPda,
        intent: bobIntentPda,
        userTokenAccount: bobTokenB,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([bob])
      .rpc();

    const batchAccount = await program.account.batchBucket.fetch(batchPda);
    expect(batchAccount.totalInA.toString()).to.equal(amountInAlice.toString());
    expect(batchAccount.totalInB.toString()).to.equal(amountInBob.toString());
    expect(batchAccount.orderCount).to.equal(2);
  });

  it("Executes CoW Settlement via Solver at Uniform Clearing Price (200 B per A)", async () => {
    // Wait until slot bucket maturation (+4 slots)
    let currentSlot = await provider.connection.getSlot();
    const bucketSlot = Math.floor(currentSlot / 4) * 4;
    const bucketSlotBuffer = new anchor.BN(bucketSlot).toArrayLike(Buffer, "le", 8);

    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), marketPda.toBuffer(), bucketSlotBuffer],
      program.programId
    );

    while (currentSlot < bucketSlot + 5) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      currentSlot = await provider.connection.getSlot();
    }

    // Clearing Price: 200.0 Token B per 1.0 Token A
    // Scaled by 1e12: 200 * 1e12 = 200_000_000_000_000
    const clearingPrice = new anchor.BN("200000000000000");

    await program.methods
      .settleBatchCow(clearingPrice)
      .accounts({
        solver: solver.publicKey,
        market: marketPda,
        batch: batchPda,
      })
      .signers([solver])
      .rpc();

    const settledBatch = await program.account.batchBucket.fetch(batchPda);
    expect(settledBatch.status).to.deep.equal({ settled: {} });
    expect(settledBatch.matchedVolumeA.toString()).to.equal("2000000000");
    expect(settledBatch.matchedVolumeB.toString()).to.equal("400000000");
  });

  it("Allows Alice and Bob to claim matched proceeds with zero slippage violation", async () => {
    const currentSlot = await provider.connection.getSlot();
    const bucketSlot = Math.floor(currentSlot / 4) * 4;
    const bucketSlotBuffer = new anchor.BN(bucketSlot).toArrayLike(Buffer, "le", 8);

    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), marketPda.toBuffer(), bucketSlotBuffer],
      program.programId
    );

    const [aliceIntentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), batchPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    const [bobIntentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), batchPda.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );

    // Alice claims Token B
    await program.methods
      .claimExecution()
      .accounts({
        user: alice.publicKey,
        market: marketPda,
        batch: batchPda,
        intent: aliceIntentPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        userTokenAccountA: aliceTokenA,
        userTokenAccountB: aliceTokenB,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    // Bob claims Token A
    await program.methods
      .claimExecution()
      .accounts({
        user: bob.publicKey,
        market: marketPda,
        batch: batchPda,
        intent: bobIntentPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        userTokenAccountA: bobTokenA,
        userTokenAccountB: bobTokenB,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([bob])
      .rpc();

    const aliceB = await getAccount(provider.connection, aliceTokenB);
    const bobA = await getAccount(provider.connection, bobTokenA);

    // Alice received 400 Token B (400_000_000)
    expect(aliceB.amount.toString()).to.equal("400000000");
    // Bob received 2 Token A (2_000_000_000)
    expect(bobA.amount.toString()).to.equal("2000000000");
  });
});