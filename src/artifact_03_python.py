"""
Off-chain Clearing Solver for Nexus-Batch.
Calculates Uniform Clearing Price (UCP) P* that balances discrete buy and sell curves.
"""
from dataclasses import dataclass
from typing import List, Tuple

SCALE = 1_000_000_000

@dataclass
class IntentOrder:
    order_id: str
    is_buy: bool
    amount: int       # Quote token (USDC) if buy, Base token (SOL) if sell
    limit_price: int  # Scaled by 1e9

def compute_uniform_clearing_price(orders: List[IntentOrder]) -> Tuple[int, int]:
    """
    Computes clearing price P* where Base Demanded == Base Supplied.
    Base Demanded(P) = sum_{buys where P_limit >= P} (amount_quote * SCALE) / P
    Base Supplied(P) = sum_{sells where P_limit <= P} amount_base
    """
    candidate_prices = sorted(list(set(order.limit_price for order in orders)))
    if not candidate_prices:
        return 0, 0

    best_p_star = candidate_prices[0]
    max_matched_volume = 0
    min_imbalance = float("inf")

    for p in candidate_prices:
        demanded_base = 0
        supplied_base = 0

        for order in orders:
            if order.is_buy and order.limit_price >= p:
                demanded_base += (order.amount * SCALE) // p
            elif not order.is_buy and order.limit_price <= p:
                supplied_base += order.amount

        matched = min(demanded_base, supplied_base)
        imbalance = abs(demanded_base - supplied_base)

        if matched > max_matched_volume or (matched == max_matched_volume and imbalance < min_imbalance):
            max_matched_volume = matched
            min_imbalance = imbalance
            best_p_star = p

    return best_p_star, max_matched_volume

if __name__ == "__main__":
    test_orders = [
        IntentOrder(order_id="b1", is_buy=True, amount=200_000_000, limit_price=150 * SCALE),
        IntentOrder(order_id="b2", is_buy=True, amount=150_000_000, limit_price=145 * SCALE),
        IntentOrder(order_id="s1", is_buy=False, amount=1_500_000_000, limit_price=140 * SCALE),
        IntentOrder(order_id="s2", is_buy=False, amount=1_000_000_000, limit_price=148 * SCALE),
    ]
    p_star, matched = compute_uniform_clearing_price(test_orders)
    print(f"Optimal UCP: {p_star / SCALE:.4f} USDC/SOL | Matched Volume: {matched} units")