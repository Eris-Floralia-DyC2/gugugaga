from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = PROJECT_ROOT / ".env"


@dataclass(frozen=True)
class Settings:
    app_id: str
    app_secret: str
    redirect_uri: str
    token_encryption_key: str
    token_db: Path
    base_url: str
    accounts_url: str
    oauth_scopes: str
    download_dir: Path
    max_download_bytes: int
    max_external_bytes: int

    @property
    def is_configured(self) -> bool:
        return bool(self.app_id and self.app_secret and self.token_encryption_key)


def get_settings() -> Settings:
    load_dotenv(ENV_PATH, override=True)
    token_db = Path(os.getenv("FEISHU_TOKEN_DB", "data/feishu_tokens.sqlite3"))
    if not token_db.is_absolute():
        token_db = PROJECT_ROOT / token_db
    download_dir = Path(os.getenv("FEISHU_DOWNLOAD_DIR", "data/downloads"))
    if not download_dir.is_absolute():
        download_dir = PROJECT_ROOT / download_dir
    return Settings(
        app_id=os.getenv("FEISHU_APP_ID", "").strip(),
        app_secret=os.getenv("FEISHU_APP_SECRET", "").strip(),
        redirect_uri=os.getenv(
            "FEISHU_REDIRECT_URI", "http://127.0.0.1:8001/oauth/callback"
        ).strip(),
        token_encryption_key=os.getenv("FEISHU_TOKEN_ENCRYPTION_KEY", "").strip(),
        token_db=token_db,
        base_url=os.getenv("FEISHU_BASE_URL", "https://open.feishu.cn").rstrip("/"),
        accounts_url=os.getenv(
            "FEISHU_ACCOUNTS_URL", "https://accounts.feishu.cn"
        ).rstrip("/"),
        oauth_scopes=os.getenv(
            "FEISHU_OAUTH_SCOPES",
            "docx:document:readonly wiki:wiki:readonly sheets:spreadsheet:read "
            "drive:file:readonly drive:drive:readonly search:docs:read "
            "im:chat:readonly im:message:readonly bitable:app:readonly offline_access",
        ).strip(),
        download_dir=download_dir,
        max_download_bytes=max(
            1, int(os.getenv("FEISHU_MAX_DOWNLOAD_BYTES", str(50 * 1024 * 1024)))
        ),
        max_external_bytes=max(
            1, int(os.getenv("FEISHU_MAX_EXTERNAL_BYTES", str(5 * 1024 * 1024)))
        ),
    )
