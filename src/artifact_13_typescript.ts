import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AegisFlow } from "../target/types/aegis_flow";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AegisFlow as Program<AegisFlow>;

  console.log("Connected to cluster:", provider.connection.rpcEndpoint);
  console.log("Program ID:", program.programId.toBase58());
  console.log("Payer address:", provider.publicKey.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});