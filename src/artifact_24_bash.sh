ts-node -e '
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const idl = JSON.parse(require("fs").readFileSync("./target/idl/khora.json", "utf8"));
  const programId = new PublicKey("KHORAGz1Z8oV4iW3x8H9Yy3nQ5V5PskbE9B5yS6hJ4q");
  const program = new anchor.Program(idl, programId, provider);
  
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  console.log("Config PDA Address:", configPda.toBase58());
}
main();
'