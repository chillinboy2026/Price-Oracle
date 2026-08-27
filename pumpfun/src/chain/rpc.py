"""A small Solana JSON-RPC client.

Only the seven methods this pipeline actually calls, over the httpx client
already in the process. A full SDK would bring its own HTTP stack, its own
retry policy and its own opinions about timeouts.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)


class RpcError(Exception):
    """A JSON-RPC error, or a response that made no sense."""


class SolanaRpc:
    def __init__(self, url: str, client: httpx.AsyncClient | None = None,
                 timeout: float = 20.0) -> None:
        self.url = url
        self.timeout = timeout
        self._client = client
        self._owns_client = client is None
        self._request_id = 0

    async def __aenter__(self) -> SolanaRpc:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def call(self, method: str, params: list[Any] | None = None) -> Any:
        if self._client is None:
            raise RpcError("rpc used outside its context manager")
        self._request_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": self._request_id,
            "method": method,
            "params": params or [],
        }
        response = await self._client.post(self.url, json=payload, timeout=self.timeout)
        response.raise_for_status()
        body = response.json()
        if "error" in body:
            raise RpcError(f"{method}: {body['error']}")
        if "result" not in body:
            raise RpcError(f"{method}: response had no result")
        return body["result"]

    # -- reads -------------------------------------------------------------

    async def latest_blockhash(self) -> tuple[str, int]:
        """Returns (blockhash, last_valid_block_height)."""
        result = await self.call(
            "getLatestBlockhash", [{"commitment": "confirmed"}]
        )
        value = result.get("value", {})
        blockhash = value.get("blockhash")
        if not blockhash:
            raise RpcError("getLatestBlockhash returned no blockhash")
        return blockhash, int(value.get("lastValidBlockHeight", 0))

    async def account_data(self, address: str) -> bytes | None:
        """Raw account bytes, or None if the account does not exist."""
        result = await self.call(
            "getAccountInfo", [address, {"encoding": "base64", "commitment": "confirmed"}]
        )
        value = result.get("value")
        if not value:
            return None
        data = value.get("data")
        if isinstance(data, list) and data:
            return base64.b64decode(data[0])
        raise RpcError(f"unexpected account data encoding for {address}")

    async def balance_lamports(self, address: str) -> int:
        result = await self.call("getBalance", [address, {"commitment": "confirmed"}])
        return int(result.get("value", 0))

    async def token_balance(self, ata: str) -> int:
        """Base-unit balance of a token account, 0 if it does not exist."""
        try:
            result = await self.call(
                "getTokenAccountBalance", [ata, {"commitment": "confirmed"}]
            )
        except RpcError:
            return 0
        try:
            return int(result["value"]["amount"])
        except (KeyError, TypeError, ValueError):
            return 0

    # -- writes ------------------------------------------------------------

    async def simulate(self, signed_tx_base64: str) -> dict[str, Any]:
        """Dry-run against the current bank. The cheap way to be wrong."""
        result = await self.call("simulateTransaction", [
            signed_tx_base64,
            {"commitment": "confirmed", "encoding": "base64",
             "replaceRecentBlockhash": False, "sigVerify": False},
        ])
        return dict(result.get("value", {}))

    async def send(self, signed_tx_base64: str, skip_preflight: bool = True) -> str:
        """Submit and return the signature.

        ``skip_preflight`` defaults to True because this pipeline simulates
        explicitly beforehand; running preflight again only adds latency in
        a window measured in seconds.
        """
        return str(await self.call("sendTransaction", [
            signed_tx_base64,
            {"encoding": "base64", "skipPreflight": skip_preflight,
             "maxRetries": 0, "preflightCommitment": "confirmed"},
        ]))

    async def signature_status(self, signature: str) -> dict[str, Any] | None:
        result = await self.call("getSignatureStatuses", [[signature],
                                 {"searchTransactionHistory": False}])
        values = result.get("value") or [None]
        return values[0] if isinstance(values[0], dict) else None

    async def confirm(self, signature: str, timeout: float = 45.0,
                      poll_interval: float = 1.0) -> dict[str, Any]:
        """Poll until the signature confirms, fails, or the timeout expires.

        Raises on an on-chain error so a failed transaction can never be
        mistaken for a filled one -- the difference is a position the
        pipeline thinks it holds and does not.
        """
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            status = await self.signature_status(signature)
            if status is not None:
                if status.get("err") is not None:
                    raise RpcError(f"transaction {signature} failed: {status['err']}")
                confirmation = status.get("confirmationStatus")
                if confirmation in ("confirmed", "finalized"):
                    return status
            await asyncio.sleep(poll_interval)
        raise RpcError(
            f"transaction {signature} not confirmed within {timeout:.0f}s; "
            "it may still land -- check the signature before retrying"
        )
