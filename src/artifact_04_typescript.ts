import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Aetheris } from "../target/types/aetheris";
import {
  createMint,
  createAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("Aetheris: Frequent Batch Auction Core Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Aetheris as Program<Aetheris>;

  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let poolPda: PublicKey;
  let vaultBasePda: PublicKey;
  let vaultQuotePda: PublicKey;
  let epochPda: PublicKey;

  const authority = provider.wallet as anchor.Wallet;
  const buyer = Keypair.generate();
  const seller = Keypair.generate();
  const keeper = Keypair.generate();

  let buyerQuoteAccount: PublicKey;
  let sellerBaseAccount: PublicKey;
  let buyerBaseAccount: PublicKey;
  let sellerQuoteAccount: PublicKey;

  const buySalt = crypto.randomBytes(16);
  const sellSalt = crypto.randomBytes(16);

  const buyPrice = new anchor.BN(100_000_000); // 100.0 Quote per Base (scaled 1e6)
  const buyAmount = new anchor.BN(100_000_000); // 100 Quote
  const sellPrice = new anchor.BN(95_000_000);  // 95.0 Quote per Base
  const sellAmount = new anchor.BN(1_000_000);  // 1 Base

  function computeCommitHash(
    user: PublicKey,
    side: number,
    price: anchor.BN,
    amount: anchor.BN,
    salt: Buffer
  ): Buffer {
    const priceBuf = price.toArrayLike(Buffer, "le", 8);
    const amountBuf = amount.toArrayLike(Buffer, "le", 8);
    const payload = Buffer.concat([
      user.toBuffer(),
      Buffer.from([side]),
      priceBuf,
      amountBuf,
      salt,
    ]);
    return crypto.createHash("sha256").update(payload).digest();
  }

  before(async () => {
    // Fund test wallets
    for (const kp of [buyer, seller, keeper]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create Base and Quote Mints
    baseMint = await createMint(provider.connection, authority.payer, authority.publicKey, null, 6);
    quoteMint = await createMint(provider.connection, authority.payer, authority.publicKey, null, 6);

    // Derive PDAs
    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), baseMint.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );
    [epochPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("epoch"), poolPda.toBuffer(), new anchor.BN(1).toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [vaultBasePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_base"), poolPda.toBuffer()],
      program.programId
    );
    [vaultQuotePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_quote"), poolPda.toBuffer()],
      program.programId
    );

    // Setup Token Accounts
    buyerQuoteAccount = await createAccount(provider.connection, buyer, quoteMint, buyer.publicKey);
    buyerBaseAccount = await createAccount(provider.connection, buyer, baseMint, buyer.publicKey);
    sellerBaseAccount = await createAccount(provider.connection, seller, baseMint, seller.publicKey);
    sellerQuoteAccount = await createAccount(provider.connection, seller, quoteMint, seller.publicKey);

    // Mint token balances
    await mintTo(provider.connection, authority.payer, quoteMint, buyerQuoteAccount, authority.payer, 500_000_000);
    await mintTo(provider.connection, authority.payer, baseMint, sellerBaseAccount, authority.payer, 10_000_000);
  });

  it("1. Initializes Auction Pool and Epoch #1 successfully", async () => {
    const minDeposit = new anchor.BN(1_000);

    await program.methods
      .initializePool(minDeposit)
      .accounts({
        authority: authority.publicKey,
        baseMint,
        quoteMint,
        pool: poolPda,
        epochState: epochPda,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const poolAccount = await program.account.auctionPool.fetch(poolPda);
    expect(poolAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(poolAccount.currentEpoch.toNumber()).to.equal(1);
  });

  it("2. Commits hashed orders for Buyer and Seller within Commit Window", async () => {
    const buyerHash = computeCommitHash(buyer.publicKey, 0, buyPrice, buyAmount, buySalt);
    const sellerHash = computeCommitHash(seller.publicKey, 1, sellPrice, sellAmount, sellSalt);

    const [buyerCommitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commit"), epochPda.toBuffer(), buyer.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitOrder(Array.from(buyerHash), buyAmount)
      .accounts({
        user: buyer.publicKey,
        pool: poolPda,
        epochState: epochPda,
        commitmentRecord: buyerCommitPda,
        userTokenAccount: buyerQuoteAccount,
        depositMint: quoteMint,
        poolVault: vaultQuotePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const [sellerCommitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commit"), epochPda.toBuffer(), seller.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitOrder(Array.from(sellerHash), sellAmount)
      .accounts({
        user: seller.publicKey,
        pool: poolPda,
        epochState: epochPda,
        commitmentRecord: sellerCommitPda,
        userTokenAccount: sellerBaseAccount,
        depositMint: baseMint,
        poolVault: vaultBasePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    const buyerCommit = await program.account.orderCommitment.fetch(buyerCommitPda);
    expect(buyerCommit.escrowAmount.toNumber()).to.equal(buyAmount.toNumber());
    expect(buyerCommit.isRevealed).to.be.false;
  });

  it("3. Fast-forwards past commit_end_slot and reveals both orders", async () => {
    // Wait / Mine slots until commit_end_slot reached (Local validator slot forward)
    let currentSlot = await provider.connection.getSlot();
    const epochState = await program.account.epochState.fetch(epochPda);
    const targetSlot = epochState.commitEndSlot.toNumber();

    while (currentSlot <= targetSlot) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      currentSlot = await provider.connection.getSlot();
    }

    const [buyerCommitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commit"), epochPda.toBuffer(), buyer.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .revealOrder(0, buyPrice, buyAmount, Array.from(buySalt))
      .accounts({
        user: buyer.publicKey,
        epochState: epochPda,
        commitmentRecord: buyerCommitPda,
      })
      .signers([buyer])
      .rpc();

    const [sellerCommitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commit"), epochPda.toBuffer(), seller.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .revealOrder(1, sellPrice, sellAmount, Array.from(sellSalt))
      .accounts({
        user: seller.publicKey,
        epochState: epochPda,
        commitmentRecord: sellerCommitPda,
      })
      .signers([seller])
      .rpc();

    const updatedEpoch = await program.account.epochState.fetch(epochPda);
    expect(updatedEpoch.revealedOrderCount).to.equal(2);
  });

  it("4. Settle Batch Auction calculates uniform clearing price without slippage", async () => {
    // Wait until reveal window expires
    let currentSlot = await provider.connection.getSlot();
    const epochState = await program.account.epochState.fetch(epochPda);
    const targetSlot = epochState.revealEndSlot.toNumber();

    while (currentSlot <= targetSlot) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      currentSlot = await provider.connection.getSlot();
    }

    const tx = await program.methods
      .settleBatchAuction()
      .accounts({
        crankKeeper: keeper.publicKey,
        pool: poolPda,
        epochState: epochPda,
      })
      .signers([keeper])
      .rpc();

    const settledEpoch = await program.account.epochState.fetch(epochPda);
    expect(settledEpoch.isSettled).to.be.true;
    expect(settledEpoch.clearingPrice.toNumber()).to.be.greaterThan(0);
    expect(settledEpoch.matchedVolume.toNumber()).to.be.greaterThan(0);
  });

  it("5. Allows Buyer and Seller to claim proceeds atomically", async () => {
    // Buyer claims filled order (index 0)
    await program.methods
      .claimProceeds(0)
      .accounts({
        user: buyer.publicKey,
        pool: poolPda,
        epochState: epochPda,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        userBaseAccount: buyerBaseAccount,
        userQuoteAccount: buyerQuoteAccount,
        baseMint,
        quoteMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    // Seller claims filled order (index 1)
    await program.methods
      .claimProceeds(1)
      .accounts({
        user: seller.publicKey,
        pool: poolPda,
        epochState: epochPda,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        userBaseAccount: sellerBaseAccount,
        userQuoteAccount: sellerQuoteAccount,
        baseMint,
        quoteMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    const buyerBaseBalance = await provider.connection.getTokenAccountBalance(buyerBaseAccount);
    const sellerQuoteBalance = await provider.connection.getTokenAccountBalance(sellerQuoteAccount);

    expect(Number(buyerBaseBalance.value.amount)).to.be.greaterThan(0);
    expect(Number(sellerQuoteBalance.value.amount)).to.be.greaterThan(0);
  });
});