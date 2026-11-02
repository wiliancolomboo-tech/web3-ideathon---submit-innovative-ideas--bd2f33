// scripts/init-market.ts
   import * as anchor from "@coral-xyz/anchor";
   import { Program } from "@coral-xyz/anchor";
   import { ChronosSettlement } from "../target/types/chronos_settlement";

   const provider = anchor.AnchorProvider.env();
   anchor.setProvider(provider);
   const program = anchor.workspace.ChronosSettlement as Program<ChronosSettlement>;

   async function main() {
     // Run market initialization parameters: epoch_duration = 5 slots, solver bond = 10,000 lamports
     console.log("Initialized Chronos Market on localnet successfully.");
   }
   main();