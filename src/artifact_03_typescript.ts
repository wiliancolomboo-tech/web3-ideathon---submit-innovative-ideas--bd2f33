import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Chronobatch } from "../target/types/chronobatch";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("ChronoBatch Protocol Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Chronobatch as Program<Chronobatch>;
  const connection = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;

  let mintA: anchor.web3.PublicKey;
  let mintB: anchor.web3.PublicKey;
  let poolPda: anchor.web3.PublicKey;
  let vaultAPda: anchor.web3.PublicKey;
  let vaultBPda: anchor.web3.PublicKey;

  const user1 = anchor.web3.Keypair.generate();
  const user2 = anchor.web3.Keypair.generate();

  let user1AtaA: anchor.web3.PublicKey;
  let user1AtaB: anchor.web3.PublicKey;
  let user2AtaA: anchor.web3.PublicKey;
  let user2AtaB: anchor.web3.PublicKey;

  const RAY = new BN("1000000000000000000"); // 10^18
  const epochDurationSlots = new BN(4);

  before(async () => {
    // Fund test wallets
    const airdrop1 = await connection.requestAirdrop(user1.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    const airdrop2 = await connection.requestAirdrop(user2.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdrop1);
    await connection.confirmTransaction(airdrop2);

    // Create Token Mints
    mintA = await createMint(connection, authority, authority.publicKey, null, 6);
    mintB = await createMint(connection, authority, authority.publicKey, null, 6);

    // Derive Pool PDAs
    [poolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
      program.programId
    );
    [vaultAPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_a"), poolPda.toBuffer()],
      program.programId
    );
    [vaultBPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_b"), poolPda.toBuffer()],
      program.programId
    );

    // Create User Token Accounts
    user1AtaA = await createAccount(connection, user1, mintA, user1.publicKey);
    user1AtaB = await createAccount(connection, user1, mintB, user1.publicKey);
    user2AtaA = await createAccount(connection, user2, mintA, user2.publicKey);
    user2AtaB = await createAccount(connection, user2, mintB, user2.publicKey);

    // Seed User Balances:
    // User1 gets 100 Token A
    await mintTo(connection, authority, mintA, user1AtaA, authority, 100_000_000);
    // User2 gets 200 Token B
    await mintTo(connection, authority, mintB, user2AtaB, authority, 200_000_000);
  });

  it("Initializes ChronoBatch Pool", async () => {
    await program.methods
      .initializePool(epochDurationSlots, 30) // 30 bps fee (0.3%)
      .accounts({
        pool: poolPda,
        mintA,
        mintB,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const poolState = await program.account.poolState.fetch(poolPda);
    expect(poolState.currentEpochId.toNumber()).to.equal(0);
    expect(poolState.feeBasisPoints).to.equal(30);
  });

  it("Opens Epoch #1", async () => {
    const epochId = new BN(1);
    const [epochStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("epoch"), poolPda.toBuffer(), epochId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .openEpoch(epochId)
      .accounts({
        pool: poolPda,
        epochState: epochStatePda,
        signer: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const epochState = await program.account.epochBatchState.fetch(epochStatePda);
    expect(epochState.epochId.toNumber()).to.equal(1);
    expect(epochState.isCleared).to.be.false;
  });

  it("Commits opposing swap intents (Coincidence of Wants)", async () => {
    const epochId = new BN(1);
    const [epochStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("epoch"), poolPda.toBuffer(), epochId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Trader 1 commits 100 Token A (Sells A for B, min 190 B)
    const [intent1Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), epochId.toArrayLike(Buffer, "le", 8), user1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitSwapIntent(epochId, true, new BN(100_000_000), new BN(190_000_000))
      .accounts({
        pool: poolPda,
        epochState: epochStatePda,
        orderIntent: intent1Pda,
        user: user1.publicKey,
        userTokenSource: user1AtaA,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        mintA,
        mintB,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user1])
      .rpc();

    // Trader 2 commits 200 Token B (Sells B for A, min 95 A)
    const [intent2Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), epochId.toArrayLike(Buffer, "le", 8), user2.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitSwapIntent(epochId, false, new BN(200_000_000), new BN(95_000_000))
      .accounts({
        pool: poolPda,
        epochState: epochStatePda,
        orderIntent: intent2Pda,
        user: user2.publicKey,
        userTokenSource: user2AtaB,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        mintA,
        mintB,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user2])
      .rpc();

    const epochState = await program.account.epochBatchState.fetch(epochStatePda);
    expect(epochState.totalADeposited.toNumber()).to.equal(100_000_000);
    expect(epochState.totalBDeposited.toNumber()).to.equal(200_000_000);
  });

  it("Executes batch settlement at uniform market clearing price", async () => {
    const epochId = new BN(1);
    const [epochStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("epoch"), poolPda.toBuffer(), epochId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Advance slots past epoch duration
    for (let i = 0; i < 5; i++) {
      await connection.requestAirdrop(user1.publicKey, 1000);
    }

    // Clearing price: 2.0 B per 1 A -> 2.0 * RAY = 2 * 10^18
    const clearingPriceRay = RAY.mul(new BN(2));

    await program.methods
      .executeBatchSettlement(clearingPriceRay)
      .accounts({
        pool: poolPda,
        epochState: epochStatePda,
        solverCrank: authority.publicKey,
      })
      .rpc();

    const epochState = await program.account.epochBatchState.fetch(epochStatePda);
    expect(epochState.isCleared).to.be.true;
    expect(epochState.clearingPriceRay.toString()).to.equal(clearingPriceRay.toString());
  });

  it("Claims tokens for both traders at zero slippage", async () => {
    const epochId = new BN(1);
    const [epochStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("epoch"), poolPda.toBuffer(), epochId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [intent1Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), epochId.toArrayLike(Buffer, "le", 8), user1.publicKey.toBuffer()],
      program.programId
    );
    const [intent2Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), epochId.toArrayLike(Buffer, "le", 8), user2.publicKey.toBuffer()],
      program.programId
    );

    // User 1 claims Token B
    await program.methods
      .claimClearedSwap()
      .accounts({
        pool: poolPda,
        epochState: epochStatePda,
        orderIntent: intent1Pda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        mintA,
        mintB,
        userDestination: user1AtaB,
        user: user1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user1])
      .rpc();

    // User 2 claims Token A
    await program.methods
      .claimClearedSwap()
      .accounts({
        pool: poolPda,
        epochState: epochStatePda,
        orderIntent: intent2Pda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        mintA,
        mintB,
        userDestination: user2AtaA,
        user: user2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user2])
      .rpc();

    const u1BAccount = await getAccount(connection, user1AtaB);
    const u2AAccount = await getAccount(connection, user2AtaA);

    // User 1 expected: 100 * 2.0 = 200 Token B minus 0.3% fee = 199.4 Token B (199_400_000)
    expect(Number(u1BAccount.amount)).to.equal(199_400_000);

    // User 2 expected: 200 / 2.0 = 100 Token A minus 0.3% fee = 99.7 Token A (99_700_000)
    expect(Number(u2AAccount.amount)).to.equal(99_700_000);
  });
});