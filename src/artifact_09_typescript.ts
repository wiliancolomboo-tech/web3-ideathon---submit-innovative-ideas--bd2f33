import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AegisRing } from "../target/types/aegis_ring";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";

describe("aegis-ring-fba-protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AegisRing as Program<AegisRing>;

  let baseMint: anchor.web3.PublicKey;
  let quoteMint: anchor.web3.PublicKey;
  let pairPoolPda: anchor.web3.PublicKey;
  let baseVaultPda: anchor.web3.PublicKey;
  let quoteVaultPda: anchor.web3.PublicKey;
  let firstBatchPda: anchor.web3.PublicKey;
  let globalConfigPda: anchor.web3.PublicKey;

  const admin = anchor.web3.Keypair.generate();
  const traderBuyer = anchor.web3.Keypair.generate();
  const traderSeller = anchor.web3.Keypair.generate();
  const keeper = anchor.web3.Keypair.generate();

  let buyerQuoteAccount: anchor.web3.PublicKey;
  let buyerBaseAccount: anchor.web3.PublicKey;
  let sellerBaseAccount: anchor.web3.PublicKey;
  let sellerQuoteAccount: anchor.web3.PublicKey;

  const INITIAL_PRICE = new anchor.BN(1_000_000_000); // 1.0 Quote per Base (1e9)
  const SLOT_WINDOW = new anchor.BN(3); // 3 slots per batch for testing

  before(async () => {
    // AirDrop SOL to all participants
    for (const kp of [admin, traderBuyer, traderSeller, keeper]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create Base and Quote Mints (6 decimals each)
    baseMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );
    quoteMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Derive PDA keys
    [globalConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      program.programId
    );

    [pairPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pair_pool"), baseMint.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );

    [baseVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_base"), pairPoolPda.toBuffer()],
      program.programId
    );

    [quoteVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_quote"), pairPoolPda.toBuffer()],
      program.programId
    );

    const epoch1Bytes = new anchor.BN(1).toArrayLike(Buffer, "le", 8);
    [firstBatchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), pairPoolPda.toBuffer(), epoch1Bytes],
      program.programId
    );

    // Create User Associated Token Accounts
    buyerQuoteAccount = await createAccount(
      provider.connection,
      traderBuyer,
      quoteMint,
      traderBuyer.publicKey
    );
    buyerBaseAccount = await createAccount(
      provider.connection,
      traderBuyer,
      baseMint,
      traderBuyer.publicKey
    );
    sellerBaseAccount = await createAccount(
      provider.connection,
      traderSeller,
      baseMint,
      traderSeller.publicKey
    );
    sellerQuoteAccount = await createAccount(
      provider.connection,
      traderSeller,
      quoteMint,
      traderSeller.publicKey
    );

    // Fund Buyer with 100 USDC (Quote) & Seller with 100 Base
    await mintTo(
      provider.connection,
      admin,
      quoteMint,
      buyerQuoteAccount,
      admin,
      100_000_000
    );
    await mintTo(
      provider.connection,
      admin,
      baseMint,
      sellerBaseAccount,
      admin,
      100_000_000
    );
  });

  it("Initializes Global Protocol and Pair with initial Batch", async () => {
    await program.methods
      .initializeProtocol(20) // 20 bps keeper fee
      .accounts({
        config: globalConfigPda,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    await program.methods
      .initializePair(SLOT_WINDOW, INITIAL_PRICE)
      .accounts({
        pairPool: pairPoolPda,
        baseMint: baseMint,
        quoteMint: quoteMint,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        firstBatch: firstBatchPda,
        creator: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const poolData = await program.account.pairPool.fetch(pairPoolPda);
    expect(poolData.currentEpoch.toNumber()).to.equal(1);
    expect(poolData.baseMint.toBase58()).to.equal(baseMint.toBase58());
  });

  it("Deposits simultaneous opposing orders in Epoch #1", async () => {
    // Trader A places Buy Order: offers 50 Quote
    const [receiptA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), firstBatchPda.toBuffer(), traderBuyer.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .depositOrder(true, new anchor.BN(50_000_000), new anchor.BN(1_000_000_000))
      .accounts({
        pairPool: pairPoolPda,
        batchEpoch: firstBatchPda,
        orderReceipt: receiptA,
        user: traderBuyer.publicKey,
        userTokenAccount: buyerQuoteAccount,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([traderBuyer])
      .rpc();

    // Trader B places Sell Order: offers 50 Base
    const [receiptB] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), firstBatchPda.toBuffer(), traderSeller.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .depositOrder(false, new anchor.BN(50_000_000), new anchor.BN(1_000_000_000))
      .accounts({
        pairPool: pairPoolPda,
        batchEpoch: firstBatchPda,
        orderReceipt: receiptB,
        user: traderSeller.publicKey,
        userTokenAccount: sellerBaseAccount,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([traderSeller])
      .rpc();

    const batch = await program.account.batchEpoch.fetch(firstBatchPda);
    expect(batch.totalQuoteBuy.toNumber()).to.equal(50_000_000);
    expect(batch.totalBaseSell.toNumber()).to.equal(50_000_000);
  });

  it("Resolves batch at end of epoch window and computes Uniform Clearing Price", async () => {
    // Advance slots by sending dummy transactions or waiting
    const currentSlot = await provider.connection.getSlot();
    const batch = await program.account.batchEpoch.fetch(firstBatchPda);

    while ((await provider.connection.getSlot()) <= batch.endSlot.toNumber()) {
      await provider.connection.requestAirdrop(
        anchor.web3.Keypair.generate().publicKey,
        1_000_000
      );
    }

    const epoch2Bytes = new anchor.BN(2).toArrayLike(Buffer, "le", 8);
    const [nextBatchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), pairPoolPda.toBuffer(), epoch2Bytes],
      program.programId
    );

    const tx = await program.methods
      .resolveBatch()
      .accounts({
        pairPool: pairPoolPda,
        batchEpoch: firstBatchPda,
        nextBatchEpoch: nextBatchPda,
        keeper: keeper.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([keeper])
      .rpc();

    const resolvedBatch = await program.account.batchEpoch.fetch(firstBatchPda);
    assert.isTrue("settled" in resolvedBatch.status);
    expect(resolvedBatch.clearedBaseVolume.toNumber()).to.equal(50_000_000);
    expect(resolvedBatch.clearedQuoteVolume.toNumber()).to.equal(50_000_000);
    expect(resolvedBatch.clearingPrice.toNumber()).to.equal(1_000_000_000); // 1.0 UCP
  });

  it("Executes deterministic claim_fill for both participants with exact payouts", async () => {
    const [receiptA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), firstBatchPda.toBuffer(), traderBuyer.publicKey.toBuffer()],
      program.programId
    );

    // Trader A claims fill: Should receive 50 Base tokens
    await program.methods
      .claimFill()
      .accounts({
        pairPool: pairPoolPda,
        batchEpoch: firstBatchPda,
        orderReceipt: receiptA,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        userBaseAccount: buyerBaseAccount,
        userQuoteAccount: buyerQuoteAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const buyerBaseBal = await getAccount(provider.connection, buyerBaseAccount);
    expect(Number(buyerBaseBal.amount)).to.equal(50_000_000);

    const [receiptB] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), firstBatchPda.toBuffer(), traderSeller.publicKey.toBuffer()],
      program.programId
    );

    // Trader B claims fill: Should receive 50 Quote tokens
    await program.methods
      .claimFill()
      .accounts({
        pairPool: pairPoolPda,
        batchEpoch: firstBatchPda,
        orderReceipt: receiptB,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        userBaseAccount: sellerBaseAccount,
        userQuoteAccount: sellerQuoteAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const sellerQuoteBal = await getAccount(provider.connection, sellerQuoteAccount);
    expect(Number(sellerQuoteBal.amount)).to.equal(50_000_000);
  });
});