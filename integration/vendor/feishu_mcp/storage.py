from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken


class TokenStore:
    def __init__(self, db_path: Path, encryption_key: str) -> None:
        if not encryption_key:
            raise RuntimeError("FEISHU_TOKEN_ENCRYPTION_KEY is not configured")
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.cipher = Fernet(encryption_key.encode("ascii"))
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS oauth_tokens (
                    subject TEXT PRIMARY KEY,
                    encrypted_payload BLOB NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.commit()

    def save(self, token_payload: dict[str, Any], subject: str = "current_user") -> None:
        plaintext = json.dumps(token_payload, ensure_ascii=False).encode("utf-8")
        encrypted = self.cipher.encrypt(plaintext)
        updated_at = datetime.now(timezone.utc).isoformat()
        with closing(self._connect()) as connection:
            connection.execute(
                """
                INSERT INTO oauth_tokens(subject, encrypted_payload, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(subject) DO UPDATE SET
                    encrypted_payload=excluded.encrypted_payload,
                    updated_at=excluded.updated_at
                """,
                (subject, encrypted, updated_at),
            )
            connection.commit()

    def load(self, subject: str = "current_user") -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT encrypted_payload FROM oauth_tokens WHERE subject = ?", (subject,)
            ).fetchone()
        if row is None:
            return None
        try:
            return json.loads(self.cipher.decrypt(row[0]).decode("utf-8"))
        except (InvalidToken, json.JSONDecodeError) as exc:
            raise RuntimeError("Stored OAuth token cannot be decrypted") from exc
