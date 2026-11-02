import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ZephyrEngine } from "../target/types/zephyr_engine";
import { 
  TOKEN_PROGRAM_ID, 
  createMint, 
  createAccount, 
  mintTo, 
  getAccount 
} from "@solana/spl-token";
import { assert, expect } from "chai";

describe("zephyr-engine integration verification suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZephyrEngine as Program<ZephyrEngine>;

  let admin = anchor.web3.Keypair.generate();
  let userAlice = anchor.web3.Keypair.generate();
  let userBob = anchor.web3.Keypair.generate();
  let solver = anchor.web3.Keypair.generate();

  let mintA: anchor.web3.Pubkey;
  let mintB: anchor.web3.Pubkey;

  let aliceAccountA: anchor.web3.Pubkey;
  let aliceAccountB: anchor.web3.Pubkey;
  let bobAccountB: anchor.web3.Pubkey;
  let bobAccountA: anchor.web3.Pubkey;
  let solverAccountA: anchor.web3.Pubkey;
  let solverAccountB: anchor.web3.Pubkey;

  let vaultA: anchor.web3.Pubkey;
  let vaultB: anchor.web3.Pubkey;
  let vaultAuth: anchor.web3.Pubkey;

  let configPda: anchor.web3.Pubkey;
  const batchId = new anchor.BN(1001);

  before(async () => {
    // AirDrop SOL to test participants
    for (const kp of [admin, userAlice, userBob, solver]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize Mints
    mintA = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    mintB = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Derive Vault Authority PDA
    [vaultAuth] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), mintA.toBuffer()],
      program.programId
    );

    // Setup Token Accounts
    aliceAccountA = await createAccount(provider.connection, userAlice, mintA, userAlice.publicKey);
    aliceAccountB = await createAccount(provider.connection, userAlice, mintB, userAlice.publicKey);
    bobAccountB = await createAccount(provider.connection, userBob, mintB, userBob.publicKey);
    bobAccountA = await createAccount(provider.connection, userBob, mintA, userBob.publicKey);
    solverAccountA = await createAccount(provider.connection, solver, mintA, solver.publicKey);
    solverAccountB = await createAccount(provider.connection, solver, mintB, solver.publicKey);

    vaultA = await createAccount(provider.connection, admin, mintA, vaultAuth);
    vaultB = await createAccount(provider.connection, admin, mintB, vaultAuth);

    // Mint test inventory
    await mintTo(provider.connection, admin, mintA, aliceAccountA, admin, 100_000_000); // 100 A
    await mintTo(provider.connection, admin, mintB, bobAccountB, admin, 200_000_000);   // 200 B
    await mintTo(provider.connection, admin, mintA, solverAccountA, admin, 500_000_000);
    await mintTo(provider.connection, admin, mintB, solverAccountB, admin, 500_000_000);

    [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      program.programId
    );
  });

  it("1. Initializes the Global Engine configuration", async () => {
    const durationSlots = new anchor.BN(4); // short slot auction window
    const feeBps = 30; // 0.30%

    await program.methods
      .initializeEngine(durationSlots, feeBps)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const config = await program.account.globalConfig.fetch(configPda);
    assert.equal(config.feeBps, 30);
    assert.ok(config.admin.equals(admin.publicKey));
  });

  it("2. Opens a discrete Batch PDA", async () => {
    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), mintA.toBuffer(), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .openBatch(batchId)
      .accounts({
        batch: batchPda,
        tokenAMint: mintA,
        tokenBMint: mintB,
        config: configPda,
        payer: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const batch = await program.account.batchAuction.fetch(batchPda);
    assert.equal(batch.batchId.toNumber(), 1001);
    assert.equal(batch.orderCount, 0);
  });

  it("3. Aggregates two opposing user intents without front-running", async () => {
    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), mintA.toBuffer(), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [aliceIntent] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), batchPda.toBuffer(), userAlice.publicKey.toBuffer()],
      program.programId
    );

    // Alice wants to sell 50 Token A for at least 95 Token B (Price ~ 1.90)
    await program.methods
      .submitIntent(batchId, new anchor.BN(50_000_000), new anchor.BN(95_000_000), { aToB: {} })
      .accounts({
        batch: batchPda,
        userIntent: aliceIntent,
        user: userAlice.publicKey,
        userTokenAccount: aliceAccountA,
        vaultA: vaultA,
        vaultB: vaultB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userAlice])
      .rpc();

    const [bobIntent] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), batchPda.toBuffer(), userBob.publicKey.toBuffer()],
      program.programId
    );

    // Bob wants to sell 100 Token B for at least 48 Token A (Price ~ 2.08)
    await program.methods
      .submitIntent(batchId, new anchor.BN(100_000_000), new anchor.BN(48_000_000), { bToA: {} })
      .accounts({
        batch: batchPda,
        userIntent: bobIntent,
        user: userBob.publicKey,
        userTokenAccount: bobAccountB,
        vaultA: vaultA,
        vaultB: vaultB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userBob])
      .rpc();

    const batch = await program.account.batchAuction.fetch(batchPda);
    assert.equal(batch.orderCount, 2);
    assert.equal(batch.totalInA.toNumber(), 50_000_000);
    assert.equal(batch.totalInB.toNumber(), 100_000_000);
  });

  it("4. Rejects settlement before auction duration slot elapses", async () => {
    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), mintA.toBuffer(), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const clearingPrice = new anchor.BN(2_000_000_000); // 2.0 B per A

    try {
      await program.methods
        .settleBatchAuction(clearingPrice, new anchor.BN(0), new anchor.BN(0))
        .accounts({
          batch: batchPda,
          config: configPda,
          solver: solver.publicKey,
          solverTokenA: solverAccountA,
          solverTokenB: solverAccountB,
          vaultA: vaultA,
          vaultB: vaultB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([solver])
        .rpc();
      assert.fail("Settlement should have failed due to active slot duration");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("BatchStillActive");
    }
  });

  it("5. Settles discrete batch with Uniform Price & executes JIT balance fill", async () => {
    // Fast forward slots by submitting dummy transactions or waiting
    await new Promise((resolve) => setTimeout(resolve, 3500));

    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), mintA.toBuffer(), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Uniform Clearing Price: 2.000000000 (2.0 B per A)
    // Alice supplied 50 A (worth 100 B). Bob supplied 100 B (worth 50 A).
    // The batch is completely balanced (zero leftover imbalance).
    const clearingPrice = new anchor.BN(2_000_000_000);

    await program.methods
      .settleBatchAuction(clearingPrice, new anchor.BN(0), new anchor.BN(0))
      .accounts({
        batch: batchPda,
        config: configPda,
        solver: solver.publicKey,
        solverTokenA: solverAccountA,
        solverTokenB: solverAccountB,
        vaultA: vaultA,
        vaultB: vaultB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([solver])
      .rpc();

    const batch = await program.account.batchAuction.fetch(batchPda);
    assert.deepEqual(batch.state, { settled: {} });
    assert.equal(batch.clearingPriceScaled.toString(), clearingPrice.toString());
  });

  it("6. Disburses atomic fills to users at Uniform Clearing Price without slippage", async () => {
    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), mintA.toBuffer(), batchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [aliceIntent] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), batchPda.toBuffer(), userAlice.publicKey.toBuffer()],
      program.programId
    );

    const preBalanceAliceB = (await getAccount(provider.connection, aliceAccountB)).amount;

    await program.methods
      .claimFill()
      .accounts({
        batch: batchPda,
        userIntent: aliceIntent,
        intentAuthority: userAlice.publicKey,
        userReceiveAccount: aliceAccountB,
        vaultA: vaultA,
        vaultB: vaultB,
        vaultAuthority: vaultAuth,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userAlice])
      .rpc();

    const postBalanceAliceB = (await getAccount(provider.connection, aliceAccountB)).amount;
    // Alice deposited 50 A -> at 2.0 price, receives exactly 100 B
    assert.equal(Number(postBalanceAliceB - preBalanceAliceB), 100_000_000);
  });
});