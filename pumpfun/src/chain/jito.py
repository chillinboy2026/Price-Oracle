"""Jito bundle submission.

For a memecoin the entry window is measured in seconds, so where the
transaction lands in the block matters. A Jito tip buys priority placement
via the block engine instead of competing on compute-unit price alone.

This does not make you un-frontrunnable. Searchers with mempool access can
still see and race a transaction; a tip improves inclusion odds, it does
not confer exclusivity.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from solders.pubkey import Pubkey

log = logging.getLogger(__name__)

# Jito's published tip accounts. A tip must go to one of these to be
# recognised; which one does not matter, and spreading across them reduces
# write-lock contention on any single account.
TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]


def tip_account(seed: int) -> Pubkey:
    """Pick a tip account deterministically from a caller-supplied seed.

    Deterministic rather than random so a given trade always produces the
    same transaction bytes -- which keeps a retry idempotent instead of
    creating a second, differently-signed transaction that could also land.
    """
    return Pubkey.from_string(TIP_ACCOUNTS[seed % len(TIP_ACCOUNTS)])


class JitoClient:
    def __init__(self, block_engine_url: str, client: httpx.AsyncClient | None = None,
                 timeout: float = 15.0) -> None:
        self.url = block_engine_url.rstrip("/")
        self.timeout = timeout
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> JitoClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def send_bundle(self, signed_txs_base64: list[str]) -> str:
        """Submit a bundle and return its id.

        A bundle id is not a signature and confirms nothing: it says the
        block engine accepted the bundle, not that it landed. The caller
        still has to confirm the transaction signature on chain.
        """
        if self._client is None:
            raise RuntimeError("jito client used outside its context manager")
        response = await self._client.post(
            f"{self.url}/api/v1/bundles",
            json={"jsonrpc": "2.0", "id": 1, "method": "sendBundle",
                  "params": [signed_txs_base64, {"encoding": "base64"}]},
            timeout=self.timeout,
        )
        response.raise_for_status()
        body = response.json()
        if "error" in body:
            raise RuntimeError(f"jito sendBundle: {body['error']}")
        return str(body.get("result", ""))
