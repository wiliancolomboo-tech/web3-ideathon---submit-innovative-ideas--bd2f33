import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AetherisCore } from "../target/types/aetheris_core";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("Aetheris Protocol - Complete Verification Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AetherisCore as Program<AetherisCore>;
  const admin = anchor.web3.Keypair.generate();
  const solver = anchor.web3.Keypair.generate();
  const traderAlice = anchor.web3.Keypair.generate(); // Buy SOL with USDC
  const traderBob = anchor.web3.Keypair.generate();   // Sell SOL for USDC

  let baseMint: anchor.web3.Pubkey;  // SOL equivalent (9 decimals)
  let quoteMint: anchor.web3.Pubkey; // USDC equivalent (6 decimals)
  let marketPda: anchor.web3.Pubkey;
  let baseVaultPda: anchor.web3.Pubkey;
  let quoteVaultPda: anchor.web3.Pubkey;
  const marketIndex = new anchor.BN(42);

  let aliceQuoteAccount: anchor.web3.Pubkey;
  let aliceBaseAccount: anchor.web3.Pubkey;
  let bobBaseAccount: anchor.web3.Pubkey;
  let bobQuoteAccount: anchor.web3.Pubkey;

  before(async () => {
    // Fund test keypairs
    for (const kp of [admin, solver, traderAlice, traderBob]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Deploy Mints
    baseMint = await createMint(provider.connection, admin, admin.publicKey, null, 9);
    quoteMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Derive PDAs
    [marketPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("market"), marketIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [baseVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("vault_base"), marketPda.toBuffer()],
      program.programId
    );

    [quoteVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("vault_quote"), marketPda.toBuffer()],
      program.programId
    );

    // Setup Token Accounts
    aliceQuoteAccount = await createAccount(provider.connection, traderAlice, quoteMint, traderAlice.publicKey);
    aliceBaseAccount = await createAccount(provider.connection, traderAlice, baseMint, traderAlice.publicKey);

    bobBaseAccount = await createAccount(provider.connection, traderBob, baseMint, traderBob.publicKey);
    bobQuoteAccount = await createAccount(provider.connection, traderBob, quoteMint, traderBob.publicKey);

    // Mint starting capital:
    // Alice: 150 USDC (150 * 1e6 = 150_000_000)
    await mintTo(provider.connection, admin, quoteMint, aliceQuoteAccount, admin, 150_000_000);
    // Bob: 1 SOL (1 * 1e9 = 1_000_000_000)
    await mintTo(provider.connection, admin, baseMint, bobBaseAccount, admin, 1_000_000_000);
  });

  it("1. Initializes Market with deterministic Token PDAs", async () => {
    const minQuoteSize = new anchor.BN(10_000_000); // 10 USDC

    await program.methods
      .initializeMarket(marketIndex, 9, 6, minQuoteSize)
      .accounts({
        admin: admin.publicKey,
        market: marketPda,
        baseMint: baseMint,
        quoteMint: quoteMint,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const marketState = await program.account.marketConfig.fetch(marketPda);
    expect(marketState.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(marketState.marketIndex.toNumber()).to.equal(42);
  });

  it("2. Ingests Buy and Sell Orders into the SlotBatchBuffer", async () => {
    const slot = await provider.connection.getSlot();
    const slotBuffer = Buffer.alloc(8);
    slotBuffer.writeBigUInt64LE(BigInt(slot));

    const [batchPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("batch"), marketPda.toBuffer(), slotBuffer],
      program.programId
    );

    // Alice places BUY order: Ingest 150 USDC to buy SOL at limit price 150 USDC/SOL
    // Price = 150 * 1e9 = 150_000_000_000
    const limitPrice = new anchor.BN("150000000000");
    const expirySlot = new anchor.BN(slot + 100);

    await program.methods
      .depositOrder(0, new anchor.BN(150_000_000), limitPrice, expirySlot)
      .accounts({
        user: traderAlice.publicKey,
        market: marketPda,
        batchBuffer: batchPda,
        userTokenSource: aliceQuoteAccount,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([traderAlice])
      .rpc();

    // Bob places SELL order: Ingest 1 SOL to sell for minimum 145 USDC/SOL
    const bobLimitPrice = new anchor.BN("145000000000");
    await program.methods
      .depositOrder(1, new anchor.BN(1_000_000_000), bobLimitPrice, expirySlot)
      .accounts({
        user: traderBob.publicKey,
        market: marketPda,
        batchBuffer: batchPda,
        userTokenSource: bobBaseAccount,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([traderBob])
      .rpc();

    const batchAccount = await program.account.slotBatchBuffer.fetch(batchPda);
    expect(batchAccount.orderCount).to.equal(2);
    expect(batchAccount.orders[0].user.toBase58()).to.equal(traderAlice.publicKey.toBase58());
    expect(batchAccount.orders[1].user.toBase58()).to.equal(traderBob.publicKey.toBase58());
  });

  it("3. Executes Atomic Batch Clearing at Uniform Clearing Price (150 USDC/SOL)", async () => {
    // Advance block to exceed deposited slot
    await new Promise((res) => setTimeout(res, 1200));

    const currentSlot = await provider.connection.getSlot();
    const batchSlot = currentSlot - 1; // Prior slot
    const slotBuffer = Buffer.alloc(8);
    slotBuffer.writeBigUInt64LE(BigInt(batchSlot));

    // Try finding the registered batch PDA
    const [batchPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("batch"), marketPda.toBuffer(), slotBuffer],
      program.programId
    );

    // Cleared at Uniform Price: 150 USDC per 1 SOL (150 * 1e9)
    const clearingPrice = new anchor.BN("150000000000");
    const matchedBaseVolume = new anchor.BN(1_000_000_000); // 1 SOL

    // Solver settles the batch providing Alice's and Bob's receiving token accounts
    await program.methods
      .settleBatch(new anchor.BN(batchSlot), clearingPrice, matchedBaseVolume)
      .accounts({
        solver: solver.publicKey,
        market: marketPda,
        batchBuffer: batchPda,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: aliceBaseAccount, isWritable: true, isSigner: false },
        { pubkey: bobQuoteAccount, isWritable: true, isSigner: false },
      ])
      .signers([solver])
      .rpc();

    // Verify Balances Post-Settlement:
    // Alice escrowed 150 USDC -> must now own 1 SOL (1_000_000_000 atomic units)
    const aliceBase = await getAccount(provider.connection, aliceBaseAccount);
    expect(Number(aliceBase.amount)).to.equal(1_000_000_000);

    // Bob escrowed 1 SOL -> must now own 150 USDC (150_000_000 atomic units)
    const bobQuote = await getAccount(provider.connection, bobQuoteAccount);
    expect(Number(bobQuote.amount)).to.equal(150_000_000);
  });
});