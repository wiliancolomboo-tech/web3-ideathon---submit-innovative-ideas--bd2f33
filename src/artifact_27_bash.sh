npx ts-node -e '
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const idl = JSON.parse(require("fs").readFileSync("./target/idl/chimera.json", "utf8"));
  const programId = new PublicKey("CHMR111111111111111111111111111111111111111");
  const program = new anchor.Program(idl, programId, provider);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);

  const tx = await program.methods
    .initialize(new anchor.BN(10), 300) // 10-slot batch epoch (~4 seconds), 300 bps oracle slippage
    .accounts({
      config: configPda,
      tokenMintA: new PublicKey("So11111111111111111111111111111111111111112"), // Wrapped SOL
      tokenMintB: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC
      authority: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Chimera Auction Protocol Initialized! Tx Signature:", tx);
}
main();
'