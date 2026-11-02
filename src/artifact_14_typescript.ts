import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Aetheris } from "../target/types/aetheris";
import {
  createMint,
  createAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("Aetheris Protocol Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Aetheris as Program<Aetheris>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let marketConfigPda: PublicKey;
  let marketBump: number;

  const traderAlice = Keypair.generate(); // Base seller
  const traderBob = Keypair.generate();   // Quote buyer

  let aliceBaseAta: PublicKey;
  let aliceQuoteAta: PublicKey;
  let bobBaseAta: PublicKey;
  let bobQuoteAta: PublicKey;

  const PRECISION = new anchor.BN("1000000000000"); // 1e12

  before(async () => {
    // Air-drop SOL to test accounts
    const sigA = await connection.requestAirdrop(traderAlice.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    const sigB = await connection.requestAirdrop(traderBob.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sigA);
    await connection.confirmTransaction(sigB);

    // Create Base and Quote Mints (9 decimals each)
    baseMint = await createMint(connection, admin, admin.publicKey, null, 9);
    quoteMint = await createMint(connection, admin, admin.publicKey, null, 9);

    // Find MarketConfig PDA
    [marketConfigPda, marketBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_config"), baseMint.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );

    // Initialize Trader ATAs
    aliceBaseAta = await createAccount(connection, admin, baseMint, traderAlice.publicKey);
    aliceQuoteAta = await createAccount(connection, admin, quoteMint, traderAlice.publicKey);
    bobBaseAta = await createAccount(connection, admin, baseMint, traderBob.publicKey);
    bobQuoteAta = await createAccount(connection, admin, quoteMint, traderBob.publicKey);

    // Mint tokens: Alice has 100 Base tokens; Bob has 20,000 Quote tokens
    await mintTo(connection, admin, baseMint, aliceBaseAta, admin, 100 * 1e9);
    await mintTo(connection, admin, quoteMint, bobQuoteAta, admin, 20_000 * 1e9);
  });

  it("1. Initializes MarketConfig PDA correctly", async () => {
    const epochDuration = new anchor.BN(4); // 4 slots (~1.6s)
    const feeBps = 10; // 0.10%

    await program.methods
      .initializeMarket(epochDuration, feeBps)
      .accounts({
        admin: admin.publicKey,
        baseMint: baseMint,
        quoteMint: quoteMint,
        marketConfig: marketConfigPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.marketConfig.fetch(marketConfigPda);
    assert.strictEqual(config.admin.toBase58(), admin.publicKey.toBase58());
    assert.strictEqual(config.baseMint.toBase58(), baseMint.toBase58());
    assert.strictEqual(config.quoteMint.toBase58(), quoteMint.toBase58());
    assert.strictEqual(config.currentEpoch.toNumber(), 0);
  });

  it("2. Commits Peer-to-Peer Orders (Alice sells Base, Bob buys Base with Quote)", async () => {
    const epochIndex = 0;
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64LE(BigInt(epochIndex));

    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch_state"), marketConfigPda.toBuffer(), epochBytes],
      program.programId
    );
    const [vaultBasePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_base"), batchPda.toBuffer()],
      program.programId
    );
    const [vaultQuotePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_quote"), batchPda.toBuffer()],
      program.programId
    );

    // Alice sells 10 Base tokens with Limit Price = 150 Quote/Base
    const [receiptAlice] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_receipt"), batchPda.toBuffer(), traderAlice.publicKey.toBuffer()],
      program.programId
    );

    const aliceLimit = PRECISION.mul(new anchor.BN(150));
    const aliceSellAmount = new anchor.BN(10 * 1e9);

    await program.methods
      .commitOrder({ sell: {} }, aliceLimit, aliceSellAmount)
      .accounts({
        trader: traderAlice.publicKey,
        marketConfig: marketConfigPda,
        batchState: batchPda,
        orderReceipt: receiptAlice,
        baseMint: baseMint,
        quoteMint: quoteMint,
        traderTokenAccount: aliceBaseAta,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([traderAlice])
      .rpc();

    // Bob buys with 1,500 Quote tokens with Limit Price = 160 Quote/Base
    const [receiptBob] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_receipt"), batchPda.toBuffer(), traderBob.publicKey.toBuffer()],
      program.programId
    );

    const bobLimit = PRECISION.mul(new anchor.BN(160));
    const bobDepositQuote = new anchor.BN(1500 * 1e9);

    await program.methods
      .commitOrder({ buy: {} }, bobLimit, bobDepositQuote)
      .accounts({
        trader: traderBob.publicKey,
        marketConfig: marketConfigPda,
        batchState: batchPda,
        orderReceipt: receiptBob,
        baseMint: baseMint,
        quoteMint: quoteMint,
        traderTokenAccount: bobQuoteAta,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([traderBob])
      .rpc();

    const batch = await program.account.batchState.fetch(batchPda);
    assert.strictEqual(batch.totalBaseSupply.toString(), aliceSellAmount.toString());
    assert.strictEqual(batch.totalQuoteDemand.toString(), bobDepositQuote.toString());
  });

  it("3. Executes Uniform Clearing Price and CoW Clearing", async () => {
    const epochIndex = 0;
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64LE(BigInt(epochIndex));

    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch_state"), marketConfigPda.toBuffer(), epochBytes],
      program.programId
    );
    const [vaultBasePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_base"), batchPda.toBuffer()],
      program.programId
    );
    const [vaultQuotePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_quote"), batchPda.toBuffer()],
      program.programId
    );

    // Trigger solve_and_route
    // Total Quote = 1500, Total Base = 10 -> UCP = 150 Quote/Base
    const referencePrice = PRECISION.mul(new anchor.BN(150));
    await program.methods
      .solveAndRoute(referencePrice)
      .accounts({
        keeper: admin.publicKey,
        marketConfig: marketConfigPda,
        batchState: batchPda,
        baseMint: baseMint,
        quoteMint: quoteMint,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const batch = await program.account.batchState.fetch(batchPda);
    assert.isTrue(batch.isSettled);
    const expectedPrice = PRECISION.mul(new anchor.BN(150));
    assert.strictEqual(batch.clearingPriceScaled.toString(), expectedPrice.toString());
    assert.strictEqual(batch.matchedCowBaseVolume.toNumber(), 10 * 1e9);
  });

  it("4. Claims Settlement: Alice receives exact Quote, Bob receives exact Base with Zero Slippage", async () => {
    const epochIndex = 0;
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64LE(BigInt(epochIndex));

    const [batchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("batch_state"), marketConfigPda.toBuffer(), epochBytes],
      program.programId
    );
    const [vaultBasePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_base"), batchPda.toBuffer()],
      program.programId
    );
    const [vaultQuotePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_quote"), batchPda.toBuffer()],
      program.programId
    );

    const [receiptAlice] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_receipt"), batchPda.toBuffer(), traderAlice.publicKey.toBuffer()],
      program.programId
    );
    const [receiptBob] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_receipt"), batchPda.toBuffer(), traderBob.publicKey.toBuffer()],
      program.programId
    );

    // Alice claims Quote output
    await program.methods
      .claimSettlement()
      .accounts({
        trader: traderAlice.publicKey,
        marketConfig: marketConfigPda,
        batchState: batchPda,
        orderReceipt: receiptAlice,
        baseMint: baseMint,
        quoteMint: quoteMint,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        traderBaseAccount: aliceBaseAta,
        traderQuoteAccount: aliceQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([traderAlice])
      .rpc();

    // Bob claims Base output
    await program.methods
      .claimSettlement()
      .accounts({
        trader: traderBob.publicKey,
        marketConfig: marketConfigPda,
        batchState: batchPda,
        orderReceipt: receiptBob,
        baseMint: baseMint,
        quoteMint: quoteMint,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        traderBaseAccount: bobBaseAta,
        traderQuoteAccount: bobQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([traderBob])
      .rpc();

    const aliceQuoteBalance = (await connection.getTokenAccountBalance(aliceQuoteAta)).value.uiAmount;
    const bobBaseBalance = (await connection.getTokenAccountBalance(bobBaseAta)).value.uiAmount;

    // Alice received 1500 Quote tokens for her 10 Base tokens
    assert.strictEqual(aliceQuoteBalance, 1500);
    // Bob received 10 Base tokens for his 1500 Quote tokens
    assert.strictEqual(bobBaseBalance, 10);
  });
});