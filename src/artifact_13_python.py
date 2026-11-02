import time
from solana.rpc.api import Client
from solders.pubkey import Pubkey

SOLANA_RPC = "http://127.0.0.1:8899"
PROGRAM_ID = Pubkey.from_string("ChronoMesh111111111111111111111111111111111")
client = Client(SOLANA_RPC)

def monitor_epochs(epoch_duration_slots=2):
    print(f"[*] ChronoMesh Keeper Active. Monitoring Program: {PROGRAM_ID}")
    last_settled_epoch = 0
    
    while True:
        try:
            slot = client.get_slot().value
            current_epoch = slot // epoch_duration_slots
            
            if current_epoch > last_settled_epoch:
                print(f"[+] Epoch transition detected: {current_epoch}. Preparing batch settlement...")
                # Fetch open Intent PDAs, run crossing match, and fire batch_settle instruction
                last_settled_epoch = current_epoch
                
            time.sleep(0.4) # Poll at sub-slot rate
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"[!] Error: {e}")
            time.sleep(1)

if __name__ == "__main__":
    monitor_epochs()