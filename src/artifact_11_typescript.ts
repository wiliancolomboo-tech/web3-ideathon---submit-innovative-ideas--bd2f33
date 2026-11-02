import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AegisFlow } from "../target/types/aegis_flow";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";

describe("AegisFlow Intent Engine End-to-End Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AegisFlow as Program<AegisFlow>;
  
  let mintA: PublicKey;
  let mintB: PublicKey;
  let admin: Keypair;
  let user: Keypair;
  let solver: Keypair;
  let treasury: Keypair;

  let userAtaA: PublicKey;
  let userAtaB: PublicKey;
  let solverAtaA: PublicKey;
  let solverAtaB: PublicKey;
  let treasuryAtaB: PublicKey;

  let configPda: PublicKey;
  const nonce = new BN(1001);

  before(async () => {
    admin = Keypair.generate();
    user = Keypair.generate();
    solver = Keypair.generate();
    treasury = Keypair.generate();

    // Airdrop SOL
    for (const kp of [admin, user, solver, treasury]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Create Mints (Token A = Input, Token B = Output)
    mintA = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    mintB = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Initialize Token Accounts
    userAtaA = await createAccount(provider.connection, user, mintA, user.publicKey);
    userAtaB = await createAccount(provider.connection, user, mintB, user.publicKey);

    solverAtaA = await createAccount(provider.connection, solver, mintA, solver.publicKey);
    solverAtaB = await createAccount(provider.connection, solver, mintB, solver.publicKey);
    treasuryAtaB = await createAccount(provider.connection, admin, mintB, treasury.publicKey);

    // Mint liquidity: User has 1000 Token A, Solver has 2000 Token B
    await mintTo(provider.connection, admin, mintA, userAtaA, admin, 1000_000000);
    await mintTo(provider.connection, admin, mintB, solverAtaB, admin, 2000_000000);

    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  });

  it("1. Initializes the AegisFlow Protocol Configuration", async () => {
    const feeBps = 1500; // 15% MEV capture fee
    await program.methods
      .initializeProtocol(feeBps)
      .accounts({
        admin: admin.publicKey,
        treasury: treasuryAtaB,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.feeBasisPoints).to.equal(feeBps);
  });

  it("2. Opens a Valid Intent with PDA Escrow Lock", async () => {
    const amountIn = new BN(100_000000); // 100 Token A
    const minAmountOut = new BN(95_000000); // 95 Token B
    const currentSlot = await provider.connection.getSlot();
    const deadlineSlot = new BN(currentSlot + 100);

    const [intentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), user.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultAta] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), intentPda.toBuffer()],
      program.programId
    );

    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("authority"), intentPda.toBuffer()],
      program.programId
    );

    await program.methods
      .openIntent(nonce, amountIn, minAmountOut, deadlineSlot)
      .accounts({
        user: user.publicKey,
        inputMint: mintA,
        outputMint: mintB,
        userTokenIn: userAtaA,
        intentOrder: intentPda,
        vaultTokenIn: vaultAta,
        vaultAuthority: vaultAuthority,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

    const vaultBalance = await getAccount(provider.connection, vaultAta);
    expect(Number(vaultBalance.amount)).to.equal(100_000000);
  });

  it("3. Executes Atomic Settlement with Surplus Rebate & Closes State", async () => {
    const [intentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), user.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultAta] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), intentPda.toBuffer()],
      program.programId
    );
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("authority"), intentPda.toBuffer()],
      program.programId
    );

    const userSolBefore = await provider.connection.getBalance(user.publicKey);
    
    // Solver offers 105 Token B (Surplus of 10 Token B over 95 min_amount_out)
    const fillerAmountOut = new BN(105_000000);

    const tx = await program.methods
      .fillIntentAtomic(fillerAmountOut)
      .accounts({
        solver: solver.publicKey,
        user: user.publicKey,
        config: configPda,
        intentOrder: intentPda,
        vaultTokenIn: vaultAta,
        vaultAuthority: vaultAuthority,
        userTokenOut: userAtaB,
        solverTokenIn: solverAtaA,
        solverTokenOut: solverAtaB,
        protocolTreasury: treasuryAtaB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([solver])
      .rpc();

    // Verify User received output tokens: 105 - fee (15% of 10 = 1.5) = 103.5 Token B
    const userBalanceOut = await getAccount(provider.connection, userAtaB);
    expect(Number(userBalanceOut.amount)).to.equal(103_500000);

    // Verify Solver received 100 Token A
    const solverBalanceIn = await getAccount(provider.connection, solverAtaA);
    expect(Number(solverBalanceIn.amount)).to.equal(100_000000);

    // Verify Protocol Treasury received 1.5 Token B
    const treasuryBalance = await getAccount(provider.connection, treasuryAtaB);
    expect(Number(treasuryBalance.amount)).to.equal(1_500000);

    // Verify Account Closure & Rent Reclamation
    const intentInfo = await provider.connection.getAccountInfo(intentPda);
    expect(intentInfo).to.be.null;

    const userSolAfter = await provider.connection.getBalance(user.publicKey);
    expect(userSolAfter).to.be.greaterThan(userSolBefore); // Rent was fully refunded
  });

  it("4. Fails when Solver attempts to breach user minimum slippage bound", async () => {
    const nonceFail = new BN(2002);
    const amountIn = new BN(50_000000);
    const minAmountOut = new BN(50_000000);
    const currentSlot = await provider.connection.getSlot();

    const [intentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent"), user.publicKey.toBuffer(), nonceFail.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultAta] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), intentPda.toBuffer()],
      program.programId
    );
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("authority"), intentPda.toBuffer()],
      program.programId
    );

    await program.methods
      .openIntent(nonceFail, amountIn, minAmountOut, new BN(currentSlot + 50))
      .accounts({
        user: user.publicKey,
        inputMint: mintA,
        outputMint: mintB,
        userTokenIn: userAtaA,
        intentOrder: intentPda,
        vaultTokenIn: vaultAta,
        vaultAuthority: vaultAuthority,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

    // Solver offers 49 Token B (Violates min 50)
    try {
      await program.methods
        .fillIntentAtomic(new BN(49_000000))
        .accounts({
          solver: solver.publicKey,
          user: user.publicKey,
          config: configPda,
          intentOrder: intentPda,
          vaultTokenIn: vaultAta,
          vaultAuthority: vaultAuthority,
          userTokenOut: userAtaB,
          solverTokenIn: solverAtaA,
          solverTokenOut: solverAtaB,
          protocolTreasury: treasuryAtaB,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([solver])
        .rpc();
      expect.fail("Expected transaction to revert with SlippageExceeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }
  });
});